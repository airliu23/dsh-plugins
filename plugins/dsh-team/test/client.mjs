/**
 * Client wiring regression — fake module loader, fake React, no browser.
 *
 *   node test/client.mjs
 *
 * Covers the parts that break first in a browser: the module registers under
 * the right id, `apply` fills the three slots, and the board renders the
 * snapshot the Host returns (including the ticket title and report).
 */
import assert from 'node:assert/strict'

let factory = null
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
  __ModuleLoader__: {
    load({ id, factory: fn }) {
      assert.equal(id, '@local/dsh-team')
      factory = fn
    },
  },
}

// --- a React shim: elements are plain objects, effects run once ------------
const effects = []
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
  useState(initial) {
    return [typeof initial === 'function' ? initial() : initial, () => {}]
  },
  useEffect(fn) {
    const cleanup = fn()
    if (typeof cleanup === 'function') effects.push(cleanup)
  },
  useMemo(fn) {
    return fn()
  },
  useRef(value) {
    return { current: value }
  },
  useCallback(fn) {
    return fn
  },
  Fragment: 'fragment',
}

const require = (name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
}

await import('../client.js')
assert.equal(typeof factory, 'function', 'client.js 必须向 __ModuleLoader__ 注册')
const mod = factory(require)
assert.deepEqual(mod.inject, ['slots', 'locale'])

// --- the Host snapshot the panel will show --------------------------------
const snapshot = {
  note: null,
  version: 3,
  counts: { queued: 1, running: 1, done: 1, failed: 1, canceled: 0 },
  tickets: [
    {
      id: 't-aaaa1111',
      title: '分析 RX 协议',
      state: 'done',
      createdAt: 1_700_000_000_000,
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_150_000,
      report: '结论：状态机表与 def 不一致',
      error: '',
      outDir: '/home/airliu/.dsh/dsh-team/outbox/t-aaaa1111',
    },
    {
      id: 't-bbbb2222',
      title: '跑门禁',
      state: 'failed',
      createdAt: 1_700_000_000_000,
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_060_000,
      report: '',
      error: 'worker 退出码 1',
      outDir: '/home/airliu/.dsh/dsh-team/outbox/t-bbbb2222',
    },
  ],
}

globalThis.fetch = async () => ({ ok: true, json: async () => snapshot })
globalThis.EventSource = class {
  addEventListener() {}
}

// --- apply() fills the slots ----------------------------------------------
const slots = new Map()
const dictionaries = []
const ctx = {
  effect(fn) {
    const cleanup = fn()
    if (typeof cleanup === 'function') effects.push(cleanup)
  },
  locale: {
    register(namespace, dict) {
      dictionaries.push({ namespace, dict })
    },
    bind() {
      // Same contract as the real binder: the zh dictionary wins, the key loses.
      return (key) => dictionaries[0]?.dict.zh[key] ?? key
    },
  },
  slots: {
    inject(_name, register) {
      register()
    },
    register(meta, component) {
      slots.set(meta.id, { meta, component })
    },
  },
}

mod.apply(ctx)

assert.deepEqual(
  [...slots.keys()].sort(),
  ['dsh-team', 'dsh-team-drawer', 'dsh-team-toggle'],
)
assert.equal(dictionaries.length, 1)
assert.equal(dictionaries[0].namespace, 'dsh-team')
assert.ok(dictionaries[0].dict.zh.title.length > 0)
assert.ok(dictionaries[0].dict.en.title.length > 0)

// --- render helpers -------------------------------------------------------
const render = (component) => component({})
const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node !== 'object') return ''
  if (node.type === 'style') return '' // CSS must not show up as content
  if (typeof node.type === 'function') return textOf(node.type(node.props)) // expand components
  return [textOf(node.children), textOf(node.props.children)].filter(Boolean).join(' ')
}
const find = (node, predicate) => {
  if (node === null || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = find(child, predicate)
      if (hit !== null) return hit
    }
    return null
  }
  if (predicate(node)) return node
  for (const child of [...(node.children ?? []), node.props?.children].flat()) {
    const hit = find(child, predicate)
    if (hit !== null) return hit
  }
  return null
}

// --- the drawer is closed until the toggle says otherwise -----------------
const toggle = slots.get('dsh-team-toggle').component
const drawer = slots.get('dsh-team-drawer').component

assert.equal(render(drawer), null, '默认收起')

const toggleTree = render(toggle)
const toggleButton = find(toggleTree, (node) => node.type === 'button')
assert.ok(toggleButton !== null)
toggleButton.props.onClick()

// Let the initial fetch land, then render the open drawer.
await new Promise((done) => setTimeout(done, 0))

const tree = render(drawer)
assert.ok(tree !== null, '点过开关后应当展开')
const text = textOf(tree)
assert.match(text, /后台工单/)
assert.match(text, /分析 RX 协议/, '完成工单的标题要出现在看板上')
assert.match(text, /跑门禁/)
assert.match(text, /worker =|One ticket =|每张工单 =/, '副标题要说明 worker 是独立进程')

// --- the rail icon carries a badge for queued + running -------------------
const railText = textOf(render(slots.get('dsh-team').component))
assert.match(railText, /2/, '队列 1 + 运行 1 = 2')

// --- styles only use host theme tokens ------------------------------------
assert.match(textOf(render(drawer)), /后台工单/)

for (const cleanup of effects) cleanup()

console.log('client: ok')
