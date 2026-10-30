/**
 * The todo list itself: one plain JSON document, owned by the Host half.
 *
 * No Cordis context here on purpose — `index.js` wires this store to the Web
 * routes and the agent tool, and `test/store.mjs` drives it directly. Every
 * mutation persists immediately (write-temp + rename) and then notifies the
 * subscribers, so the panel and the tool always see the same list.
 */
import { randomUUID } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Long enough for a real task line, short enough for one list row. */
export const MAX_TEXT = 500
const MAX_ITEMS_HARD = 10_000

const describe = (error) => (error instanceof Error ? error.message : String(error))

/**
 * @param {{
 *   file: string,
 *   maxItems?: number,
 *   now?: () => number,
 *   makeId?: () => string,
 * }} options
 */
export function createTodoStore(options) {
  const file = typeof options?.file === 'string' ? options.file : ''
  const maxItems =
    Number.isFinite(options?.maxItems) && options.maxItems >= 1
      ? Math.min(MAX_ITEMS_HARD, Math.trunc(options.maxItems))
      : 500
  const now = typeof options?.now === 'function' ? options.now : Date.now
  const makeId = typeof options?.makeId === 'function' ? options.makeId : randomUUID

  /** @type {Array<{id:string,text:string,done:boolean,createdAt:number,doneAt:number|null}>} */
  let items = []
  /** A one-off warning (unreadable / corrupt file) shown in the panel and tool. */
  let note = null
  let version = 0
  const listeners = new Set()

  function normalizeText(value) {
    if (typeof value !== 'string') return ''
    return value.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT)
  }

  function normalizeStored(entry) {
    if (typeof entry !== 'object' || entry === null) return null
    const text = normalizeText(entry.text)
    if (text === '') return null
    const done = entry.done === true
    const createdAt = Number.isFinite(entry.createdAt) ? entry.createdAt : now()
    return {
      id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : makeId(),
      text,
      done,
      createdAt,
      doneAt: done ? (Number.isFinite(entry.doneAt) ? entry.doneAt : createdAt) : null,
    }
  }

  function load() {
    if (file === '') return
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      // A missing file is the normal first run; anything else is a warning.
      if (error?.code !== 'ENOENT') note = `待办文件读取失败：${describe(error)}`
      return
    }
    try {
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : []
      items = list.map(normalizeStored).filter((item) => item !== null).slice(0, maxItems)
    } catch (error) {
      // Keep the broken bytes next to the file instead of silently dropping them.
      note = `待办文件不是合法 JSON，已备份并从空清单开始：${describe(error)}`
      try {
        copyFileSync(file, `${file}.corrupt-${now()}`)
      } catch {
        /* the file may be unreadable for the same reason it is invalid */
      }
      items = []
    }
  }

  function persist() {
    if (file === '') return
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.tmp`
      writeFileSync(temp, `${JSON.stringify({ version: 1, items }, null, 2)}\n`, 'utf8')
      renameSync(temp, file)
    } catch (error) {
      note = `待办文件写入失败（改动只在内存里）：${describe(error)}`
    }
  }

  function emit() {
    version += 1
    persist()
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        /* one broken subscriber must not block the others */
      }
    }
  }

  function counts() {
    const total = items.length
    const active = items.reduce((sum, item) => sum + (item.done ? 0 : 1), 0)
    return { total, active, done: total - active }
  }

  function snapshot() {
    return {
      version,
      items: items.map((item) => ({ ...item })),
      counts: counts(),
      file,
      note,
      maxItems,
    }
  }

  /** Exact id first, then a 1-based position in the list the tool just showed. */
  function find(id) {
    const key = typeof id === 'string' ? id.trim() : ''
    if (key === '') throw new Error('缺少待办 id')
    const direct = items.find((item) => item.id === key)
    if (direct !== undefined) return direct
    const index = Number.parseInt(key, 10)
    if (Number.isInteger(index) && String(index) === key && index >= 1 && index <= items.length) {
      return items[index - 1]
    }
    throw new Error(`找不到待办：${key}`)
  }

  function add(text) {
    const clean = normalizeText(text)
    if (clean === '') throw new Error('待办内容不能为空')
    if (items.length >= maxItems) throw new Error(`待办数量已达上限 ${maxItems} 条`)
    const item = { id: makeId(), text: clean, done: false, createdAt: now(), doneAt: null }
    // Newest first: a just-typed task is the one the user is looking for.
    items.unshift(item)
    emit()
    return { ...item }
  }

  function toggle(id, done) {
    const item = find(id)
    const next = typeof done === 'boolean' ? done : !item.done
    if (item.done !== next) {
      item.done = next
      item.doneAt = next ? now() : null
      emit()
    }
    return { ...item }
  }

  function update(id, text) {
    const item = find(id)
    const clean = normalizeText(text)
    if (clean === '') throw new Error('待办内容不能为空')
    if (clean !== item.text) {
      item.text = clean
      emit()
    }
    return { ...item }
  }

  function remove(id) {
    const item = find(id)
    items = items.filter((entry) => entry.id !== item.id)
    emit()
    return { ...item }
  }

  function clearDone() {
    const removed = items.filter((item) => item.done).length
    if (removed > 0) {
      items = items.filter((item) => !item.done)
      emit()
    }
    return removed
  }

  load()

  return {
    file,
    maxItems,
    get version() {
      return version
    },
    get note() {
      return note
    },
    snapshot,
    add,
    toggle,
    update,
    remove,
    clearDone,
    /** @param {() => void} listener */
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
