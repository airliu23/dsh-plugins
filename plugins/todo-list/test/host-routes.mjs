/**
 * Host wiring regression test — no Harness, no browser, no real server.
 *
 *   node test/host-routes.mjs
 *
 * Builds the smallest Cordis context the plugin uses, then drives the HTTP
 * routes and the `todo` tool exactly as the panel and the agent would.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../index.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-todo-host-'))
const file = join(dir, 'todos.json')

const routes = new Map()
const tools = new Map()
const disposers = []

function scoped(name) {
  return {
    effect(fn) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    get() {
      return undefined
    },
    webServer: {
      register(route) {
        assert.equal(name, 'webServer')
        routes.set(route.path, route.handler)
        return () => routes.delete(route.path)
      },
    },
    tools: {
      register(definition) {
        assert.equal(name, 'tools')
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    systemPrompt: {
      section() {
        assert.equal(name, 'systemPrompt')
        return () => {}
      },
    },
  }
}

const ctx = {
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  get(name) {
    // Admitted peer: the routes' trust gate must let the panel through.
    if (name === 'connection') return { requestRejection: () => null }
    return undefined
  },
  inject(names, callback) {
    callback(scoped(names[0]))
  },
}

function call(path, { method = 'GET', body } = {}) {
  const handler = routes.get(path)
  assert.ok(handler, `route not registered: ${path}`)
  return new Promise((resolve, reject) => {
    const chunks = []
    const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))])
    req.method = method
    req.url = path
    const res = {
      statusCode: 0,
      writeHead(status) {
        this.statusCode = status
        return this
      },
      write(chunk) {
        chunks.push(chunk)
        return true
      },
      end(chunk) {
        if (chunk !== undefined) chunks.push(chunk)
        const text = chunks.map((part) => String(part)).join('')
        let payload = null
        try {
          payload = JSON.parse(text)
        } catch {
          /* SSE frames are not JSON responses */
        }
        resolve({ status: this.statusCode, text, payload })
      },
    }
    Promise.resolve(handler(req, res)).catch(reject)
  })
}

try {
  apply(ctx, { file, maxItems: 20 })

  // Every route the client calls exists, and the SSE seat is claimed too.
  for (const path of [
    '/plugins/todo-list/state',
    '/plugins/todo-list/events',
    '/plugins/todo-list/add',
    '/plugins/todo-list/toggle',
    '/plugins/todo-list/update',
    '/plugins/todo-list/remove',
    '/plugins/todo-list/clear-done',
  ]) {
    assert.ok(routes.has(path), `missing route ${path}`)
  }
  assert.ok(tools.has('todo'), 'todo tool not registered')

  // --- empty read ---------------------------------------------------------
  let response = await call('/plugins/todo-list/state')
  assert.equal(response.status, 200)
  assert.equal(response.payload.items.length, 0)
  assert.equal(response.payload.file, file)

  // --- add / validation ---------------------------------------------------
  response = await call('/plugins/todo-list/add', { method: 'POST', body: { text: '  写周报  ' } })
  assert.equal(response.status, 200)
  assert.equal(response.payload.items[0].text, '写周报')
  const firstId = response.payload.items[0].id

  response = await call('/plugins/todo-list/add', { method: 'POST', body: { text: '   ' } })
  assert.equal(response.status, 400)
  assert.match(response.payload.error, /不能为空/)

  response = await call('/plugins/todo-list/state', { method: 'POST' })
  assert.equal(response.status, 405)

  // --- toggle / update / remove -------------------------------------------
  response = await call('/plugins/todo-list/toggle', { method: 'POST', body: { id: firstId } })
  assert.equal(response.payload.items[0].done, true)
  assert.deepEqual(response.payload.counts, { total: 1, active: 0, done: 1 })

  response = await call('/plugins/todo-list/update', { method: 'POST', body: { id: firstId, text: '周五前交周报' } })
  assert.equal(response.payload.items[0].text, '周五前交周报')

  response = await call('/plugins/todo-list/toggle', { method: 'POST', body: { id: firstId, done: false } })
  assert.equal(response.payload.items[0].done, false)

  response = await call('/plugins/todo-list/toggle', { method: 'POST', body: { id: 'nope' } })
  assert.equal(response.status, 400)
  assert.match(response.payload.error, /找不到/)

  // --- tool: add, list, done ----------------------------------------------
  const tool = tools.get('todo')
  assert.equal(tool.name, 'todo')

  let toolValue = await tool.execute({ action: 'add', text: '回邮件' })
  assert.equal(toolValue.items[0].text, '回邮件')
  toolValue = await tool.execute({ action: 'list' })
  assert.deepEqual(
    toolValue.items.map((item) => item.text),
    ['回邮件', '周五前交周报'],
  )
  toolValue = await tool.execute({ action: 'list', status: 'active' })
  assert.ok(toolValue.items.every((item) => !item.done))

  toolValue = await tool.execute({ action: 'done', id: '2' })
  assert.equal(toolValue.items[1].done, true)
  assert.match(tool.output.render({}, toolValue)[0].text, /待办 1 项未完成 \/ 共 2 项/)
  assert.match(tool.output.render({}, toolValue)[0].text, /2\. \[x\] 周五前交周报/)

  // A filtered list keeps the full-list position, so the printed number still
  // addresses the right item on the next call.
  toolValue = await tool.execute({ action: 'list', status: 'active' })
  assert.equal(toolValue.items.length, 1)
  assert.equal(toolValue.items[0].position, 1)
  assert.match(tool.output.render({}, toolValue)[0].text, /1\. \[ \] 回邮件/)
  toolValue = await tool.execute({ action: 'list', status: 'done' })
  assert.equal(toolValue.items.length, 1)
  assert.equal(toolValue.items[0].position, 2)
  assert.match(tool.output.render({}, toolValue)[0].text, /2\. \[x\] 周五前交周报/)

  // --- clear done, then persist on disk -----------------------------------
  toolValue = await tool.execute({ action: 'clear-done' })
  assert.equal(toolValue.counts.done, 0)
  response = await call('/plugins/todo-list/remove', { method: 'POST', body: { id: toolValue.items[0].id } })
  assert.equal(response.payload.items.length, 0)
  assert.ok(existsSync(file), 'list should be persisted')

  await assert.rejects(() => tool.execute({ action: 'bogus' }), /未知 action/)

  console.log('host-routes.mjs: ok')
} finally {
  const shutdown = globalThis[Symbol.for('dsh.todo-list.instance')]
  if (typeof shutdown === 'function') shutdown()
  for (const dispose of disposers.reverse()) {
    try {
      dispose()
    } catch {
      /* already disposed */
    }
  }
  rmSync(dir, { recursive: true, force: true })
}
