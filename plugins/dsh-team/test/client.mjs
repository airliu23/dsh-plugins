/**
 * Client wiring regression — fake module loader, tiny React runtime, no browser.
 *
 *   node test/client.mjs
 *
 * Covers what a real install hits first: the module registers, `apply` fills the
 * four seats (header toggle, rail icon, right-pane tab + tab title), the tab
 * type is registered with the sidebar service, and the pane renders a snapshot
 * — including list → detail navigation and the back arrow.
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

// --- a tiny React runtime: enough for hooks + list → detail ----------------
const effects = []
const frames = new Map() // persistent, like real component instances
let active = null
let cursor = 0
let dirty = false

const runComponent = (component, props) => {
  let frame = frames.get(component)
  if (frame === undefined) {
    frame = { states: [], ran: new Set() }
    frames.set(component, frame)
  }
  const savedFrame = active
  const savedCursor = cursor
  active = frame
  cursor = 0
  try {
    return component(props)
  } finally {
    active = savedFrame
    cursor = savedCursor
  }
}

const expand = (node) => {
  if (Array.isArray(node)) return node.map(expand)
  if (node === null || typeof node !== 'object') return node
  if (typeof node.type === 'function') return expand(runComponent(node.type, node.props))
  return {
    ...node,
    children: (node.children ?? []).map(expand),
    props: { ...node.props, children: expand(node.props.children) },
  }
}

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
  useState(initial) {
    // The setter keeps its own frame: async callbacks run after the render pass,
    // when `active` has already been restored to the caller.
    const frame = active
    const index = cursor++
    if (!(index in frame.states)) frame.states[index] = typeof initial === 'function' ? initial() : initial
    return [
      frame.states[index],
      (next) => {
        frame.states[index] = typeof next === 'function' ? next(frame.states[index]) : next
        dirty = true
      },
    ]
  },
  useEffect(fn) {
    const index = cursor++
    if (active.ran.has(index)) return
    active.ran.add(index)
    const cleanup = fn()
    if (typeof cleanup === 'function') effects.push(cleanup)
  },
  useMemo(fn) {
    cursor += 1
    return fn()
  },
  useRef(value) {
    cursor += 1
    return { current: value }
  },
  useCallback(fn) {
    cursor += 1
    return fn
  },
  useLayoutEffect(fn) {
    return React.useEffect(fn)
  },
  Fragment: 'fragment',
}

const require = (name) => {
  if (name === 'react') return React
  throw new Error(`unexpected require: ${name}`)
}

/** Render until no state update is left pending (bounded). */
const render = (component, props) => {
  let tree
  let guard = 0
  do {
    dirty = false
    active = null
    cursor = 0
    tree = expand(runComponent(component, props))
  } while (dirty && guard++ < 8)
  return tree
}

const textOf = (node) => {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  if (typeof node !== 'object') return ''
  if (node.type === 'style') return ''
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

// --- the Host snapshot the pane will show --------------------------------
const snapshot = {
  note: null,
  version: 3,
  counts: { queued: 1, running: 1, done: 4, failed: 1, canceled: 0 },
  tickets: [
    {
      id: 't-aaaa1111',
      title: '分析 RX 协议',
      state: 'done',
      createdAt: 1_700_000_000_000,
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_150_000,
      exitCode: 0,
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
      exitCode: 1,
      report: '',
      error: 'worker 退出码 1',
      outDir: '/home/airliu/.dsh/dsh-team/outbox/t-bbbb2222',
    },
    {
      id: 't-cccc3333',
      title: '切片甲',
      state: 'done',
      createdAt: 1_700_000_000_000,
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_012_000,
      exitCode: 0,
      report: '甲的报告',
      error: '',
      waitsFor: [],
      outDir: '',
    },
    {
      id: 't-dddd4444',
      title: '切片乙',
      state: 'done',
      createdAt: 1_700_000_000_000,
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_014_000,
      exitCode: 0,
      report: '乙的报告',
      error: '',
      waitsFor: [],
      outDir: '',
    },
    {
      id: 't-eeee5555',
      title: '汇总单',
      state: 'done',
      createdAt: 1_700_000_000_000,
      startedAt: 1_700_000_020_000,
      finishedAt: 1_700_000_032_000,
      exitCode: 0,
      report: '甲比乙完整',
      error: '',
      waitsFor: ['t-cccc3333', 't-dddd4444'],
      outDir: '',
    },
  ],
}

globalThis.fetch = async () => ({ ok: true, json: async () => snapshot })
globalThis.EventSource = class {
  addEventListener() {}
}

// --- apply() fills the seats ---------------------------------------------
/** Every registration, keyed by slot name (the pane and its title share a key). */
const slots = new Map()
const tabTypes = []
const opened = []
const dictionaries = []
const panelSelections = []
const ctx = {
  layout: {
    selectPanel(key) {
      panelSelections.push(key)
    },
  },
  effect(fn) {
    const cleanup = fn()
    if (typeof cleanup === 'function') effects.push(cleanup)
  },
  inject(names, cb) {
    if (names.includes('sidebarRightTabs')) {
      cb({
        effect(fn) {
          fn()
        },
        sidebarRightTabs: {
          register(entry) {
            tabTypes.push(entry)
            return () => {}
          },
        },
      })
    }
  },
  get(name) {
    if (name === 'sidebarRight') {
      return {
        openTab(kind) {
          opened.push(kind)
        },
      }
    }
    return undefined
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
      slots.set(meta.name, { meta, component })
    },
  },
}

await import('../client.js')
assert.equal(typeof factory, 'function', 'client.js 必须向 __ModuleLoader__ 注册')
const mod = factory(require)
assert.deepEqual(mod.inject, ['slots', 'locale', 'layout'])
mod.apply(ctx)

// --- registrations --------------------------------------------------------
assert.deepEqual(
  [...slots.keys()].sort(),
  [
    'conversation.session.header.utilities',
    'main',
    'sidebar.panellist',
    'sidebar.right.pane.tab',
    'sidebar.right.pane.tab.title',
  ],
  '四个座位：会话头按钮、侧栏图标、右栏 tab、tab 标题',
)
assert.equal(slots.get('sidebar.right.pane.tab').meta.key, '@local/dsh-team')
assert.equal(tabTypes.length, 1)
assert.equal(tabTypes[0].kind, 'dsh-team')
assert.equal(dictionaries.length, 1)
assert.ok(dictionaries[0].dict.zh.nav.length > 0)
assert.ok(dictionaries[0].dict.en.nav.length > 0)

// --- the header toggle opens the right pane -------------------------------
const toggleTree = render(slots.get('conversation.session.header.utilities').component)
const toggleButton = find(toggleTree, (node) => node.type === 'button')
assert.ok(toggleButton !== null)
toggleButton.props.onClick()
assert.deepEqual(opened, ['dsh-team'], '点开关要 openTab')

// --- the pane renders the snapshot ---------------------------------------
const Pane = slots.get('sidebar.right.pane.tab').component
render(Pane) // mount once so the effect starts the first fetch
await new Promise((done) => setTimeout(done, 10))
const listTree = render(Pane)
const listText = textOf(listTree)
assert.match(listText, /分析 RX 协议/)
assert.match(listText, /跑门禁/)
assert.match(listText, /每张工单 = 一个独立的 dsh headless worker/)

// --- clicking a row opens that ticket in the same pane -------------------
const rows = []
const collectRows = (node) => {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach(collectRows)
    return
  }
  if (node.props?.className?.startsWith('dsh-team-row')) rows.push(node)
  collectRows(node.children)
  collectRows(node.props?.children)
}
collectRows(listTree)
assert.equal(rows.length >= 2, true, '两张工单各一行')
assert.match(textOf(rows[0]), /分析 RX 协议/)

rows[0].props.onClick() // → setSelected(...) → dirty
const detailTree = render(Pane)
const detailText = textOf(detailTree)
assert.match(detailText, /列表/, '详情页要有返回入口')
assert.match(detailText, /结论：状态机表与 def 不一致/, '详情页要显示完整报告')
assert.match(detailText, /t-aaaa1111/)
assert.doesNotMatch(detailText, /任务正文/, '详情页不该还显示投单表单')

// --- a summary ticket nests its upstreams, instead of a flat log ---------
const back = find(detailTree, (node) => typeof node.props?.className === 'string' && node.props.className.startsWith('dsh-team-back'))
assert.ok(back !== null, '详情页要能回到列表')
back.props.onClick()
const tree = render(Pane)

const everyRow = []
const pick = (node) => {
  if (node === null || typeof node !== 'object') return
  if (Array.isArray(node)) {
    node.forEach(pick)
    return
  }
  if (typeof node.props?.className === 'string' && node.props.className.startsWith('dsh-team-row')) everyRow.push(node)
  pick(node.children)
  pick(node.props?.children)
}
pick(tree)
const summaryRow = everyRow.find((row) => textOf(row).includes('汇总单'))
assert.ok(summaryRow !== undefined, '汇总单要有一行')
assert.match(textOf(summaryRow), /汇总 2/, '汇总行要看得出它收了几张上游')
const childRows = everyRow.filter((row) => row.props.className.includes('is-child'))
assert.equal(childRows.length, 2, '两张上游缩进挂在汇总单下面，而不是平铺')
assert.equal(childRows.some((row) => textOf(row).includes('切片甲')), true)

summaryRow.props.onClick()
const summaryDetail = textOf(render(Pane))
assert.match(summaryDetail, /上游/, '详情页要列上游')
assert.match(summaryDetail, /切片甲/, '上游是可点的关联行')
assert.match(summaryDetail, /甲比乙完整/, '详情页显示汇总单自己的报告')

// --- the tab title carries a live badge ----------------------------------
const titleText = textOf(render(slots.get('sidebar.right.pane.tab.title').component))
assert.match(titleText, /工单/)
assert.match(titleText, /2/, '排队 1 + 运行 1 = 2')

// --- the rail icon is bare icon geometry (alignment) ---------------------
const railTree = render(slots.get('sidebar.panellist').component)
assert.equal(railTree.type, 'span', '侧栏图标必须返回 span，不能自带按钮盒子')
assert.equal(find(railTree, (node) => node.type === 'button'), null, '侧栏图标里不该有按钮')
const railSvg = find(railTree, (node) => node.type === 'svg')
assert.ok(railSvg !== null, '要有图标')
assert.equal(railSvg.props.width, 18, '默认 18px，交给侧栏决定尺寸')
const rail20 = render(slots.get('sidebar.panellist').component, { size: 20 })
assert.equal(find(rail20, (n) => n.type === 'svg').props.width, 20, 'props.size 要生效')

// --- the rail selects the `main` bridge, which opens the pane ------------
render(slots.get('main').component)
assert.deepEqual(opened, ['dsh-team', 'dsh-team'], '侧栏点击经 main 桥打开右栏')
assert.deepEqual(panelSelections, [null], '打开后把中间栏还给对话')

for (const cleanup of effects.splice(0)) cleanup()

console.log('client: ok')
