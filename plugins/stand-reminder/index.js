/**
 * Host half of the stand-reminder bundle.
 *
 * The schedule lives here, not in the browser: one JSON document (default
 * `<DSH_HOME>/stand-reminder/state.json`) holds the interval, the break length
 * and the next due time, so reloading the page or restarting the app keeps the
 * hour counting. A 10 s timer checks the schedule and only fires while at least
 * one Web panel is connected (SSE) — with no page open there is nobody to show
 * a window to, and a due moment more than 10 minutes old is treated as "you
 * were not at the desk" and silently re-anchored instead of popping late.
 *
 * Three callers share the same state:
 *   - the floating window + session header button, through the routes below
 *   - the agent through the `stand_reminder` tool
 *   - the next Host process, at activation
 */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createReminderStore } from './store.js'

const ROUTE_BASE = '/plugins/stand-reminder'
/** One live instance per Host process; a hot reload supersedes its predecessor. */
const INSTANCE = Symbol.for('dsh.stand-reminder.instance')
/** How often the schedule is checked. Sub-minute precision is irrelevant here. */
const TICK_MS = 10_000
/** A reminder this much past due is dropped instead of shown late. */
const STALE_GRACE_MS = 10 * 60_000

export function apply(ctx, config = {}) {
  // A reload can install this module again before the old scope is disposed;
  // both would then answer the same routes and run two timers.
  try {
    globalThis[INSTANCE]?.()
  } catch {
    /* the predecessor is already gone */
  }

  const now = typeof config.now === 'function' ? config.now : Date.now
  // `tickMs` is a test hook (the Host suites drive a 30 ms clock); production
  // always uses TICK_MS.
  const tickMs = Number.isFinite(config.tickMs) ? Math.max(20, Math.trunc(config.tickMs)) : TICK_MS

  const store = createReminderStore({
    file: resolveDataFile(config.file),
    now,
    settings: {
      intervalMinutes: config.intervalMinutes,
      breakSeconds: config.breakSeconds,
      snoozeMinutes: config.snoozeMinutes,
      sound: config.sound,
      notify: config.notify,
    },
    enabled: config.enabled,
  })

  /** Open SSE responses. `null` means no panel is watching. */
  const listeners = new Set()
  let heartbeat = null
  let timer = null
  let closed = false

  const frame = (event, payload) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`

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

  function broadcast(event, payload) {
    if (closed || listeners.size === 0) return
    const body = frame(event, payload)
    for (const response of [...listeners]) {
      try {
        response.write(body)
      } catch {
        listeners.delete(response)
      }
    }
    if (listeners.size === 0) stopHeartbeat()
  }

  const broadcastState = () => broadcast('state', store.snapshot())

  /** Show the window now. With no panel open the schedule is left untouched. */
  function showNow() {
    if (closed || listeners.size === 0) return { shown: false }
    const snapshot = store.markDue()
    broadcast('due', { at: snapshot.dueAt, serverNow: snapshot.serverNow })
    return { shown: true, snapshot }
  }

  function tick() {
    if (closed || listeners.size === 0) return
    const snapshot = store.snapshot()
    if (!snapshot.enabled || snapshot.nextDueAt === null) return
    const at = now()
    if (at < snapshot.nextDueAt) return
    if (at - snapshot.nextDueAt > STALE_GRACE_MS) {
      // Laptop slept or the page was closed: restart the interval quietly.
      store.reanchor(at)
      return
    }
    showNow()
  }

  timer = setInterval(tick, tickMs)
  timer.unref?.()

  const unsubscribe = store.onChange(broadcastState)

  const shutdown = () => {
    if (closed) return
    closed = true
    if (timer !== null) clearInterval(timer)
    timer = null
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
    'stand-reminder: instance cleanup',
  )

  // --- Web routes ----------------------------------------------------------
  // Same trust gate as the shipped routes: a bare webServer route is not
  // authenticated by itself, so an unadmitted peer gets 401.
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
          const extra = handler(body) ?? {}
          sendJson(res, 200, { ok: true, ...extra, ...store.snapshot() })
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
          res.write(frame('snapshot', store.snapshot()))
          listeners.add(res)
          startHeartbeat()
          // A page that just connected may be inheriting a due moment from a
          // closed window; the timer settles it on the next tick.
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
        path: `${ROUTE_BASE}/ack`,
        handler: mutation((body) => {
          const action = typeof body.action === 'string' ? body.action.trim() : ''
          store.ack(action, {
            minutes: Number.isFinite(body.minutes) ? body.minutes : undefined,
            breakSeconds: Number.isFinite(body.breakSeconds) ? body.breakSeconds : undefined,
          })
        }),
      },
      {
        path: `${ROUTE_BASE}/settings`,
        handler: mutation((body) => {
          const patch = {}
          for (const key of ['intervalMinutes', 'breakSeconds', 'snoozeMinutes']) {
            if (Number.isFinite(body[key])) patch[key] = body[key]
          }
          for (const key of ['sound', 'notify']) {
            if (typeof body[key] === 'boolean') patch[key] = body[key]
          }
          if (typeof body.enabled === 'boolean') patch.enabled = body.enabled
          store.configure(patch)
        }),
      },
      {
        path: `${ROUTE_BASE}/remind`,
        handler: mutation(() => {
          const result = showNow()
          return { shown: result.shown === true }
        }),
      },
    ]

    for (const route of routes) {
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
        `stand-reminder: route ${route.path}`,
      )
    }
  })

  // --- Agent tool ----------------------------------------------------------
  ctx.inject(['tools'], (toolCtx) => {
    toolCtx.effect(
      () =>
        toolCtx.tools.register({
          name: 'stand_reminder',
          description:
            '用户的**久坐提醒**：默认每 60 分钟弹一次「站起来动一动」的窗口，点「我站起来了」后休息 2 分钟。' +
            'status 看下一次和今天的次数；remind 立刻弹一次（GUI 页面没开时不会弹）；snooze 稍后提醒（默认 10 分钟）；' +
            'skip 跳过这一轮；configure 修改间隔 / 休息时长 / 稍后时长 / 开关 / 提示音。' +
            '用户说「每小时提醒我站起来」指的就是这个插件，不要另建 `schedule`。',
          parameters: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['status', 'remind', 'snooze', 'skip', 'configure'],
                description: '要执行的动作',
              },
              minutes: { type: 'number', description: 'snooze 多久之后再提醒（分钟，1–720），缺省用设置里的 10' },
              intervalMinutes: { type: 'number', description: 'configure：提醒间隔（分钟，5–480）' },
              breakSeconds: { type: 'number', description: 'configure：站立休息时长（秒，30–900）' },
              snoozeMinutes: { type: 'number', description: 'configure：默认「稍后提醒」时长（分钟，1–60）' },
              enabled: { type: 'boolean', description: 'configure：开启 / 关闭提醒' },
              sound: { type: 'boolean', description: 'configure：弹窗时是否响提示音' },
              notify: { type: 'boolean', description: 'configure：页面在后台时是否发系统通知（需在窗口里授权一次）' },
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
            if (action === 'remind') {
              const result = showNow()
              return { ...store.snapshot(), shown: result.shown === true }
            }
            if (action === 'snooze') {
              store.ack('snooze', { minutes: args?.minutes })
            } else if (action === 'skip') {
              store.ack('skip')
            } else if (action === 'configure') {
              const patch = {}
              for (const key of ['intervalMinutes', 'breakSeconds', 'snoozeMinutes']) {
                if (Number.isFinite(args?.[key])) patch[key] = args[key]
              }
              for (const key of ['sound', 'notify']) {
                if (typeof args?.[key] === 'boolean') patch[key] = args[key]
              }
              if (typeof args?.enabled === 'boolean') patch.enabled = args.enabled
              store.configure(patch)
            } else if (action !== 'status') {
              throw new Error(`未知 action: ${action}`)
            }
            return store.snapshot()
          },
        }),
      'stand-reminder: tool',
    )
  })

  // Every Session gets the one-line pointer; the tool schema carries the rest.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.section({
          name: 'stand-reminder',
          order: 891,
          text: [
            '## 久坐提醒',
            '用户装了 `stand-reminder`：默认每 60 分钟弹一次「站起来动一动」的窗口，休息 2 分钟。',
            '用户说「每小时提醒我站起来」「先别提醒」「改成 90 分钟」时用 `stand_reminder`（status/remind/snooze/skip/configure），不要另用 `schedule_create` 建定时。',
          ].join('\n'),
        }),
      'stand-reminder: prompt section',
    )
  })
}

function resolveDataFile(configured) {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
  if (typeof configured === 'string' && configured.trim() !== '') {
    const path = configured.trim()
    return isAbsolute(path) ? path : resolve(home, path)
  }
  return join(home, 'stand-reminder', 'state.json')
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function formatClock(timestamp) {
  try {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp))
  } catch {
    return ''
  }
}

function formatSpan(ms) {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    return rest === 0 ? `${hours} 小时` : `${hours} 小时 ${rest} 分钟`
  }
  if (minutes > 0) return seconds === 0 ? `${minutes} 分钟` : `${minutes} 分 ${seconds} 秒`
  return `${seconds} 秒`
}

function summary(value) {
  if (typeof value !== 'object' || value === null) return '久坐提醒：没有拿到状态。'
  const settings = value.settings ?? {}
  const servedAt = Number.isFinite(value.serverNow) ? value.serverNow : Date.now()
  const next = Number.isFinite(value.nextDueAt) ? value.nextDueAt : null
  const lines = []
  if (value.enabled === false) {
    lines.push('久坐提醒：已关闭。用 stand_reminder { action: "configure", enabled: true } 重新打开。')
  } else {
    const when =
      next === null
        ? '还没排下一次'
        : next <= servedAt
          ? '马上就会弹（等页面下一次检查）'
          : `${formatSpan(next - servedAt)}后（${formatClock(next)}）`
    lines.push(`久坐提醒：每 ${settings.intervalMinutes ?? '?'} 分钟一次，休息 ${Math.round((settings.breakSeconds ?? 0) / 60)} 分钟。`)
    lines.push(`下一次：${when}。`)
  }
  const today = value.today ?? {}
  lines.push(`今天：站起来 ${today.stands ?? 0} 次，共 ${formatSpan((today.seconds ?? 0) * 1000)}。`)
  if (value.shown === true) lines.push('已经在页面上弹出提醒。')
  else if (value.shown === false) lines.push('GUI 页面当前没有打开，这次没有弹窗；等页面打开后按新的间隔计时。')
  if (typeof value.note === 'string' && value.note !== '') lines.push(`注意：${value.note}`)
  return lines.join('\n')
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}
