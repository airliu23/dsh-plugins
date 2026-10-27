/**
 * Push-transport test for the serial-monitor Host half — no hardware.
 *
 * The sidecar is replaced by `fake-sidecar.py`, which emits the same NDJSON
 * protocol, so this exercises the real chain:
 *
 *   spawn → stdout parse → ring buffer → SSE frame → tool read
 *
 * What it proves, in order:
 *   1. connecting to `/events` sends a snapshot immediately;
 *   2. received bytes are pushed as `data` frames with no poll involved;
 *   3. a burst is coalesced instead of one frame per line;
 *   4. stopping a stream publishes `gone` (and `meta` for the list);
 *   5. the session still reads the very same bytes through the tool.
 *
 *   node test/push-flow.mjs
 */
import { mkdirSync, rmSync } from 'node:fs'
import { Readable } from 'node:stream'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATE_DIR = join(PLUGIN, 'test', '.state-push')

rmSync(STATE_DIR, { recursive: true, force: true })
mkdirSync(STATE_DIR, { recursive: true })

const { apply } = await import(pathToFileURL(join(PLUGIN, 'index.js')).href)

const routes = new Map()
const tools = new Map()
const disposers = []

const stubCtx = {
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return () => dispose?.()
  },
  inject(_deps, callback) {
    callback(stubCtx)
  },
  get(name) {
    if (name === 'connection') return { requestRejection: () => undefined }
    return undefined
  },
  tools: {
    register(definition) {
      tools.set(definition.name, definition)
      return () => tools.delete(definition.name)
    },
  },
  systemPrompt: { section: () => () => {} },
  webServer: {
    register(route) {
      routes.set(route.path, route.handler)
      return () => routes.delete(route.path)
    },
  },
}

apply(stubCtx, {
  pythonPath: 'python',
  sidecarPath: join(PLUGIN, 'test', 'fake-sidecar.py'),
  autoStart: false,
  ringChars: 100_000,
  stateDir: STATE_DIR,
})

function makeReq({ method = 'GET', url = '/', body = null }) {
  const req = new Readable({ read() {} })
  req.method = method
  req.url = url
  req.headers = {}
  req.push(body === null ? null : Buffer.from(JSON.stringify(body)))
  if (body !== null) req.push(null)
  return req
}

function makeRes() {
  return {
    status: 0,
    body: '',
    headers: {},
    ended: false,
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    write(chunk) {
      this.body += chunk
      return true
    },
    end(body) {
      this.ended = true
      this.body += body ?? ''
    },
    on() {
      return this
    },
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function post(path, body) {
  const handler = routes.get(`/plugins/serial-monitor${path}`)
  const res = makeRes()
  await handler(makeReq({ method: 'POST', url: `/plugins/serial-monitor${path}`, body: body ?? {} }), res)
  return { status: res.status, body: JSON.parse(res.body || 'null') }
}

const frames = (text, name) => (text.match(new RegExp(`event: ${name}`, 'g')) ?? []).length

const failures = []
const check = (label, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) failures.push(label)
}

// --- the panel opens a (synthetic) port ----------------------------------
const opened = await post('/watch', { streams: [{ port: 'COM1', baud: 9600 }] })
check('watch opened one stream', opened.body.streams.length === 1, `streams=${opened.body.streams.map((stream) => stream.key).join(',')}`)

// --- a push client connects ----------------------------------------------
const events = makeRes()
await routes.get('/plugins/serial-monitor/events')(makeReq({ url: '/plugins/serial-monitor/events' }), events)
const headers = String(events.headers['content-type'] ?? '')
check('snapshot on connect', events.body.includes('event: snapshot'))
check('stream content type', headers.startsWith('text/event-stream'), headers)

// --- bytes arrive on their own -------------------------------------------
await sleep(600)
const dataFrames = frames(events.body, 'data')
check('received bytes are pushed as data frames', dataFrames > 0, `${dataFrames} frames`)
check('frames carry the bytes', /event: data\ndata: \{"key":"COM1@9600","text":"\[tx\] line \d+/.test(events.body))
check('a burst is coalesced, not one frame per line', dataFrames < 20, `${dataFrames} frames for ~30 lines`)

// --- the session reads the same bytes ------------------------------------
const tool = tools.get('serial_monitor')
const read = await tool.execute({ action: 'read', target: 'COM1@9600', tailChars: 200 }, {})
check('session tool reads the pushed bytes', (read.streams?.[0]?.text ?? '').includes('[tx] line'), `${read.streams?.[0]?.total} B`)

// --- stopping a stream pushes `gone` -------------------------------------
await post('/stop')
const afterStop = dataFrames
await sleep(300)
check('stop pushes meta and gone', frames(events.body, 'meta') >= 1 && frames(events.body, 'gone') >= 1, `meta=${frames(events.body, 'meta')} gone=${frames(events.body, 'gone')}`)
check('no bytes are pushed after stop', frames(events.body, 'data') === afterStop, `${frames(events.body, 'data')} frames`)

// --- resume re-opens and pushes again ------------------------------------
await post('/resume')
const afterResume = frames(events.body, 'data')
await sleep(400)
check('resume streams again', frames(events.body, 'data') > afterResume, `${frames(events.body, 'data') - afterResume} new frames`)

// --- the client goes away; the host keeps running ------------------------
const gone = makeRes()
await routes.get('/plugins/serial-monitor/events')(makeReq({ url: '/plugins/serial-monitor/events' }), gone)
await post('/stop')
for (const dispose of disposers) {
  try {
    dispose()
  } catch {
    /* ignore */
  }
}
rmSync(STATE_DIR, { recursive: true, force: true })
console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
