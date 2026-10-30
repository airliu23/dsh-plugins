/**
 * Host half of the todo-list bundle.
 *
 * One JSON document (default `<DSH_HOME>/todo-list/todos.json`) is the single
 * source of truth for three callers:
 *   - the Web panel (left sidebar「待办」→ `main` slot) through the routes below
 *   - the agent through the `todo` tool
 *   - the next Host process, at activation
 *
 * The panel is pushed the full list on every mutation (SSE), so a task added
 * from the chat shows up without a poll. There is no per-workspace split and
 * no session ownership: this is the user's own list.
 */
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { createTodoStore } from './store.js'

const ROUTE_BASE = '/plugins/todo-list'
/** One live instance per Host process; a hot reload supersedes its predecessor. */
const INSTANCE = Symbol.for('dsh.todo-list.instance')

export function apply(ctx, config = {}) {
  // A reload can install this module again before the old scope is disposed;
  // both would then answer the same routes and write the same file.
  try {
    globalThis[INSTANCE]?.()
  } catch {
    /* the predecessor is already gone */
  }

  const file = resolveDataFile(config.file)
  const maxItems = Number.isFinite(config.maxItems) ? config.maxItems : 500
  const store = createTodoStore({ file, maxItems })

  /** Open SSE responses. `null` means no panel is watching. */
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
    'todo-list: instance cleanup',
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
        path: `${ROUTE_BASE}/add`,
        handler: mutation((body) => store.add(body.text)),
      },
      {
        path: `${ROUTE_BASE}/toggle`,
        handler: mutation((body) => {
          store.toggle(body.id, typeof body.done === 'boolean' ? body.done : undefined)
        }),
      },
      {
        path: `${ROUTE_BASE}/update`,
        handler: mutation((body) => store.update(body.id, body.text)),
      },
      {
        path: `${ROUTE_BASE}/remove`,
        handler: mutation((body) => store.remove(body.id)),
      },
      {
        path: `${ROUTE_BASE}/clear-done`,
        handler: mutation(() => store.clearDone()),
      },
    ]

    for (const route of routes) {
      webCtx.effect(
        () => webCtx.webServer.register({ kind: 'exact', path: route.path, handler: route.handler }),
        `todo-list: route ${route.path}`,
      )
    }
  })

  // --- Agent tool ----------------------------------------------------------
  // Same store, so the chat and the panel share one list. `todo_write` is the
  // agent's own plan and stays untouched.
  ctx.inject(['tools'], (toolCtx) => {
    const summary = (value) => {
      const items = Array.isArray(value?.items) ? value.items : []
      const counts = value?.counts ?? { total: 0, active: 0, done: 0 }
      // `position` is the item's place in the full list, so a filtered call
      // still prints numbers `todo` can address on the next call.
      const lines = items.map((item, index) => {
        const position = Number.isFinite(item.position) ? item.position : index + 1
        return `${position}. ${item.done ? '[x]' : '[ ]'} ${item.text}`
      })
      const note = typeof value?.note === 'string' && value.note !== '' ? `注意：${value.note}` : null
      return [
        `待办 ${counts.active} 项未完成 / 共 ${counts.total} 项`,
        ...(lines.length > 0 ? lines : ['（清单是空的）']),
        note,
      ]
        .filter((line) => line !== null)
        .join('\n')
    }

    toolCtx.effect(
      () =>
        toolCtx.tools.register({
          name: 'todo',
          description:
            '用户的**个人待办清单**（Web 左侧栏「待办」面板）：list 查看、add 添加、done/undone 勾选完成、remove 删除、clear-done 清除已完成。' +
            '面板与这里共用同一份数据。它和你的 `todo_write` 计划是两回事：`todo_write` 是本轮执行计划，`todo` 是用户自己的清单。' +
            '`id` 可传完整 id，也可传 list 输出里的序号（1 开始；按状态过滤时序号仍是整张清单里的位置）。',
          parameters: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['list', 'add', 'done', 'undone', 'remove', 'clear-done'],
                description: '要执行的动作',
              },
              text: { type: 'string', description: 'add 的待办内容；单条，最长 500 字' },
              id: { type: 'string', description: 'done/undone/remove 的目标：完整 id 或列表序号（1 开始）' },
              status: {
                type: 'string',
                enum: ['all', 'active', 'done'],
                description: 'list 的过滤条件，默认 all',
              },
            },
            required: ['action'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', additionalProperties: true, properties: {} },
            render: (_args, value) => [{ type: 'text', text: summary(value) }],
          },
          async execute(args) {
            const action = typeof args?.action === 'string' ? args.action : 'list'
            if (action === 'add') store.add(args?.text)
            else if (action === 'done') store.toggle(args?.id, true)
            else if (action === 'undone') store.toggle(args?.id, false)
            else if (action === 'remove') store.remove(args?.id)
            else if (action === 'clear-done') store.clearDone()
            else if (action !== 'list') throw new Error(`未知 action: ${action}`)

            const snapshot = store.snapshot()
            snapshot.items = snapshot.items.map((item, index) => ({ ...item, position: index + 1 }))
            const status = args?.status
            if (action === 'list' && (status === 'active' || status === 'done')) {
              snapshot.items = snapshot.items.filter((item) => (status === 'done' ? item.done : !item.done))
            }
            return snapshot
          },
        }),
      'todo-list: tool',
    )
  })

  // Every Session gets the one-line pointer; the tool schema carries the rest.
  ctx.inject(['systemPrompt'], (promptCtx) => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.section({
          name: 'todo-list',
          order: 890,
          text: [
            '## 个人待办清单',
            '用户有一份全局待办清单（Web 左侧栏「待办」面板），用 `todo` 工具读写同一份数据：用户说「记一下」「加到待办」时用 `todo add`。',
            '它和你的 `todo_write` 计划是两回事：`todo_write` 是你本轮的执行计划，`todo` 是用户自己的清单。',
          ].join('\n'),
        }),
      'todo-list: prompt section',
    )
  })
}

function resolveDataFile(configured) {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : join(homedir(), '.dsh')
  if (typeof configured === 'string' && configured.trim() !== '') {
    const path = configured.trim()
    return isAbsolute(path) ? path : resolve(home, path)
  }
  return join(home, 'todo-list', 'todos.json')
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}
