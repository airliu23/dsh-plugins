/**
 * Host half of the dsh-team bundle: background tickets, one Ticket = one
 * `dsh headless` worker, at most `maxWorkers` at a time.
 *
 * Three callers share one store:
 *   - the agent through the `team` tool (post / board / wait / cancel / retry)
 *   - the Web panel through the routes below (state + SSE)
 *   - the next Host process, at activation (queued tickets resume)
 *
 * The point is the split rule in the tool description: a task worth more than a
 * few minutes, or several independent tasks, or work that must outlive this
 * turn, becomes a ticket; a one-call lookup stays inline.
 */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createTicketStore, summarize } from './store.js'
import { createDispatcher } from './dispatcher.js'
import { createRunner } from './runner.js'

const ROUTE_BASE = '/plugins/dsh-team'
/** One live instance per Host process; a hot reload supersedes its predecessor. */
const INSTANCE = Symbol.for('dsh.dsh-team.instance')
const TERMINAL = new Set(['done', 'failed', 'canceled'])

export function apply(ctx, config = {}) {
  try {
    globalThis[INSTANCE]?.()
  } catch {
    /* the predecessor is already gone */
  }

  const stateDir = resolveStateDir(config.stateDir)
  const store = createTicketStore({ file: join(stateDir, 'tickets.json') })
  const runner = createRunner({
    stateDir,
    dshBin: config.dshBin,
    patchFile: config.patchFile,
    timeoutMs: config.timeoutMs,
    env: config.env,
  })
  const dispatcher = createDispatcher({ store, runner, maxWorkers: config.maxWorkers })

  const listeners = new Set()
  let heartbeat = null
  let closed = false

  const sseFrame = (event, payload) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`

  function startHeartbeat() {
    if (heartbeat !== null) return
    heartbeat = setInterval(() => {
      for (const response of [...listeners]) {
        try {
          response.write(': ping\n\n')
        } catch {
          listeners.delete(response)
        }
      }
      if (listeners.size === 0) stopHeartbeat()
    }, 20_000)
    heartbeat.unref?.()
  }

  function stopHeartbeat() {
    if (heartbeat === null) return
    clearInterval(heartbeat)
    heartbeat = null
  }

  function broadcast() {
    if (closed || listeners.size === 0) return
    const frame = sseFrame('state', store.snapshot())
    for (const response of [...listeners]) {
      try {
        response.write(frame)
      } catch {
        listeners.delete(response)
      }
    }
    if (listeners.size === 0) stopHeartbeat()
  }

  const unsubscribe = store.onChange(broadcast)

  const shutdown = () => {
    if (closed) return
    closed = true
    dispatcher.stop()
    unsubscribe()
    stopHeartbeat()
    for (const response of [...listeners]) {
      listeners.delete(response)
      try {
        response.end()
      } catch {
        /* the browser is already gone */
      }
    }
  }

  globalThis[INSTANCE] = shutdown
  ctx.effect(
    () => () => {
      shutdown()
      if (globalThis[INSTANCE] === shutdown) delete globalThis[INSTANCE]
    },
    'dsh-team: instance cleanup',
  )

  // Queued tickets survive a restart; running ones were normalized to failed.
  dispatcher.pump()

  // --- Web routes ----------------------------------------------------------
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
        sendJson(res, 500, { error: describe(error) })
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

    const mutation = (handler) =>
      gated(async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST only' })
          return
        }
        const body = await readBody(req)
        try {
          handler(body)
          sendJson(res, 200, { ok: true, ...store.snapshot() })
        } catch (error) {
          sendJson(res, 400, { error: describe(error) })
        }
      })

    const routes = [
      {
        path: `${ROUTE_BASE}/state`,
        handler: gated(async (req, res) => {
          if (req.method !== 'GET' && req.method !== 'HEAD') {
            sendJson(res, 405, { error: 'GET only' })
            return
          }
          sendJson(res, 200, store.snapshot())
        }),
      },
      {
        path: `${ROUTE_BASE}/events`,
        handler: async (req, res) => {
          const rejection = ctx.get('connection')?.requestRejection?.(req)
          if (rejection !== undefined && rejection !== null) {
            sendJson(res, 401, { error: 'unauthorized' })
            return
          }
          res.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache, no-transform',
            connection: 'keep-alive',
            'x-accel-buffering': 'no',
          })
          res.write('retry: 2000\n\n')
          res.write(sseFrame('snapshot', store.snapshot()))
          listeners.add(res)
          startHeartbeat()
          let gone = false
          const drop = () => {
            if (gone) return
            gone = true
            listeners.delete(res)
            if (listeners.size === 0) stopHeartbeat()
          }
          req.on('close', drop)
          req.on('aborted', drop)
          res.on('close', drop)
          res.on('error', drop)
        },
      },
      {
        path: `${ROUTE_BASE}/post`,
        handler: mutation((body) => {
          const ticket = store.add({ title: body.title, task: body.task, source: body.source })
          dispatcher.pump()
          return ticket
        }),
      },
      {
        path: `${ROUTE_BASE}/cancel`,
        handler: mutation((body) => dispatcher.cancel(String(body.id ?? ''))),
      },
      {
        path: `${ROUTE_BASE}/retry`,
        handler: mutation((body) => dispatcher.retry(String(body.id ?? ''))),
      },
    ]

    for (const route of routes) {
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
        `dsh-team: route ${route.path}`,
      )
    }
  })

  // --- Agent tool ----------------------------------------------------------
  ctx.inject(['tools'], (toolCtx) => {
    const board = (filter) => {
      const snapshot = store.snapshot()
      const tickets = filter === undefined ? snapshot.tickets : snapshot.tickets.filter((ticket) => ticket.state === filter)
      const lines = tickets.map((ticket) => {
        const elapsed = duration(ticket.state === 'running' ? Date.now() - (ticket.startedAt ?? ticket.createdAt) : (ticket.finishedAt ?? 0) - (ticket.startedAt ?? ticket.createdAt))
        const mark = { done: '✓', failed: '✗', canceled: '−', running: '▶', queued: '·' }[ticket.state] ?? '?'
        return `${mark} ${ticket.id}  ${ticket.state.padEnd(8)} ${elapsed.padStart(6)}  ${ticket.title}`
      })
      const counts = snapshot.counts
      const head = `工单：排队 ${counts.queued} / 运行 ${counts.running} / 完成 ${counts.done} / 失败 ${counts.failed}${counts.canceled > 0 ? ` / 取消 ${counts.canceled}` : ''}`
      return [head, ...(lines.length > 0 ? lines : ['（还没有工单）']), snapshot.note].filter((line) => line !== null && line !== undefined).join('\n')
    }

    const reportOf = (ticket) =>
      [
        `## ${ticket.title}`,
        `id: ${ticket.id}  状态: ${ticket.state}  退出码: ${ticket.exitCode ?? '-'}`,
        ticket.error !== '' ? `错误: ${ticket.error}` : null,
        ticket.outDir !== '' ? `输出目录: ${ticket.outDir}` : null,
        '',
        ticket.report !== '' ? ticket.report : '（没有报告）',
      ]
        .filter((line) => line !== null)
        .join('\n')

    async function waitFor(ids, timeoutMs) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const tickets = ids.map((id) => store.find(id)).filter((ticket) => ticket !== undefined)
        if (tickets.length === ids.length && tickets.every((ticket) => TERMINAL.has(ticket.state))) return { tickets, timedOut: false }
        if (Date.now() >= deadline) return { tickets, timedOut: true }
        await new Promise((done) => setTimeout(done, 500))
      }
    }

    toolCtx.effect(
      () =>
        toolCtx.tools.register({
          name: 'team',
          description:
            '后台工单：把任务交给独立的 Headless worker 并行执行，不占用本轮对话。' +
            '**什么时候用**（满足任一条）：单个子任务预计超过 3 分钟；几件事互相独立、可以并行；任务要跑很久或要脱离对话；产出是大块文本、只需归档不必逐句消化。' +
            '**什么时候别用**：一次工具调用就能拿到答案（查文件、grep、读知识库）；答案依赖本会话上下文；需要来回澄清（worker 看不到本会话，也不会反问你）。' +
            'action：post 投一张工单（title + task，task 必须自包含：说清项目路径、范围、验收标准）；board 看板；wait 等待工单结束并取回报告；cancel 取消排队中的工单；retry 重跑已结束的工单。',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['post', 'board', 'wait', 'cancel', 'retry'], description: '要执行的动作' },
              title: { type: 'string', description: 'post 的短标题，一行，便于看板识别' },
              task: { type: 'string', description: 'post 的完整任务描述；worker 看不到本会话，必须自包含' },
              ids: { type: 'array', items: { type: 'string' }, description: 'wait 的工单 id 列表' },
              id: { type: 'string', description: 'cancel / retry 的目标工单 id' },
              timeoutMs: { type: 'number', description: 'wait 的最长等待毫秒数，默认 60000，上限 600000' },
              status: { type: 'string', enum: ['all', 'queued', 'running', 'done', 'failed', 'canceled'], description: 'board 的过滤条件，默认 all' },
            },
            required: ['action'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: {} },
            render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : board() }],
          },
          async execute(args) {
            const action = typeof args?.action === 'string' ? args.action : 'board'
            if (action === 'post') {
              const ticket = store.add({ title: args?.title, task: args?.task, source: 'session' })
              dispatcher.pump()
              return { text: `已投工单 ${ticket.id}（${ticket.title}）\n\n${board()}` }
            }
            if (action === 'cancel') {
              dispatcher.cancel(String(args?.id ?? ''))
              return { text: board() }
            }
            if (action === 'retry') {
              dispatcher.retry(String(args?.id ?? ''))
              return { text: board() }
            }
            if (action === 'wait') {
              const ids = Array.isArray(args?.ids) ? args.ids.map(String) : []
              if (ids.length === 0) throw new Error('wait 需要 ids')
              const requested = Number.isFinite(args?.timeoutMs) ? Math.min(600_000, Math.max(1_000, args.timeoutMs)) : 60_000
              const { tickets, timedOut } = await waitFor(ids, requested)
              const head = timedOut ? `等待超时（${Math.round(requested / 1000)} s），以下是当前状态：` : '全部结束：'
              return { text: [head, '', ...tickets.map(reportOf)].join('\n') }
            }
            if (action !== 'board') throw new Error(`未知 action: ${action}`)
            const status = args?.status
            return { text: board(status === undefined || status === 'all' ? undefined : status) }
          },
        }),
      'dsh-team: tool',
    )
  })

  // Every Session gets the split rule; the tool schema carries the actions.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.section({
          name: 'dsh-team',
          order: 880,
          text: [
            '## 后台工单（dsh-team）',
            '`team` 工具可以把任务交给独立 worker 并行跑：post 投单、board 看板、wait 等结果。',
            '判据：单个子任务超过 3 分钟、或几件事互相独立、或需要脱离本轮对话 → 投单；一次调用就能拿到答案、或依赖本会话上下文 → 就地做。',
            'worker 看不到本会话，所以 task 必须自包含（项目路径、范围、验收标准）。',
          ].join('\n'),
        }),
      'dsh-team: prompt section',
    )
  })
}

function resolveStateDir(configured) {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
  if (typeof configured === 'string' && configured.trim() !== '') {
    const path = configured.trim()
    return isAbsolute(path) ? path : resolve(home, path)
  }
  return join(home, 'dsh-team')
}

function duration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '-'
  const seconds = Math.round(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes < 60) return `${minutes}m${String(rest).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
}

const describe = (error) => (error instanceof Error ? error.message : String(error))

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

export { summarize }
