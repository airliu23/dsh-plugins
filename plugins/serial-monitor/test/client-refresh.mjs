/**
 * Headless test of the client half: push-driven repaint AND auto-scroll.
 *
 * What is covered here, none of it visible without a DOM:
 *   1. Bytes arrive over the push stream (SSE) and repaint the panel — there
 *      is no data polling loop any more, so text must appear with `/poll` being
 *      called exactly once (the connect backfill).
 *   2. Bursts coalesce: thirty pushed lines must not cost thirty renders.
 *   3. The auto-scroll effect follows the newest line (it depends on the text
 *      lengths, not on the mutated `streams` array).
 *   4. Both layouts follow: a definite-height `pre` scrolls itself, an
 *      auto-height one leaves the scrolling to the column around it.
 *
 * The harness is a tiny React: hooks keep state across renders and `useEffect`
 * honours its dependency array, which is what made bug 3 invisible to a
 * "just call the component" test.
 *
 *   node test/client-refresh.mjs
 */
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

let definition = null
globalThis.window = { __ModuleLoader__: { load: (def) => (definition = def) } }

// ---------------------------------------------------------------- fake DOM
class FakeElement {
  constructor(tag) {
    this.tag = tag
    this._top = 0
    this.scrollHeight = 0
    this.clientHeight = tag === 'pre' ? 100 : 200
  }
  get scrollTop() {
    return this._top
  }
  set scrollTop(value) {
    const max = Math.max(0, this.scrollHeight - this.clientHeight)
    this._top = Math.min(Math.max(0, value), max)
  }
  get atBottom() {
    return this.scrollHeight - this._top - this.clientHeight <= 24
  }
}

/** growMode: the `pre` has no definite height, so the column is the scroller. */
let growMode = false
const cards = []
let listElement = null

// ---------------------------------------------------------------- fake React
let hookIndex = 0
const hooks = []
let pendingEffects = []
const stats = { renders: 0, subscriberCalls: 0, effectRuns: 0 }

const fakeReact = {
  createElement: (tag, props, ...children) => ({ tag, props: props ?? {}, children: children.flat(Infinity) }),
  useState(initial) {
    const slot = (hooks[hookIndex] ??= { kind: 'state', value: initial })
    hookIndex += 1
    const set = (update) => {
      stats.subscriberCalls += 1
      slot.value = typeof update === 'function' ? update(slot.value) : update
    }
    return [slot.value, set]
  },
  useEffect(fn, deps) {
    const slot = (hooks[hookIndex] ??= { kind: 'effect', deps: undefined })
    hookIndex += 1
    const same = Array.isArray(deps) && Array.isArray(slot.deps) && deps.length === slot.deps.length && deps.every((value, index) => Object.is(value, slot.deps[index]))
    if (Array.isArray(deps) && same) return
    slot.deps = deps
    pendingEffects.push(fn)
  },
  useRef(initial) {
    const slot = (hooks[hookIndex] ??= { kind: 'ref', ref: { current: initial } })
    hookIndex += 1
    return slot.ref
  },
}

// ------------------------------------------------------- fake EventSource
class FakeEventSource {
  static all = []
  constructor(url) {
    this.url = url
    this.readyState = 0
    this.listeners = new Map()
    FakeEventSource.all.push(this)
  }
  addEventListener(type, fn) {
    const list = this.listeners.get(type) ?? []
    list.push(fn)
    this.listeners.set(type, list)
  }
  close() {
    this.readyState = 2
  }
  /** Deliver one server frame; `payload` is JSON-encoded like a real stream. */
  fire(type, payload) {
    if (this.readyState === 2) return
    this.readyState = 1
    for (const fn of this.listeners.get(type) ?? []) fn({ data: payload === undefined ? undefined : JSON.stringify(payload) })
  }
}
globalThis.EventSource = FakeEventSource

const requireStub = (name) => {
  if (name === 'react') return fakeReact
  throw new Error(`unexpected require: ${name}`)
}

/** The plugin package root, one level above this test file. */
const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_PATH = process.env.CLIENT_PATH ?? join(PLUGIN, 'client.js')
await import(pathToFileURL(CLIENT_PATH).href)
if (definition === null) throw new Error('client.js did not call __ModuleLoader__.load')
const plugin = definition.factory(requireStub)

// ---------------------------------------------------------------- stub ctx
const registrations = new Map()
const disposers = []
const ctx = {
  effect(fn) {
    const dispose = fn()
    disposers.push(dispose)
    return () => dispose?.()
  },
  locale: { register: () => () => {}, bind: () => (key) => key },
  get: () => undefined,
  slots: {
    inject(_name, callback) {
      callback()
    },
    register(slot, component) {
      registrations.set(slot.name, { slot, component })
      return () => registrations.delete(slot.name)
    },
  },
}
plugin.apply(ctx)

const flatten = (node, out = []) => {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node))
    return out
  }
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out)
    return out
  }
  if (typeof node === 'object' && Array.isArray(node.children)) for (const child of node.children) flatten(child, out)
  return out
}

/** Commit: attach refs (stable fake nodes) and flush effects. */
function commit(tree) {
  let cardIndex = 0
  let listText = 0
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const child of node) walk(child)
      return
    }
    const text = flatten(node.children).join('')
    if (typeof node.props?.ref === 'function') {
      if (node.tag === 'pre') {
        const element = (cards[cardIndex] ??= new FakeElement('pre'))
        cardIndex += 1
        element.scrollHeight = growMode ? element.clientHeight : 32 + text.length * 8
        element.onScroll = node.props.onScroll
        listText = Math.max(listText, text.length)
        node.props.ref(element)
      } else if (node.props?.style?.overflow === 'auto') {
        listElement ??= new FakeElement('div')
        node.props.ref(listElement)
      }
    }
    for (const child of node.children ?? []) walk(child)
  }
  walk(tree)
  if (listElement !== null) listElement.scrollHeight = 40 + listText * 8
  const effects = pendingEffects
  pendingEffects = []
  for (const effect of effects) {
    stats.effectRuns += 1
    effect()
  }
}

const bodyComponent = registrations.get('sidebar.right.pane.tab')?.component
if (bodyComponent === undefined) throw new Error('the panel body slot was not registered')

function render() {
  hookIndex = 0
  stats.renders += 1
  const tree = bodyComponent({})
  commit(tree)
  return flatten(tree).join(' | ')
}

// ---------------------------------------------------------------- fake backend
// `/poll` carries no text: every byte in this test must come from the push
// stream, which is exactly the property under test.
let pollCalls = 0
const KEY = 'COM23@9600'
globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.includes('/poll')) {
    pollCalls += 1
    return {
      ok: true,
      status: 200,
      json: async () => ({
        manual: false,
        declared: [{ port: 'COM23', baud: 9600 }],
        diag: null,
        streams: [{ key: KEY, port: 'COM23', baud: 9600, running: true, total: 0, cursor: 0, error: null, text: '' }],
      }),
    }
  }
  if (target.includes('/ports')) return { ok: true, status: 200, json: async () => ({ ports: [{ device: 'COM23', description: 'CH341', hwid: '' }], declared: [] }) }
  return { ok: true, status: 200, json: async () => ({ ok: true }) }
}

const failures = []
const check = (label, condition, detail) => {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) failures.push(label)
}
const tick = (ms = 700) => new Promise((resolve) => setTimeout(resolve, ms))

// 1) Mount: the panel opens the push stream and backfills once.
render()
const source = FakeEventSource.all.at(-1)
check('opened one push stream', FakeEventSource.all.length === 1 && source?.url.endsWith('/events'), source?.url)
source.fire('open')
await tick(150)
render()
check('connect backfill fetched once', pollCalls === 1, `pollCalls=${pollCalls}`)

// 2) Bytes arrive over the stream: text shows up, polling stays at one call.
let total = 0
const push = (text) => {
  total += text.length
  source.fire('data', { key: KEY, text, total })
}
push('[tx] hello\n')
await tick(80)
let text = render()
check('pushed text renders without polling', text.includes('[tx] hello'))
check('no recurring poll', pollCalls === 1, `pollCalls=${pollCalls}`)

// 3) A burst of lines coalesces into one repaint per window.
const before = stats.subscriberCalls
for (let index = 0; index < 30; index += 1) push(`[tx] line ${index}\n`)
await tick(80)
text = render()
const repaints = stats.subscriberCalls - before
check('burst of 30 pushes repaints at most twice', repaints <= 2, `${repaints} repaints`)
check('every pushed line is present', text.includes('[tx] line 29'))

// 4) Definite-height layout: the `pre` is the scroller and must sit at the end.
const first = cards[0]
check('scrolled to the newest line (pre scrolls)', first.atBottom, `scrollTop=${first.scrollTop} scrollHeight=${first.scrollHeight}`)

// 5) Scrolling up opts that card out.
first.scrollTop = 0
first.onScroll({ currentTarget: first })
push('[tx] while reading up\n')
await tick(80)
render()
check('stays put after scrolling up', first.scrollTop === 0, `scrollTop=${first.scrollTop}`)

// 6) Back at the bottom re-arms it.
first.scrollTop = first.scrollHeight - first.clientHeight
first.onScroll({ currentTarget: first })
push('[tx] back at the bottom\n')
await tick(80)
render()
check('follows again once scrolled back down', first.atBottom, `scrollTop=${first.scrollTop}`)

// 7) Auto-height layout: the `pre` cannot scroll, so the column must be pinned.
growMode = true
push('[tx] tall column\n')
await tick(80)
render()
check('column pinned when the pre cannot scroll', listElement !== null && listElement.atBottom, `listScrollTop=${listElement?.scrollTop} scrollHeight=${listElement?.scrollHeight}`)

// 8) A closed stream disappears on the pushed `gone` frame.
source.fire('gone', { key: KEY })
await tick(40)
text = render()
check('gone frame drops the row', text.includes('idle') && !text.includes('line 29'), text.slice(0, 60))

console.log(`renders=${stats.renders} subscriberCalls=${stats.subscriberCalls} effectRuns=${stats.effectRuns} pollCalls=${pollCalls}`)
for (const dispose of disposers) if (typeof dispose === 'function') dispose()
process.exit(failures.length === 0 ? 0 : 1)
