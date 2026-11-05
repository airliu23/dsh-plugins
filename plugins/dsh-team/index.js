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
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createTicketStore, summarize } from './store.js'
import { createDispatcher, openDeps } from './dispatcher.js'
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

  const notifyEnabled = config.notify !== false
  const notifyMaxChars =
    Number.isFinite(config.notifyMaxChars) && config.notifyMaxChars >= 500
      ? Math.min(20_000, Math.trunc(config.notifyMaxChars))
      : 4_000

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

  // --- completion push -----------------------------------------------------
  // A ticket belongs to the Session that posted it. When the worker ends, its
  // report is pushed into that Session as a follow-up turn, so the agent
  // reports back on its own instead of polling `team wait`.
  const liveAgents = new Map() // sessionId → the agent captured from a tool call
  const attempted = new Set()
  let services = null
  let delivering = false

  // Tickets that ended while this Host was down are history, not news: mark them
  // notified so activation does not replay yesterday's reports into a Session.
  for (const ticket of store.snapshot().tickets) {
    if (TERMINAL.has(ticket.state) && ticket.notifiedAt === null) store.patch(ticket.id, { notifiedAt: Date.now() })
  }

  ctx.inject(['sessions', 'sessionController'], (notifyCtx) => {
    services = notifyCtx
  })

  /** Host-side message factory: `@deepseek-ai/dsh-llm` is not resolvable from a linked bundle. */
  const deepFreeze = (value) => {
    if (value !== null && typeof value === 'object') {
      for (const inner of Object.values(value)) deepFreeze(inner)
      Object.freeze(value)
    }
    return value
  }

  const userMessage = (text, source) =>
    deepFreeze({ id: randomUUID(), role: 'user', content: [{ type: 'text', text }], source })

  const sessionIdOf = (exec) => {
    const id = exec?.agent?.session?.id ?? exec?.agent?.sessionId
    return typeof id === 'string' ? id : ''
  }

  async function resolveAgent(sessionId) {
    const live = liveAgents.get(sessionId)
    if (live !== undefined) return live
    try {
      const resolved = await services?.sessionController?.resolveAgent(sessionId)
      return resolved !== null && typeof resolved === 'object' && resolved.agent !== undefined ? resolved.agent : undefined
    } catch {
      return undefined
    }
  }

  function notificationText(ticket) {
    const elapsed = duration((ticket.finishedAt ?? Date.now()) - (ticket.startedAt ?? ticket.createdAt))
    const body = ticket.state === 'failed' ? ticket.error || ticket.report : ticket.report
    const clipped =
      body.length > notifyMaxChars ? `${body.slice(0, notifyMaxChars)}\n…（已截断，完整报告在输出目录的 reply.md）` : body
    return [
      `【后台工单结束】${ticket.title}`,
      `id: ${ticket.id} · 状态: ${ticket.state} · 耗时: ${elapsed}${Number.isInteger(ticket.exitCode) ? ` · 退出码: ${ticket.exitCode}` : ''}`,
      ticket.outDir === '' ? null : `输出目录: ${ticket.outDir}`,
      '',
      body === '' ? '（worker 没有留下报告）' : clipped,
      '',
      '把结论转告用户；看板里还能看到这张工单和完整报告，不需要再等或再查。',
    ]
      .filter((line) => line !== null)
      .join('\n')
  }

  async function deliverPending() {
    if (!notifyEnabled || delivering) return
    const due = store
      .snapshot()
      .tickets.filter(
        (ticket) => TERMINAL.has(ticket.state) && ticket.sessionId !== '' && ticket.notifiedAt === null && !attempted.has(ticket.id),
      )
    if (due.length === 0) return
    delivering = true
    try {
      for (const ticket of due) {
        // Claim before sending: a later store change must not queue it twice.
        attempted.add(ticket.id)
        try {
          const agent = await resolveAgent(ticket.sessionId)
          if (agent === undefined) continue
          agent.followup(userMessage(notificationText(ticket), { kind: 'dsh-team', ticketId: ticket.id }))
          await services?.sessions?.flush(agent.session)
          store.patch(ticket.id, { notifiedAt: Date.now() })
        } catch (error) {
          ctx.logger?.warn?.(`dsh-team: 工单 ${ticket.id} 的通知没有送达：${describe(error)}`)
        }
      }
    } finally {
      delivering = false
    }
  }

  const unsubscribeNotify = store.onChange(() => void deliverPending())

  const shutdown = () => {
    if (closed) return
    closed = true
    dispatcher.stop()
    unsubscribe()
    unsubscribeNotify()
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
        const waiting = ticket.state === 'queued' ? openDeps(store, ticket).length : 0
        const mark = waiting > 0 ? '⏸' : { done: '✓', failed: '✗', canceled: '−', running: '▶', queued: '·' }[ticket.state] ?? '?'
        const gate = waiting > 0 ? `  等 ${waiting} 张上游` : ''
        return `${mark} ${ticket.id}  ${ticket.state.padEnd(8)} ${elapsed.padStart(6)}  ${ticket.title}${gate}`
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
            'action：post 投一张工单（title + task，task 必须自包含：说清项目路径、范围、验收标准）；board 看板；wait 阻塞等待工单结束并取回报告；cancel 取消排队中的工单；retry 重跑已结束的工单。' +
            'post 带 `from: [id...]` 就是一个**汇总单**：它一直排在队列里等这些上游工单全部结束，开跑时上游报告会自动拼进它的 task，worker 不必重读它们读过的文件。' +
            'post 之后**不要**立刻 wait：工单结束时会自动把报告推回本会话，等通知即可；只有必须在本轮里拿到结果时才用 wait。',
          parameters: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['post', 'board', 'wait', 'cancel', 'retry'], description: '要执行的动作' },
              title: { type: 'string', description: 'post 的短标题，一行，便于看板识别' },
              task: { type: 'string', description: 'post 的完整任务描述；worker 看不到本会话，必须自包含' },
              ids: { type: 'array', items: { type: 'string' }, description: 'wait 的工单 id 列表' },
              from: {
                type: 'array',
                items: { type: 'string' },
                description: 'post 的上游工单 id 列表：本单等它们全部结束才开跑，报告自动拼进来（汇总单）',
              },
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
          async execute(args, exec) {
            const action = typeof args?.action === 'string' ? args.action : 'board'
            if (action === 'post') {
              const sessionId = sessionIdOf(exec)
              if (sessionId !== '' && exec?.agent !== undefined) liveAgents.set(sessionId, exec.agent)
              const from = Array.isArray(args?.from)
                ? args.from.map(String)
                : typeof args?.from === 'string'
                  ? args.from.split(',').map((part) => part.trim())
                  : []
              for (const id of from) {
                if (store.find(id) === undefined) throw new Error(`没有这张上游工单：${id}`)
              }
              const ticket = store.add({ title: args?.title, task: args?.task, source: 'session', sessionId, waitsFor: from })
              dispatcher.pump()
              const tail = [
                ticket.waitsFor.length > 0
                  ? `这是汇总单：等上游 ${ticket.waitsFor.length} 张（${ticket.waitsFor.join('、')}）结束后自动开始，届时它们的报告会拼进这张工单的 task。`
                  : null,
                notifyEnabled
                  ? '结束时会自动把报告推回本会话，你不用等；现在可以继续别的事。'
                  : '完成通知已关闭（notify: false），需要结果时用 wait。',
              ]
                .filter((line) => line !== null)
                .join('\n')
              return { text: `已投工单 ${ticket.id}（${ticket.title}）\n${tail}\n\n${board()}` }
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
            '`team` 工具可以把任务交给独立 worker 并行跑：post 投单、board 看板、wait 阻塞取回。',
            '判据：单个子任务超过 3 分钟、或几件事互相独立、或需要脱离本轮对话 → 投单；一次调用就能拿到答案、或依赖本会话上下文 → 就地做。',
            '投完就继续做别的：工单结束会以一条「后台工单结束」的通知推回本会话，不需要 wait 轮询。',
            '要总论时投一张**汇总单**（post 带 `from: [上游 id...]`）：它等上游全部结束才开跑，上游报告自动拼进它的 task——合并交给 worker，不要自己人肉汇总。',
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
