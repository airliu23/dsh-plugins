/**
 * Headless test of the client half — no browser, no real DOM, no audio.
 *
 *   node test/client-window.mjs
 *
 * A tiny React keeps hook state across renders and honours effect dependency
 * arrays, so the test can drive the real component tree the way the overlay
 * does: the header countdown, a pushed `due` frame opening the stand window,
 * the break countdown, snooze/skip acks, the setup switches, and `remind` now.
 */
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ---------------------------------------------------------------- fake window
const windowListeners = new Map()
globalThis.window = {
  __ModuleLoader__: { load: (definition) => (loaded = definition) },
  addEventListener(type, fn) {
    const list = windowListeners.get(type) ?? []
    list.push(fn)
    windowListeners.set(type, list)
  },
  removeEventListener(type, fn) {
    const list = windowListeners.get(type) ?? []
    windowListeners.set(type, list.filter((entry) => entry !== fn))
  },
  AudioContext: undefined,
  webkitAudioContext: undefined,
}
let loaded = null

function dispatchKey(key) {
  for (const fn of [...(windowListeners.get('keydown') ?? [])]) {
    fn({ key, defaultPrevented: false, preventDefault() {} })
  }
}

// ---------------------------------------------------------------- fake React
const instances = []
let activeInstance = null

function makeInstance(component) {
  const hooks = []
  const instance = {
    component,
    hooks,
    render(props = {}) {
      const previous = activeInstance
      activeInstance = instance
      let index = 0
      const effects = []
      globalThis.__hookIndex__ = 0
      globalThis.__currentHooks__ = hooks
      globalThis.__pendingEffects__ = effects
      let tree
      try {
        tree = component(props)
      } finally {
        activeInstance = previous
      }
      for (const { slot, fn } of effects) {
        if (typeof slot.cleanup === 'function') slot.cleanup()
        slot.cleanup = fn()
      }
      return tree
    },
    dispose() {
      for (const slot of hooks) {
        if (typeof slot?.cleanup === 'function') slot.cleanup()
        slot.cleanup = null
      }
    },
  }
  instances.push(instance)
  return instance
}

const fakeReact = {
  createElement: (tag, props, ...children) => ({ tag, props: props ?? {}, children: children.flat(Infinity) }),
  useState(initial) {
    const hooks = globalThis.__currentHooks__
    const index = globalThis.__hookIndex__++
    const slot = (hooks[index] ??= { kind: 'state', value: initial })
    const set = (update) => {
      slot.value = typeof update === 'function' ? update(slot.value) : update
    }
    return [slot.value, set]
  },
  useEffect(fn, deps) {
    const hooks = globalThis.__currentHooks__
    const index = globalThis.__hookIndex__++
    const slot = (hooks[index] ??= { kind: 'effect', deps: undefined })
    const same =
      Array.isArray(deps) && Array.isArray(slot.deps) && deps.length === slot.deps.length && deps.every((value, i) => Object.is(value, slot.deps[i]))
    if (same) return
    slot.deps = deps
    globalThis.__pendingEffects__.push({ slot, fn })
  },
  useRef(initial) {
    const hooks = globalThis.__currentHooks__
    const index = globalThis.__hookIndex__++
    const slot = (hooks[index] ??= { kind: 'ref', ref: { current: initial } })
    return slot.ref
  },
}

const requireStub = (name) => {
  if (name === 'react') return fakeReact
  throw new Error(`unexpected require: ${name}`)
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
  fire(type, payload) {
    if (this.readyState === 2) return
    this.readyState = 1
    for (const fn of this.listeners.get(type) ?? []) fn({ data: payload === undefined ? undefined : JSON.stringify(payload) })
  }
}
globalThis.EventSource = FakeEventSource

// ---------------------------------------------------------------- fake backend
const BASE = {
  enabled: true,
  settings: { intervalMinutes: 60, breakSeconds: 120, snoozeMinutes: 10, sound: true, notify: false },
  nextDueAt: Date.now() + 42 * 60_000,
  dueAt: null,
  sittingSince: Date.now() - 60 * 60_000,
  snoozedUntil: null,
  today: { date: '2026-10-30', stands: 2, seconds: 240 },
}
let serverState = structuredClone(BASE)
/** { url, body } for every request, in order. */
const requests = []
let remindShown = true

const response = (payload) => ({
  ok: true,
  status: 200,
  json: async () => structuredClone({ ...payload, serverNow: Date.now() }),
})

function snapshot() {
  return structuredClone(serverState)
}

globalThis.fetch = async (url, init) => {
  const target = String(url)
  const body = init?.body === undefined ? null : JSON.parse(init.body)
  requests.push({ url: target, body })
  if (target.endsWith('/state')) return response(snapshot())
  if (target.endsWith('/ack')) {
    const now = Date.now()
    if (body.action === 'stood') {
      serverState.today.stands += 1
      serverState.today.seconds += body.breakSeconds
      serverState.nextDueAt = now + body.breakSeconds * 1_000 + serverState.settings.intervalMinutes * 60_000
      serverState.snoozedUntil = null
    } else if (body.action === 'snooze') {
      serverState.nextDueAt = now + serverState.settings.snoozeMinutes * 60_000
      serverState.snoozedUntil = serverState.nextDueAt
    } else if (body.action === 'skip') {
      serverState.nextDueAt = now + serverState.settings.intervalMinutes * 60_000
      serverState.snoozedUntil = null
    } else if (body.action === 'sat-down') {
      serverState.nextDueAt = now + serverState.settings.intervalMinutes * 60_000
      serverState.snoozedUntil = null
    }
    return response({ ok: true, ...snapshot() })
  }
  if (target.endsWith('/settings')) {
    Object.assign(serverState.settings, body)
    if (typeof body.enabled === 'boolean') {
      serverState.enabled = body.enabled
      serverState.nextDueAt = body.enabled ? Date.now() + serverState.settings.intervalMinutes * 60_000 : null
    }
    if (body.intervalMinutes !== undefined) serverState.nextDueAt = Date.now() + body.intervalMinutes * 60_000
    return response({ ok: true, ...snapshot() })
  }
  if (target.endsWith('/remind')) {
    serverState.dueAt = Date.now()
    serverState.nextDueAt = Date.now() + serverState.settings.intervalMinutes * 60_000
    return response({ ok: true, shown: remindShown, ...snapshot() })
  }
  throw new Error(`unexpected fetch: ${target}`)
}

// ---------------------------------------------------------------- plugin boot
const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..')
await import(pathToFileURL(join(PLUGIN, 'client.js')).href)
if (loaded === null) throw new Error('client.js did not call __ModuleLoader__.load')
const plugin = loaded.factory(requireStub)

const registrations = new Map()
const disposers = []
const dictionaries = new Map()
const ctx = {
  effect(fn) {
    const dispose = fn()
    if (typeof dispose === 'function') disposers.push(dispose)
    return dispose
  },
  locale: {
    register(namespace, dict) {
      dictionaries.set(namespace, dict)
      return () => dictionaries.delete(namespace)
    },
    bind(namespace) {
      const dict = dictionaries.get(namespace) ?? {}
      const table = dict.zh ?? {}
      return (key) => table[key] ?? key
    },
  },
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

const windowRegistration = registrations.get('shell.overlay')
const headerRegistration = registrations.get('conversation.session.header.utilities')
if (windowRegistration === undefined || headerRegistration === undefined) {
  throw new Error('the overlay and header slots were not registered')
}

const StandWindow = makeInstance(windowRegistration.component)
const StandHeader = makeInstance(headerRegistration.component)

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
  if (typeof node === 'object' && Array.isArray(node.children)) {
    if (node.tag === 'style') return out
    for (const child of node.children) flatten(child, out)
  }
  return out
}

function nodes(tree, out = []) {
  if (tree === null || tree === undefined || typeof tree !== 'object') return out
  if (Array.isArray(tree)) {
    for (const child of tree) nodes(child, out)
    return out
  }
  out.push(tree)
  for (const child of tree.children ?? []) nodes(child, out)
  return out
}

const textOf = (tree) => flatten(tree).join(' ')
const findText = (tree, needle, tag = 'button') =>
  nodes(tree).find((node) => node.tag === tag && flatten(node.children).join('').includes(needle))

function click(node, label) {
  assert.ok(node, `could not find ${label}`)
  node.props.onClick({ target: null, currentTarget: null, preventDefault() {}, stopPropagation() {} })
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
const postTo = (path) => requests.filter((entry) => entry.url.endsWith(path)).at(-1)?.body

const failures = []
function check(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) failures.push(label)
}

check('nothing renders before a reminder', flatten(StandWindow.render()).length === 0)
const source = FakeEventSource.all[0]
check('mounting the window opens one push stream', FakeEventSource.all.length === 1 && source?.url.endsWith('/events'), source?.url)

let headerTree = StandHeader.render()
let headerText = textOf(headerTree)
check('the header waits for the first snapshot', headerText.includes('站一站') && headerText.includes('…'), headerText)
check('the header is a button', headerTree.tag === 'button')

// The first snapshot arrives from `/state`; the stream's own snapshot is a no-op.
await tick(40)
headerText = textOf(StandHeader.render())
check('the header still counts down after the snapshot', headerText.includes('42m'), headerText)

// --- a due frame opens the window ---------------------------------------
source.fire('due', { at: Date.now(), serverNow: Date.now() })
let tree = StandWindow.render()
let text = textOf(tree)
check('the stand window appears on due', text.includes('站起来动一动'))
check('it says how long the user sat', text.includes('已经坐了 60 分钟'), text.slice(0, 160))
check('it offers a break of the configured length', text.includes('我站起来了 · 休息 2 分钟'))
check('it offers snooze and skip', text.includes('稍后 10 分钟') && text.includes('跳过这次'))
check('it explains the dismiss gesture', text.includes('稍后提醒'))

// --- stood: break countdown --------------------------------------------
click(findText(tree, '我站起来了'), 'the stand-up button')
await tick()
tree = StandWindow.render()
text = textOf(tree)
const stood = postTo('/ack')
check('stood posts the break length', stood?.action === 'stood' && stood.breakSeconds === 120, JSON.stringify(stood))
check('the break view starts at 02:00', text.includes('02:00'), text.slice(0, 120))
check('the break view counts standing time', text.includes('站立中') && text.includes('提前坐下'))

// The break timer must not be wiped by another due frame while standing.
source.fire('due', { at: Date.now() + 1, serverNow: Date.now() })
tree = StandWindow.render()
check('a second due does not interrupt the break', textOf(tree).includes('02:00'))

// --- Esc during the break means "sat down again" ------------------------
dispatchKey('Escape')
await tick()
const satDown = postTo('/ack')
check('Esc during the break posts sat-down', satDown?.action === 'sat-down', JSON.stringify(satDown))
check('the window is closed after Esc', flatten(StandWindow.render()).length === 0)

// --- reopen from the header: setup -------------------------------------
headerTree = StandHeader.render()
click(headerTree, 'the header entry')
tree = StandWindow.render()
text = textOf(tree)
check('the header opens the setup face', text.includes('久坐提醒') && text.includes('开启提醒'))
check('setup lists every setting', ['提醒间隔', '休息时长', '稍后提醒', '提示音', '后台系统通知'].every((label) => text.includes(label)), text)
check('setup shows today', text.includes('今天：站起来 3 次 · 共 6 分钟'), text)

// --- settings -----------------------------------------------------------
click(findText(tree, '45′'), 'the 45 minute interval')
await tick()
check('the interval posts as minutes', postTo('/settings')?.intervalMinutes === 45, JSON.stringify(postTo('/settings')))

tree = StandWindow.render()
const soundSwitch = nodes(tree).find((node) => node.props?.role === 'switch' && node.props?.['aria-label'] === '提示音')
click(soundSwitch, 'the chime switch')
await tick()
check('the chime switch posts sound=false', postTo('/settings')?.sound === false, JSON.stringify(postTo('/settings')))
check('the status line follows the snapshot', textOf(StandWindow.render()).includes('下一次'))

// --- disable ------------------------------------------------------------
tree = StandWindow.render()
const enableSwitch = nodes(tree).find((node) => node.props?.role === 'switch' && node.props?.['aria-label'] === '开启提醒')
click(enableSwitch, 'the enable switch')
await tick()
check('disabling posts enabled=false', postTo('/settings')?.enabled === false)
headerText = textOf(StandHeader.render())
check('the header says the reminder is off', headerText.includes('关'), headerText)

// --- remind now ---------------------------------------------------------
tree = StandWindow.render()
check('setup still says the reminder is off', textOf(tree).includes('提醒已关闭'))
click(findText(tree, '现在提醒一次'), 'the remind-now button')
await tick()
check('remind-now posts', postTo('/remind') !== undefined)
tree = StandWindow.render()
text = textOf(tree)
check('remind-now shows the stand window', text.includes('站起来动一动'))
check('a second card is not stacked', textOf(tree).split('站起来动一动').length === 2)

// --- snooze closes it ---------------------------------------------------
click(findText(tree, '稍后 10 分钟'), 'the snooze button')
await tick()
check('snooze posts the default delay', postTo('/ack')?.action === 'snooze')
check('snooze closes the window', flatten(StandWindow.render()).length === 0)

console.log(`requests=${requests.length} instances=${instances.length}`)
for (const instance of instances) instance.dispose()
for (const dispose of disposers) if (typeof dispose === 'function') dispose()
console.log(failures.length === 0 ? 'client-window.mjs: ok' : `client-window.mjs: ${failures.length} failure(s)`)
process.exit(failures.length === 0 ? 0 : 1)
