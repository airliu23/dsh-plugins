/**
 * Host wiring regression test — no Harness, no browser, no real server.
 *
 *   node test/host-routes.mjs
 *
 * Builds the smallest Cordis context the plugin uses, opens a fake SSE panel,
 * then drives the routes and the `stand_reminder` tool across a virtual hour:
 * no window with no panel, a due frame right on time, a stale reminder that is
 * re-anchored instead of popping late, every ack path, settings, and the trust
 * gate.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../index.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-stand-host-'))
const file = join(dir, 'state.json')

let clock = Date.parse('2026-10-30T09:00:00+08:00')
const now = () => clock
const minutes = (value) => value * 60_000

const routes = new Map()
const tools = new Map()
const disposers = []
let rejection = null

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
    if (name === 'connection') return { requestRejection: () => rejection }
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

const parseFrames = (text) =>
  text
    .split('\n\n')
    .filter((block) => block.includes('\ndata: '))
    .map((block) => {
      const lines = block.split('\n')
      const event = (lines.find((line) => line.startsWith('event: ')) ?? 'event: message').slice(7)
      const data = lines
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n')
      let payload = null
      try {
        payload = JSON.parse(data)
      } catch {
        payload = data
      }
      return { event, payload }
    })

/** Open the SSE seat and keep every frame the Host writes to it. */
function connectSse() {
  const handler = routes.get('/plugins/stand-reminder/events')
  assert.ok(handler, 'the events route is missing')
  const chunks = []
  const req = new Readable({ read() {} })
  req.method = 'GET'
  req.url = '/plugins/stand-reminder/events'
  const res = {
    writeHead() {},
    write(chunk) {
      chunks.push(String(chunk))
      return true
    },
    end() {},
    on() {},
  }
  Promise.resolve(handler(req, res)).catch((error) => {
    throw error
  })
  return {
    frames() {
      return parseFrames(chunks.join(''))
    },
    take() {
      const parsed = parseFrames(chunks.join(''))
      chunks.length = 0
      return parsed
    },
    close() {
      req.emit('close')
    },
  }
}

const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))
const failures = []
function check(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) failures.push(label)
}

try {
  apply(ctx, {
    file,
    intervalMinutes: 60,
    breakSeconds: 120,
    snoozeMinutes: 10,
    tickMs: 30,
    now,
  })

  for (const path of [
    '/plugins/stand-reminder/state',
    '/plugins/stand-reminder/events',
    '/plugins/stand-reminder/ack',
    '/plugins/stand-reminder/settings',
    '/plugins/stand-reminder/remind',
  ]) {
    check(`route ${path}`, routes.has(path))
  }
  check('stand_reminder tool registered', tools.has('stand_reminder'))

  // --- initial state ------------------------------------------------------
  let response = await call('/plugins/stand-reminder/state')
  check('state is readable', response.status === 200 && response.payload.enabled === true)
  check('the first reminder is one interval out', response.payload.nextDueAt === clock + minutes(60))
  check('state reports the Host clock', response.payload.serverNow === clock)

  // --- no panel, no window ------------------------------------------------
  clock += minutes(61)
  await settle()
  response = await call('/plugins/stand-reminder/state')
  check('a due moment is kept while no panel is open', response.payload.nextDueAt === Date.parse('2026-10-30T10:00:00+08:00'), response.payload.nextDueAt)
  check('no reminder fired without a panel', response.payload.dueAt === null)

  // --- a panel connects: the due moment is shown --------------------------
  const panel = connectSse()
  await settle(40)
  let frames = panel.take()
  let due = frames.find((frame) => frame.event === 'due')
  check('a panel gets the reminder on its first tick', due !== undefined)
  check('the due frame carries the fire time', due?.payload?.at === clock, due?.payload?.at)
  response = await call('/plugins/stand-reminder/state')
  check('the schedule advanced by one interval', response.payload.nextDueAt === clock + minutes(60))
  check('the fire time is recorded', response.payload.dueAt === clock)

  // --- stood: break first, then a full hour -------------------------------
  response = await call('/plugins/stand-reminder/ack', { method: 'POST', body: { action: 'stood', breakSeconds: 120 } })
  check('stood is accepted', response.status === 200 && response.payload.today.stands === 1)
  check('stood starts the next hour after the break', response.payload.nextDueAt === clock + minutes(2) + minutes(60))
  check('stood is pushed to the panel', panel.take().some((frame) => frame.event === 'state'))

  // --- snooze / skip ------------------------------------------------------
  response = await call('/plugins/stand-reminder/ack', { method: 'POST', body: { action: 'snooze', minutes: 3 } })
  check('snooze waits the requested time', response.payload.nextDueAt === clock + minutes(3))
  check('snooze is marked in the state', response.payload.snoozedUntil === clock + minutes(3))
  response = await call('/plugins/stand-reminder/ack', { method: 'POST', body: { action: 'skip' } })
  check('skip restarts a full interval', response.payload.nextDueAt === clock + minutes(60))
  check('skip clears the snooze marker', response.payload.snoozedUntil === null)

  // --- settings -----------------------------------------------------------
  response = await call('/plugins/stand-reminder/settings', { method: 'POST', body: { intervalMinutes: 30 } })
  check('interval is applied', response.payload.settings.intervalMinutes === 30)
  check('a new interval restarts the countdown', response.payload.nextDueAt === clock + minutes(30))
  response = await call('/plugins/stand-reminder/settings', { method: 'POST', body: { enabled: false } })
  check('disable clears the schedule', response.payload.enabled === false && response.payload.nextDueAt === null)

  clock += minutes(45)
  await settle()
  check('disabled never fires', panel.take().every((frame) => frame.event !== 'due'))
  response = await call('/plugins/stand-reminder/settings', { method: 'POST', body: { enabled: true } })
  check('re-enable schedules one interval out', response.payload.nextDueAt === clock + minutes(30))

  // --- due again ----------------------------------------------------------
  clock += minutes(31)
  await settle()
  frames = panel.take()
  check('the second reminder fires', frames.some((frame) => frame.event === 'due'))

  // --- stale reminder is dropped, not shown late --------------------------
  response = await call('/plugins/stand-reminder/state')
  clock += minutes(30) + minutes(11)
  await settle()
  frames = panel.take()
  check('a reminder more than 10 minutes late is dropped', frames.every((frame) => frame.event !== 'due'))
  response = await call('/plugins/stand-reminder/state')
  check('the dropped reminder is re-anchored', response.payload.nextDueAt === clock + minutes(30))

  // --- the tool -----------------------------------------------------------
  const tool = tools.get('stand_reminder')
  let value = await tool.execute({ action: 'status' })
  check('status returns the schedule', value.enabled === true)
  let text = tool.output.render({}, value)[0].text
  check('status renders a Chinese summary', text.includes('久坐提醒') && text.includes('每 30 分钟一次'), text.split('\n')[0])

  value = await tool.execute({ action: 'snooze', minutes: 5 })
  check('the tool can snooze', value.nextDueAt === clock + minutes(5))
  value = await tool.execute({ action: 'skip' })
  check('the tool can skip', value.nextDueAt === clock + minutes(30))
  value = await tool.execute({ action: 'configure', intervalMinutes: 45, breakSeconds: 180, enabled: true })
  check('the tool can configure', value.settings.intervalMinutes === 45 && value.settings.breakSeconds === 180)
  await assert.rejects(() => tool.execute({ action: 'bogus' }), /未知 action/)
  // --- remind now ---------------------------------------------------------
  value = await tool.execute({ action: 'remind' })
  check('remind returns shown=true with a panel open', value.shown === true)
  text = tool.output.render({}, value)[0].text
  check('remind is reported', text.includes('已经在页面上弹出提醒'))
  check('remind pushes a due frame', panel.take().some((frame) => frame.event === 'due'))

  panel.close()
  value = await tool.execute({ action: 'remind' })
  check('remind reports when no panel is open', value.shown === false)
  text = tool.output.render({}, value)[0].text
  check('remind explains the closed panel', text.includes('GUI 页面当前没有打开'))

  // --- trust gate / method guard -----------------------------------------
  rejection = { status: 401 }
  response = await call('/plugins/stand-reminder/state')
  check('an unadmitted peer gets 401', response.status === 401)
  rejection = null
  response = await call('/plugins/stand-reminder/ack', { method: 'GET' })
  check('GET on a mutation route is 405', response.status === 405, response.status)
  response = await call('/plugins/stand-reminder/ack', { method: 'POST', body: { action: 'bogus' } })
  check('an unknown ack is 400', response.status === 400)

  console.log(failures.length === 0 ? 'host-routes.mjs: ok' : `host-routes.mjs: ${failures.length} failure(s)`)
} finally {
  const shutdown = globalThis[Symbol.for('dsh.stand-reminder.instance')]
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
process.exit(failures.length === 0 ? 0 : 1)
