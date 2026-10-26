/**
 * Headless test of the client half: automatic repaint AND auto-scroll.
 *
 * Three bugs are covered here, none of them visible without a DOM:
 *   1. `store.apply()` wrote bytes without notifying subscribers, so the panel
 *      only updated after a click.
 *   2. The auto-scroll effect depended on `state.streams`, an array mutated in
 *      place, so it ran once and the log never followed the newest line.
 *   3. When the tab is laid out with auto height the `pre` is not the scroll
 *      container — the column around it is — so pinning only the `pre` did
 *      nothing.
 *
 * The harness is a tiny React: hooks keep state across renders and `useEffect`
 * honours its dependency array, which is what made bug 2 invisible to a
 * "just call the component" test. Layout is faked both ways (bug 3).
 *
 *   node client-refresh.mjs
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
let total = 0
globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.includes('/poll')) {
    total += 80
    return {
      ok: true,
      status: 200,
      json: async () => ({
        manual: false,
        declared: [{ port: 'COM23', baud: 9600 }],
        diag: null,
        streams: [{ key: 'COM23@9600', port: 'COM23', baud: 9600, running: true, total, cursor: total, error: null, text: `[tx] ping ${total}\n` }],
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

// 1) Mount: no streams yet.
render()
await tick()
const text = render()
check('poll delivered text', text.includes('[tx] ping'), `polls delivered, subscriberCalls=${stats.subscriberCalls}`)
check('subscribers notified without a click', stats.subscriberCalls > 0)

// 2) Definite-height layout: the `pre` is the scroller and must sit at the end.
const first = cards[0]
check('scrolled to the newest line (pre scrolls)', first.atBottom, `scrollTop=${first.scrollTop} scrollHeight=${first.scrollHeight}`)

// 3) Scrolling up opts that card out.
first.scrollTop = 0
first.onScroll({ currentTarget: first })
await tick()
render()
check('stays put after scrolling up', first.scrollTop === 0, `scrollTop=${first.scrollTop}`)

// 4) Back at the bottom re-arms it.
first.scrollTop = first.scrollHeight - first.clientHeight
first.onScroll({ currentTarget: first })
await tick()
render()
check('follows again once scrolled back down', first.atBottom, `scrollTop=${first.scrollTop}`)

// 5) Auto-height layout: the `pre` cannot scroll, so the column must be pinned.
growMode = true
await tick()
render()
check('column pinned when the pre cannot scroll', listElement !== null && listElement.atBottom, `listScrollTop=${listElement?.scrollTop} scrollHeight=${listElement?.scrollHeight}`)

console.log(`renders=${stats.renders} subscriberCalls=${stats.subscriberCalls} effectRuns=${stats.effectRuns}`)
for (const dispose of disposers) if (typeof dispose === 'function') dispose()
process.exit(failures.length === 0 ? 0 : 1)
