/**
 * Throughput test: a burst, not a trickle.
 *
 * At 1.5 Mbaud a firmware dump arrives as a sustained flood, and that is where
 * the old pipeline lost data: the flat ring buffer re-sliced itself on every
 * append, while the sidecar's single thread sat behind the JSON encoder and a
 * stdout pipe. This test pushes a fake 2 MB burst through the real chain
 * (spawn → NDJSON → ring → SSE → tool) and asserts that nothing is lost.
 *
 *   node test/burst-flow.mjs
 */
import { mkdirSync, rmSync } from 'node:fs'
import { Readable } from 'node:stream'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STATE_DIR = join(PLUGIN, 'test', '.state-burst')
const BURST_BYTES = 2_000_000
/** Small on purpose: the ring must trim, and the counters must still add up. */
const RING_CHARS = 200_000

rmSync(STATE_DIR, { recursive: true, force: true })
mkdirSync(STATE_DIR, { recursive: true })
process.env.FAKE_BURST_BYTES = String(BURST_BYTES)

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
  ringChars: RING_CHARS,
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
    writeHead(status, headers) {
      this.status = status
      this.headers = headers ?? {}
    },
    write(chunk) {
      this.body += chunk
      return true
    },
    end(body) {
      this.body += body ?? ''
    },
    on() {
      return this
    },
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

async function status() {
  const res = makeRes()
  await routes.get('/plugins/serial-monitor/status')(makeReq({ url: '/plugins/serial-monitor/status' }), res)
  return JSON.parse(res.body)
}

const failures = []
const check = (label, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) failures.push(label)
}

const started = Date.now()
const opened = makeRes()
await routes.get('/plugins/serial-monitor/watch')(
  makeReq({ method: 'POST', url: '/plugins/serial-monitor/watch', body: { streams: [{ port: 'COM1', baud: 1_500_000 }] } }),
  opened,
)
check('watch opened the burst stream', JSON.parse(opened.body).streams.length === 1)

// A push client is attached so the SSE path itself rides the burst.
const events = makeRes()
await routes.get('/plugins/serial-monitor/events')(makeReq({ url: '/plugins/serial-monitor/events' }), events)

// Wait until the whole burst has been accounted for by the sidecar.
let state = {}
for (let attempt = 0; attempt < 200; attempt += 1) {
  await sleep(100)
  state = (await status()).streams?.[0] ?? {}
  if (state.portBytes >= BURST_BYTES) break
}
const elapsed = Date.now() - started

check('burst reached the sidecar', state.portBytes >= BURST_BYTES, `portBytes=${state.portBytes}`)
check('every byte became a character', state.total === state.portBytes, `chars=${state.total} wire=${state.portBytes}`)
check('ring trimmed as designed', state.total > RING_CHARS, `total=${state.total} ring=${RING_CHARS}`)
check('burst kept up with the wire', elapsed < 20_000, `${elapsed} ms for ${state.portBytes} bytes`)

const tool = tools.get('serial_monitor')
const tail = await tool.execute({ action: 'read', target: 'COM1@1500000', tailChars: 400 }, {})
check('session reads the tail of the burst', (tail.streams?.[0]?.text ?? '').includes('[tx]'), `${tail.streams?.[0]?.total} B`)
check('session sees the wire count', (tail.streams?.[0]?.portBytes ?? 0) >= BURST_BYTES, `portBytes=${tail.streams?.[0]?.portBytes}`)

// The push stream saw the same bytes, coalesced into far fewer frames.
const dataFrames = (events.body.match(/event: data/g) ?? []).length
check('push stream carried the burst', events.body.includes('[tx]'), `${dataFrames} frames for ${BURST_BYTES} bytes`)
check('burst is coalesced', dataFrames < 1_000, `${dataFrames} frames`)

await routes.get('/plugins/serial-monitor/stop')(makeReq({ method: 'POST', url: '/plugins/serial-monitor/stop', body: {} }), makeRes())
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
