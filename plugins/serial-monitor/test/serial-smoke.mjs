/**
 * Bounded smoke test for the serial-monitor Host half.
 *
 * The split under test: **the user owns the ports** (HTTP routes, driven by the
 * panel) and **the session only reads** (tool actions status/read/wait/mark/
 * ports). The tool must refuse every lifecycle action.
 *
 *   node test/serial-smoke.mjs
 */
import { Readable } from 'node:stream'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The plugin package root, one level above this test file. */
const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
/** Kept inside the package (and gitignored) so it never touches the live state. */
const STATE_DIR = join(PLUGIN, 'test', '.state')

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
  autoStart: false,
  ringChars: 200000,
  // Separate lock/state directory: the harness must not clobber the live
  // plugin's declared list.
  stateDir: STATE_DIR,
})

function makeReq({ method = 'GET', url = '/', body = null }) {
  const req = new Readable({ read() {} })
  req.method = method
  req.url = url
  req.headers = {}
  if (body !== null) req.push(Buffer.from(JSON.stringify(body)))
  req.push(null)
  return req
}

function makeRes() {
  return {
    status: 0,
    body: '',
    writeHead(status) {
      this.status = status
    },
    end(body) {
      this.body = body ?? ''
    },
  }
}

async function call(path, options = {}) {
  const routePath = path.split('?')[0]
  const handler = routes.get(`/plugins/serial-monitor${routePath}`)
  if (handler === undefined) throw new Error(`no route for ${routePath}`)
  const res = makeRes()
  await handler(makeReq({ url: `/plugins/serial-monitor${path}`, ...options }), res)
  return { status: res.status, body: JSON.parse(res.body || 'null') }
}

const tool = (args) => tools.get('serial_monitor').execute(args, {})
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const post = (path, body) => call(path, { method: 'POST', body })

const OPEN_ONCE = `
import serial
try:
    handle = serial.Serial("COM23", 9600, timeout=0.2)
    data = handle.read(64)
    handle.close()
    print("port free, bytes:", len(data))
except Exception as exc:
    print("port busy:", exc)
`

const failures = []
const check = (label, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) failures.push(label)
}

// --- the session's vocabulary is read-only -------------------------------
const schema = tools.get('serial_monitor').parameters.properties.action.enum
check('tool vocabulary is read-only', JSON.stringify(schema) === JSON.stringify(['status', 'read', 'wait', 'mark', 'ports']), schema.join('/'))
for (const action of ['watch', 'add', 'remove', 'pause', 'resume']) {
  const refused = await tool({ action, streams: [{ port: 'COM23', baud: 9600 }], port: 'COM23', baud: 9600, key: 'COM23@9600' })
  check(`tool refuses ${action}`, typeof refused.note === 'string' && refused.note.includes('会话不能开关串口'), refused.note)
}
const afterRefusals = await call('/status')
check('refused actions opened nothing', afterRefusals.body.streams.length === 0, `streams=${afterRefusals.body.streams.length}`)

// --- the user's path: panel routes open and close captures ---------------
const opened = await post('/watch', { streams: [{ port: 'COM23', baud: 9600 }] })
check('panel opens a port', opened.body.streams.length === 1, `streams=${opened.body.streams.map((stream) => stream.key).join(',')}`)

// --- the session reads the same bytes ------------------------------------
const waited = await tool({ action: 'wait', pattern: '[tx]', timeoutMs: 8000 })
check('session wait sees the data', waited.matched === true, `${waited.waitedMs} ms`)

const read = await tool({ action: 'read', target: 'COM23@9600', sinceLast: true, tailChars: 200 })
check('session read returns bytes', (read.streams[0]?.total ?? 0) > 0, `${read.streams[0]?.total} B`)

const status = await tool({ action: 'status' })
check('status reports the user-owned list', JSON.stringify(status.declared) === JSON.stringify([{ port: 'COM23', baud: 9600 }]), JSON.stringify(status.declared))

const listed = await tool({ action: 'ports' })
check('ports only lists names', Array.isArray(listed.ports) && listed.ports.every((port) => typeof port.device === 'string'), `${listed.ports.length} ports`)
check('ports opened nothing new', (await call('/status')).body.streams.length === 1)

// --- only the user releases the port -------------------------------------
await post('/stop')
await sleep(600)
const freed = await new Promise((resolve) => {
  const child = spawn('python', ['-c', OPEN_ONCE], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    out += chunk
  })
  child.on('exit', () => resolve(out.trim()))
})
check('panel stop releases the port', freed.startsWith('port free'), freed)

const resumed = await post('/resume')
check('panel resume reopens the same list', resumed.body.streams.length === 1, `streams=${resumed.body.streams.length}`)

const removed = await post('/remove', { key: 'COM23@9600' })
check('panel remove closes one stream', removed.body.streams.length === 0)
check('declared list follows the user', removed.body.declared.length === 0, JSON.stringify(removed.body.declared))

// --- poll route still serves the panel ----------------------------------
const polled = await call('/poll?since=')
check('poll route answers', polled.status === 200)

await post('/stop')
for (const dispose of disposers) {
  try {
    dispose()
  } catch {
    /* ignore */
  }
}
console.log(failures.length === 0 ? '\nALL PASS' : `\n${failures.length} FAILED`)
process.exit(failures.length === 0 ? 0 : 1)
