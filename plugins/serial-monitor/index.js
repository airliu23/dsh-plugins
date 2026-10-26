/**
 * Host half of the serial-monitor bundle.
 *
 * One capture per (port, baud) pair, any number of them at once, and **no
 * probing**: the Session declares exactly which ports and baud rates to echo
 * (`serial_monitor { action: "watch", streams: [...] }` or the panel's add row),
 * and this half is the only owner of those COM handles.
 */
import { spawn } from 'node:child_process'
import { readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SIDECAR = join(HERE, 'serial_sidecar.py')
const ROUTE_BASE = '/plugins/serial-monitor'
const PORT_PATTERN = /^[A-Za-z0-9_\-.]{1,64}$/
const BLUETOOTH_HWID = /BTHENUM/i
/** One live instance per Host process; hot reload supersedes its predecessor. */
const INSTANCE = Symbol.for('dsh.serial-monitor.instance')
/** A line that opened and then dropped is retried quickly; a held port slowly. */
const RETRY_DELAYS = [3_000, 6_000, 12_000, 30_000, 60_000]
const BUSY_DELAYS = [15_000, 30_000, 60_000, 120_000]

export function apply(ctx, config = {}) {
  // A hot reload can install this module again before the old scope is
  // disposed; both would then own captures and fight over the same COM port.
  try {
    globalThis[INSTANCE]?.()
  } catch {
    /* the predecessor is already gone */
  }

  const pythonPath = typeof config.pythonPath === 'string' && config.pythonPath !== '' ? config.pythonPath : 'python'
  const autoStart = config.autoStart !== false
  const ringChars = Number.isFinite(config.ringChars) ? Math.max(4_000, config.ringChars) : 400_000
  /** Lock files + the remembered declared list live here. */
  const STATE_DIR = typeof config.stateDir === 'string' && config.stateDir !== '' ? config.stateDir : join(tmpdir(), 'dsh-serial-monitor')
  const DECLARED_FILE = join(STATE_DIR, 'declared.json')

  /** key → capture. Key is `${port}@${baud}`, which is also the tool's target. */
  const streams = new Map()
  /** key → { timer, step } for a port that dropped out. */
  const retries = new Map()
  /** What the Session asked for; survives pause and restarts. */
  let declared = []
  /** Set when the Session or the user takes over: no automatic restarts. */
  let manual = false
  /** Last self-check posted by the Client half. */
  let diag = null
  /** One-off messages (e.g. reclaimed captures) surfaced through the tool. */
  let notes = []
  /** key → cursor, for `read --sinceLast`. */
  const toolCursors = new Map()
  /** Set when this instance is superseded: its timers and spawns must go quiet. */
  let disposed = false

  const keyOf = (port, baud) => `${port}@${baud}`

  function normalize(list) {
    const wanted = new Map()
    if (!Array.isArray(list)) return []
    for (const entry of list) {
      const port = typeof entry?.port === 'string' ? entry.port.trim() : ''
      const baud = Number.isInteger(entry?.baud) ? entry.baud : 9600
      if (port === '' || !PORT_PATTERN.test(port)) continue
      if (baud < 300 || baud > 4_000_000) continue
      wanted.set(keyOf(port, baud), { port, baud })
    }
    return [...wanted.values()]
  }

  function persistDeclared() {
    try {
      writeFileSync(DECLARED_FILE, JSON.stringify(declared))
    } catch {
      /* the declared set also lives in memory and in the patch config */
    }
  }

  function loadDeclared() {
    // The Session's own list wins; `config.streams` only seeds a fresh profile.
    try {
      return normalize(JSON.parse(readFileSync(DECLARED_FILE, 'utf8')))
    } catch {
      return Array.isArray(config.streams) ? normalize(config.streams) : []
    }
  }

  /**
   * A reloaded plugin instance must not leave the previous one's capture
   * holding the port. Captures stamp a lock named with this Host's pid, so only
   * our own leftovers are reclaimed; another window's live capture is left
   * alone unless that process is gone.
   */
  function reclaimStaleCaptures() {
    let names = []
    try {
      names = readdirSync(STATE_DIR)
    } catch {
      return 0
    }
    const alive = (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    let reclaimed = 0
    for (const name of names) {
      if (!name.endsWith('.lock')) continue
      const path = join(STATE_DIR, name)
      let pid = Number.NaN
      try {
        pid = Number.parseInt(readFileSync(path, 'utf8').trim(), 10)
      } catch {
        /* unreadable lock: just drop it */
      }
      const mine = name.endsWith(`.${process.pid}.lock`)
      const running = Number.isInteger(pid) && pid > 0 && alive(pid)
      if (mine && running) {
        try {
          process.kill(pid)
          reclaimed += 1
        } catch {
          /* already gone */
        }
      }
      if (mine || !running) {
        try {
          unlinkSync(path)
        } catch {
          /* raced with the child's own cleanup */
        }
      }
    }
    return reclaimed
  }

  function ensureRing(capture) {
    if (capture.buffer.length > ringChars) capture.buffer = capture.buffer.slice(capture.buffer.length - ringChars)
  }

  function appendTo(capture, text) {
    if (text === '') return
    capture.buffer += text
    capture.total += text.length
    ensureRing(capture)
  }

  function clearRetry(key) {
    const entry = retries.get(key)
    if (entry !== undefined) {
      clearTimeout(entry.timer)
      retries.delete(key)
    }
  }

  function clearAllRetries() {
    for (const [key] of retries) clearRetry(key)
  }

  function scheduleRetry(port, baud, busy = false) {
    if (manual || disposed) return
    const key = keyOf(port, baud)
    const step = retries.get(key)?.step ?? 0
    clearRetry(key)
    const ladder = busy ? BUSY_DELAYS : RETRY_DELAYS
    const delay = ladder[Math.min(step, ladder.length - 1)]
    const timer = setTimeout(() => {
      retries.delete(key)
      startStream(port, baud)
    }, delay)
    retries.set(key, { timer, step: step + 1 })
  }

  /**
   * Ask the sidecar to close the port itself ("quit" → the sidecar closes the
   * handle, aborting a blocking read), then fall back to a kill. Force-killing
   * mid-read is what leaves some USB-serial drivers refusing to reopen a port.
   */
  function releaseChild(child) {
    let killed = false
    const escalate = () => {
      if (killed) return
      killed = true
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
    try {
      child.stdin?.write('quit\n')
      child.stdin?.end()
    } catch {
      /* pipe already closed */
    }
    const timer = setTimeout(escalate, 1_500)
    timer.unref?.()
    child.once('exit', () => {
      clearTimeout(timer)
      killed = true
    })
  }

  function stopStream(key) {
    const capture = streams.get(key)
    if (capture === undefined) return false
    clearRetry(key)
    streams.delete(key)
    toolCursors.delete(key)
    const child = capture.child
    capture.child = null
    if (child !== null) releaseChild(child)
    return true
  }

  function stopAll() {
    for (const key of [...streams.keys()]) stopStream(key)
  }

  function startStream(port, baud) {
    if (disposed) return undefined
    const key = keyOf(port, baud)
    const existing = streams.get(key)
    if (existing !== undefined && existing.child !== null) return existing

    const capture = existing ?? { key, port, baud, child: null, buffer: '', total: 0, error: null, startedAt: Date.now(), openedAt: null }
    capture.error = null
    capture.child = null
    capture.openedAt = null
    streams.set(key, capture)
    clearRetry(key)

    let child
    try {
      child = spawn(pythonPath, ['-u', SIDECAR, 'read', '--port', port, '--baud', String(baud), '--owner', String(process.pid)], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      capture.error = `无法启动 ${pythonPath}：${error instanceof Error ? error.message : String(error)}`
      scheduleRetry(port, baud, true)
      return capture
    }
    capture.child = child

    let partial = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      partial += chunk
      const lines = partial.split('\n')
      partial = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        let message
        try {
          message = JSON.parse(trimmed)
        } catch {
          continue
        }
        if (message.type === 'data' && typeof message.text === 'string') appendTo(capture, message.text)
        else if (message.type === 'opened') {
          capture.openedAt = Date.now()
          capture.error = null
        } else if (message.type === 'error') capture.error = String(message.error ?? message.message ?? '串口错误')
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => {
      /* pyserial warnings are not fatal; the exit handler reports the real one */
    })
    child.on('exit', (code) => {
      // A superseded child must not clear the handle a newer capture holds.
      if (capture.child !== child) return
      capture.child = null
      if (!streams.has(key)) return
      capture.error = capture.error ?? `串口进程退出（code ${code ?? '?'}）`
      scheduleRetry(port, baud, capture.openedAt === null)
    })
    return capture
  }

  /** Open every declared pair that is not already streaming. */
  function openDeclared() {
    for (const entry of declared) startStream(entry.port, entry.baud)
    return declared.length
  }

  /** Replace the declared set; every capture outside it stops. */
  function watch(list) {
    manual = false
    declared = normalize(list)
    persistDeclared()
    const keys = new Set(declared.map((entry) => keyOf(entry.port, entry.baud)))
    for (const key of [...streams.keys()]) if (!keys.has(key)) stopStream(key)
    openDeclared()
    return declared.length
  }

  function addDeclared(port, baud) {
    const key = keyOf(port, baud)
    if (!declared.some((entry) => keyOf(entry.port, entry.baud) === key)) {
      declared = [...declared, { port, baud }]
      persistDeclared()
    }
    manual = false
    startStream(port, baud)
    return key
  }

  function removeDeclared(port, baud) {
    const key = keyOf(port, baud)
    declared = declared.filter((entry) => keyOf(entry.port, entry.baud) !== key)
    persistDeclared()
    return stopStream(key)
  }

  function runSidecar(args) {
    return new Promise((resolve) => {
      const child = spawn(pythonPath, ['-u', SIDECAR, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      let out = ''
      let err = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        out += chunk
      })
      child.stderr.on('data', (chunk) => {
        err += chunk
      })
      child.on('error', (error) => resolve({ ok: false, error: error.message }))
      child.on('exit', () => {
        try {
          resolve({ ok: true, value: JSON.parse(out.trim().split('\n').pop() ?? '{}') })
        } catch {
          resolve({ ok: false, error: err.trim() || '串口子进程没有返回结果' })
        }
      })
    })
  }

  /** Enumerate ports only — nothing here opens the wire. */
  async function listPorts() {
    const result = await runSidecar(['list'])
    if (!result.ok) return { ports: [], error: result.error }
    const ports = Array.isArray(result.value.ports) ? result.value.ports : []
    return { ...result.value, ports: ports.filter((port) => !BLUETOOTH_HWID.test(port.hwid ?? '')) }
  }

  function streamBase(capture) {
    return {
      key: capture.key,
      port: capture.port,
      baud: capture.baud,
      running: capture.child !== null,
      total: capture.total,
      error: capture.error,
    }
  }

  function streamSlice(capture, since) {
    const start = capture.total - capture.buffer.length
    if (since >= capture.total) return { ...streamBase(capture), cursor: capture.total, text: '' }
    if (since < start) return { ...streamBase(capture), cursor: capture.total, truncated: true, text: capture.buffer }
    return { ...streamBase(capture), cursor: capture.total, text: capture.buffer.slice(since - start) }
  }

  function snapshot(sinceMap) {
    return {
      manual,
      declared,
      notes,
      diag,
      streams: [...streams.values()].map((capture) => streamSlice(capture, sinceMap.get(capture.key) ?? 0)),
    }
  }

  function describeStreams() {
    return [...streams.values()].map((capture) => ({
      ...streamBase(capture),
      tail: capture.buffer.slice(-2_000),
    }))
  }

  function resolveCapture(target) {
    if (target === undefined || target === null || target === '') return undefined
    const text = String(target)
    if (streams.has(text)) return streams.get(text)
    for (const capture of streams.values()) if (capture.port === text) return capture
    return undefined
  }

  function readTargets(target, args) {
    const limit = Math.min(20_000, Math.max(200, Number.isInteger(args.tailChars) ? args.tailChars : 4_000))
    const sinceLast = args.sinceLast === true
    const chosen = target === undefined ? [...streams.values()] : [resolveCapture(target)].filter(Boolean)
    return chosen.map((capture) => {
      const start = capture.total - capture.buffer.length
      const from = sinceLast && toolCursors.has(capture.key) ? toolCursors.get(capture.key) : capture.total - limit
      const begin = Math.max(from, start, capture.total - limit)
      const text = capture.buffer.slice(begin - start)
      toolCursors.set(capture.key, capture.total)
      return { ...streamBase(capture), cursor: capture.total, text, dropped: from < start }
    })
  }

  function waitFor(args) {
    const timeoutMs = Math.min(30_000, Math.max(200, Number.isInteger(args.timeoutMs) ? args.timeoutMs : 5_000))
    const pattern = typeof args.pattern === 'string' ? args.pattern : ''
    const target = resolveCapture(args.target)
    const targets = target === undefined ? [...streams.values()] : [target]
    const offsets = new Map(targets.map((capture) => [capture.key, capture.total]))
    const started = Date.now()
    const readSince = (capture) => {
      const start = capture.total - capture.buffer.length
      return capture.buffer.slice(Math.max(offsets.get(capture.key) ?? 0, start) - start)
    }
    const matches = (chunk) => {
      if (pattern === '') return chunk.length > 0
      if (pattern.length > 2 && pattern.startsWith('/') && pattern.endsWith('/')) {
        try {
          return new RegExp(pattern.slice(1, -1), 'm').test(chunk)
        } catch {
          return chunk.includes(pattern)
        }
      }
      return chunk.includes(pattern)
    }
    return new Promise((resolve) => {
      const check = () => {
        const hits = []
        for (const capture of targets) {
          const chunk = readSince(capture)
          if (matches(chunk)) hits.push({ ...streamBase(capture), matched: true, text: chunk.slice(-4_000) })
        }
        if (hits.length > 0) {
          for (const capture of targets) toolCursors.set(capture.key, capture.total)
          resolve({ matched: true, waitedMs: Date.now() - started, streams: hits })
          return
        }
        if (Date.now() - started >= timeoutMs) {
          for (const capture of targets) toolCursors.set(capture.key, capture.total)
          resolve({
            matched: false,
            waitedMs: Date.now() - started,
            streams: targets.map((capture) => ({ ...streamBase(capture), text: readSince(capture).slice(-2_000) })),
          })
          return
        }
        setTimeout(check, 200)
      }
      check()
    })
  }

  const shutdown = () => {
    disposed = true
    manual = true
    clearAllRetries()
    stopAll()
  }

  ctx.effect(() => () => shutdown(), 'serial-monitor: sidecar cleanup')
  // Safety net: a capture whose child is gone (lost timer, port that was held
  // and later released) gets another attempt instead of staying silent forever.
  const watchdog = setInterval(() => {
    if (manual || disposed) return
    for (const entry of declared) {
      const capture = streams.get(keyOf(entry.port, entry.baud))
      if (capture !== undefined && capture.child === null && !retries.has(capture.key)) startStream(entry.port, entry.baud)
    }
  }, 30_000)
  watchdog.unref?.()
  ctx.effect(() => () => clearInterval(watchdog), 'serial-monitor: watchdog')
  // Published so a hot-reloaded successor can shut this instance down even if
  // its own scope disposal has not run yet.
  globalThis[INSTANCE] = shutdown
  ctx.effect(
    () => () => {
      if (globalThis[INSTANCE] === shutdown) delete globalThis[INSTANCE]
    },
    'serial-monitor: instance marker',
  )

  // Every Session sees this one-paragraph pointer; the tool schema carries the
  // rest, so the text stays short and says each fact once.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.section({
          name: 'serial-monitor',
          order: 880,
          text: [
            '## 本机串口',
            '用户提到串口、UART、板子日志、抓包时，用 `serial_monitor` 工具读数据；同一份数据也显示在 Web 右侧栏的「串口」tab。',
            '**端口由用户开关，会话只读**：没有打开/关闭/切换串口的动作。用 `status` 看用户在抓哪几路，`read` 取尾部或增量，`wait` 等某行出现；`ports` 只列端口名，不打开任何口。',
            '要改端口、波特率或停抓，请让用户自己在右侧栏操作，不要另起 `uart_capture.py` 等脚本抢同一个口。',
          ].join('\n'),
        }),
      'serial-monitor: prompt section',
    )
  })

  ctx.inject(['webServer'], (webCtx) => {
    const gated = (handler) => async (req, res) => {
      const rejection = ctx.get('connection')?.requestRejection?.(req)
      if (rejection !== undefined && rejection !== null) {
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }
      try {
        await handler(req, res)
      } catch (error) {
        sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) })
      }
    }

    const readBody = async (req) => {
      let body = ''
      for await (const chunk of req) body += chunk
      try {
        return JSON.parse(body === '' ? '{}' : body)
      } catch {
        return {}
      }
    }

    const routes = [
      {
        path: `${ROUTE_BASE}/status`,
        handler: gated(async (req, res) => {
          sendJson(res, 200, snapshot(new Map()))
        }),
      },
      {
        path: `${ROUTE_BASE}/poll`,
        handler: gated(async (req, res) => {
          const url = new URL(req.url ?? '/', 'http://x')
          const since = new Map()
          const raw = url.searchParams.get('since') ?? ''
          for (const chunk of raw.split(',')) {
            const index = chunk.lastIndexOf(':')
            if (index <= 0) continue
            const key = decodeURIComponent(chunk.slice(0, index))
            const cursor = Number.parseInt(chunk.slice(index + 1), 10)
            if (Number.isFinite(cursor) && cursor > 0) since.set(key, cursor)
          }
          sendJson(res, 200, snapshot(since))
        }),
      },
      {
        path: `${ROUTE_BASE}/watch`,
        handler: gated(async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' })
            return
          }
          const body = await readBody(req)
          if (!Array.isArray(body.streams)) {
            sendJson(res, 400, { error: '需要 { streams: [{ port, baud }] }' })
            return
          }
          const count = watch(body.streams)
          sendJson(res, 200, { ...snapshot(new Map()), watched: count })
        }),
      },
      {
        path: `${ROUTE_BASE}/add`,
        handler: gated(async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' })
            return
          }
          const body = await readBody(req)
          const port = typeof body.port === 'string' ? body.port.trim() : ''
          const baud = Number.isInteger(body.baud) ? body.baud : 9600
          if (port === '' || !PORT_PATTERN.test(port)) {
            sendJson(res, 400, { error: '端口名不合法' })
            return
          }
          if (baud < 300 || baud > 4_000_000) {
            sendJson(res, 400, { error: '波特率超出范围' })
            return
          }
          addDeclared(port, baud)
          sendJson(res, 200, snapshot(new Map()))
        }),
      },
      {
        path: `${ROUTE_BASE}/remove`,
        handler: gated(async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' })
            return
          }
          const body = await readBody(req)
          const key = typeof body.key === 'string' ? body.key : ''
          const capture = resolveCapture(key)
          if (capture !== undefined) removeDeclared(capture.port, capture.baud)
          else stopStream(key)
          sendJson(res, 200, snapshot(new Map()))
        }),
      },
      {
        path: `${ROUTE_BASE}/stop`,
        handler: gated(async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' })
            return
          }
          manual = true
          clearAllRetries()
          stopAll()
          sendJson(res, 200, snapshot(new Map()))
        }),
      },
      {
        path: `${ROUTE_BASE}/resume`,
        handler: gated(async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' })
            return
          }
          manual = false
          openDeclared()
          sendJson(res, 200, snapshot(new Map()))
        }),
      },
      {
        path: `${ROUTE_BASE}/ports`,
        handler: gated(async (req, res) => {
          const result = await listPorts()
          sendJson(res, 200, { ...result, declared })
        }),
      },
      {
        path: `${ROUTE_BASE}/diag`,
        handler: gated(async (req, res) => {
          if (req.method !== 'POST') {
            sendJson(res, 405, { error: 'POST only' })
            return
          }
          diag = { at: new Date().toISOString(), ...(await readBody(req)) }
          sendJson(res, 200, { ok: true })
        }),
      },
    ]

    for (const route of routes) {
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
        `serial-monitor: route ${route.path}`,
      )
    }
  })

  // Agent-facing tool: read-only. The user owns the ports through the panel;
  // the Session only reads the same in-process buffers the panel shows.
  ctx.inject(['tools'], (toolCtx) => {
    const formatStreams = (entries) =>
      entries
        .map((entry) => {
          const head = `${entry.key} · ${entry.total} B${entry.error ? ` · error=${entry.error}` : ''}`
          return entry.text === '' || entry.text === undefined ? head : `${head}\n${entry.text}`
        })
        .join('\n\n')

    const summary = (value) => {
      const diagLine = value.diag
        ? `client: tabs=${value.diag.hasTabs === true ? 'yes' : 'no'} sidebar=${value.diag.hasRight === true ? 'yes' : 'no'} type=${value.diag.tabKindRegistered ?? value.diag.fatal ?? 'NOT REGISTERED'}`
        : null
      const notesLine = Array.isArray(value.notes) && value.notes.length > 0 ? value.notes.join('\n') : null
      const declaredLine =
        Array.isArray(value.declared) && value.declared.length > 0 ? `清单：${value.declared.map((entry) => `${entry.port}@${entry.baud}`).join(', ')}` : null
      if (Array.isArray(value.streams) && value.streams.length > 0) {
        const head = value.matched !== undefined ? `${value.matched ? 'matched' : 'no match'} · ${value.waitedMs} ms · ${value.streams.length} 路` : `${value.streams.length} 路 · 就绪`
        return [head, declaredLine, notesLine, diagLine, formatStreams(value.streams)].filter((part) => part !== null && part !== '').join('\n\n')
      }
      if (Array.isArray(value.ports)) {
        const list = value.ports.length === 0 ? '没发现串口' : value.ports.map((port) => `${port.device}${port.description ? ` — ${port.description}` : ''}`).join('\n')
        return [list, declaredLine, value.error ?? null].filter(Boolean).join('\n\n')
      }
      if (value.streams !== undefined) return ['当前没有端口在回显', declaredLine, notesLine].filter(Boolean).join('\n\n')
      const parts = []
      if (value.note) parts.push(value.note)
      return parts.join(' · ')
    }

    toolCtx.effect(
      () =>
        toolCtx.tools.register({
          name: 'serial_monitor',
          description:
            '本机串口**只读**：用户已经在 Web 右侧栏打开哪些口，你就读哪些口的数据，同一份字节也在「串口」tab 显示。' +
            '会话不能开关串口——没有打开、关闭、切换端口或波特率的动作。status 看用户在抓哪几路（含字节数与错误），read 取尾部或增量，wait 等某行出现，ports 只列端口名。' +
            '要换端口、改波特率或停抓，请让用户自己在右侧栏操作；也不要另起 uart_capture.py 等脚本抢同一个口（端口由插件独占）。',
          parameters: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['status', 'read', 'wait', 'mark', 'ports'],
                description: 'status/read/wait/mark/ports —— 全是只读动作',
              },
              target: { type: 'string', description: 'read/wait：目标流（COM23@9600 或端口名）；省略=全部' },
              tailChars: { type: 'integer', description: 'read 取多少尾部字符，默认 4000，范围 200~20000' },
              sinceLast: { type: 'boolean', description: 'read 只返回自上次 read/wait 以来的新增内容' },
              pattern: { type: 'string', description: 'wait 的目标：普通子串，或 /正则/ 形式' },
              timeoutMs: { type: 'integer', description: 'wait 的等待上限，默认 5000，上限 30000' },
            },
            required: ['action'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: {} },
            render: (_args, value) => [{ type: 'text', text: summary(value) }],
          },
          async execute(args) {
            const action = typeof args?.action === 'string' ? args.action : 'status'
            const base = () => ({ action, manual, declared, diag, notes })

            if (action === 'status') return { ...base(), streams: describeStreams() }
            if (action === 'ports') {
              const listed = await listPorts()
              return { ...base(), ports: listed.ports ?? [], error: listed.error ?? null }
            }
            if (action === 'read') return { ...base(), streams: readTargets(args?.target, args ?? {}) }
            if (action === 'wait') return { ...base(), ...(await waitFor(args ?? {})) }
            if (action === 'mark') {
              for (const capture of streams.values()) toolCursors.set(capture.key, capture.total)
              return { ...base(), note: '增量游标已推到所有流的末尾' }
            }
            if (action === 'watch' || action === 'add' || action === 'remove' || action === 'pause' || action === 'resume') {
              return { ...base(), note: `会话不能开关串口（${action}）：端口与波特率由用户在右侧栏「串口」tab 操作` }
            }
            return { ...base(), note: `未知 action: ${action}` }
          },
        }),
      'serial-monitor: tool',
    )
  })

  // A previous instance of this plugin may have left a capture holding a port.
  const reclaimed = reclaimStaleCaptures()
  if (reclaimed > 0) notes = [`已回收上一次加载遗留的 ${reclaimed} 个抓取进程`]

  // No probing: the declared list is the whole rule, and it opens immediately so
  // the echo is live before anyone opens a panel.
  declared = loadDeclared()
  if (autoStart && declared.length > 0) {
    const timer = setTimeout(() => {
      if (!manual && !disposed) openDeclared()
    }, 800)
    ctx.effect(() => () => clearTimeout(timer), 'serial-monitor: autostart timer')
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}
