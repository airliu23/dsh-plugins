/**
 * Ticket state: one plain JSON document, owned by the Host half.
 *
 * No Cordis context on purpose — `index.js` wires this store to the Web routes
 * and the `team` tool, and `test/store.mjs` drives it directly. Every mutation
 * persists immediately (write-temp + rename) and then notifies subscribers, so
 * the panel, the tool and the next Host process all see the same tickets.
 *
 * A ticket is one background job: queued → running → done | failed | canceled.
 * `report` holds the worker's final answer (truncated); `error` holds why it
 * died. Nothing here spawns anything — that is the dispatcher's job.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Keep the document small: a worker's answer is a summary, not an archive. */
export const MAX_REPORT = 20_000
export const MAX_TASK = 20_000
export const MAX_TITLE = 160
const MAX_TICKETS_HARD = 5_000

const STATES = ['queued', 'running', 'done', 'failed', 'canceled']

const describe = (error) => (error instanceof Error ? error.message : String(error))

/** One line for a board row: first non-empty line, hard-capped. */
export function summarize(text, limit = 90) {
  if (typeof text !== 'string') return ''
  const first = text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '')
  if (first === undefined) return ''
  return first.length > limit ? `${first.slice(0, limit)}…` : first
}

/**
 * @param {{
 *   file: string,
 *   maxTickets?: number,
 *   now?: () => number,
 *   makeId?: () => string,
 * }} options
 */
export function createTicketStore(options) {
  const file = typeof options?.file === 'string' ? options.file : ''
  const maxTickets =
    Number.isFinite(options?.maxTickets) && options.maxTickets >= 1
      ? Math.min(MAX_TICKETS_HARD, Math.trunc(options.maxTickets))
      : 500
  const now = typeof options?.now === 'function' ? options.now : Date.now
  const makeId = typeof options?.makeId === 'function' ? options.makeId : () => `t-${randomUUID().slice(0, 8)}`

  /** @type {Array<Record<string, any>>} */
  let tickets = []
  /** A one-off warning (unreadable / corrupt file), surfaced in the board. */
  let note = null
  let version = 0
  const listeners = new Set()

  const clamp = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '')

  function normalizeStored(entry) {
    if (typeof entry !== 'object' || entry === null) return null
    const id = typeof entry.id === 'string' && entry.id !== '' ? entry.id : makeId()
    const state = STATES.includes(entry.state) ? entry.state : 'failed'
    const task = clamp(entry.task, MAX_TASK)
    if (task.trim() === '') return null
    return {
      id,
      title: clamp(entry.title, MAX_TITLE) || summarize(task),
      task,
      state: state === 'running' ? 'failed' : state, // a running ticket died with the previous process
      source: clamp(entry.source, 40) || 'session',
      createdAt: Number.isFinite(entry.createdAt) ? entry.createdAt : now(),
      startedAt: Number.isFinite(entry.startedAt) ? entry.startedAt : null,
      finishedAt: Number.isFinite(entry.finishedAt) ? entry.finishedAt : null,
      workspace: clamp(entry.workspace, 400),
      outDir: clamp(entry.outDir, 400),
      exitCode: Number.isInteger(entry.exitCode) ? entry.exitCode : null,
      error: state === 'running' ? '上次会话随 Host 退出，已标记失败' : clamp(entry.error, 2_000),
      report: clamp(entry.report, MAX_REPORT),
    }
  }

  function load() {
    if (file === '') return
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      // A missing file is the normal first run; anything else is a warning.
      if (error?.code !== 'ENOENT') note = `工单文件读取失败：${describe(error)}`
      return
    }
    try {
      const parsed = JSON.parse(raw)
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.tickets) ? parsed.tickets : []
      tickets = list.map(normalizeStored).filter((ticket) => ticket !== null).slice(-maxTickets)
    } catch (error) {
      note = `工单文件不是合法 JSON，已备份并从空工单开始：${describe(error)}`
      try {
        writeFileSync(`${file}.corrupt-${now()}`, raw)
      } catch {
        /* the backup is best effort */
      }
    }
  }

  function persist() {
    if (file === '') return
    const body = JSON.stringify({ version, tickets }, null, 2)
    const temp = `${file}.tmp-${process.pid}`
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(temp, body)
    renameSync(temp, file)
  }

  function changed() {
    version += 1
    persist()
    for (const listener of [...listeners]) {
      try {
        listener(version)
      } catch {
        /* a broken subscriber must not break the others */
      }
    }
  }

  function find(id) {
    return tickets.find((ticket) => ticket.id === id)
  }

  function snapshot() {
    const counts = { queued: 0, running: 0, done: 0, failed: 0, canceled: 0 }
    for (const ticket of tickets) counts[ticket.state] += 1
    return {
      note,
      version,
      counts,
      tickets: tickets.map((ticket) => ({ ...ticket, summary: summarize(ticket.report || ticket.error || ticket.task) })),
    }
  }

  function add(input = {}) {
    const task = clamp(input.task, MAX_TASK)
    if (task.trim() === '') throw new Error('task 不能为空')
    const ticket = {
      id: makeId(),
      title: clamp(input.title, MAX_TITLE) || summarize(task),
      task,
      state: 'queued',
      source: clamp(input.source, 40) || 'session',
      createdAt: now(),
      startedAt: null,
      finishedAt: null,
      workspace: '',
      outDir: '',
      exitCode: null,
      error: '',
      report: '',
    }
    tickets.push(ticket)
    if (tickets.length > maxTickets) tickets = tickets.slice(-maxTickets)
    changed()
    return ticket
  }

  function patch(id, fields = {}) {
    const ticket = find(id)
    if (ticket === undefined) throw new Error(`没有这张工单：${id}`)
    if (typeof fields.state === 'string' && STATES.includes(fields.state)) ticket.state = fields.state
    if (typeof fields.workspace === 'string') ticket.workspace = clamp(fields.workspace, 400)
    if (typeof fields.outDir === 'string') ticket.outDir = clamp(fields.outDir, 400)
    if (Number.isInteger(fields.exitCode)) ticket.exitCode = fields.exitCode
    if (typeof fields.error === 'string') ticket.error = clamp(fields.error, 2_000)
    if (typeof fields.report === 'string') ticket.report = clamp(fields.report, MAX_REPORT)
    if (Number.isFinite(fields.startedAt)) ticket.startedAt = fields.startedAt
    if (Number.isFinite(fields.finishedAt)) ticket.finishedAt = fields.finishedAt
    changed()
    return ticket
  }

  /** The oldest queued ticket, in insertion order. */
  function nextQueued() {
    return tickets.find((ticket) => ticket.state === 'queued')
  }

  function runningCount() {
    return tickets.filter((ticket) => ticket.state === 'running').length
  }

  function onChange(listener) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  load()
  return { add, patch, find, nextQueued, runningCount, snapshot, onChange, get file() { return file } }
}
