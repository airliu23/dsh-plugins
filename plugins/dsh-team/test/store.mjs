/**
 * Store regression — no Harness, no browser, no worker.
 *
 *   node test/store.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTicketStore, summarize } from '../store.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-team-store-'))
const file = join(dir, 'tickets.json')

let clock = 1_700_000_000_000
let seq = 0
const newStore = () =>
  createTicketStore({
    file,
    now: () => (clock += 1_000),
    makeId: () => `t-${++seq}`,
  })

try {
  // --- empty state --------------------------------------------------------
  let store = newStore()
  assert.deepEqual(store.snapshot().counts, { queued: 0, running: 0, done: 0, failed: 0, canceled: 0 })
  assert.equal(store.nextQueued(), undefined)

  // --- add + persist ------------------------------------------------------
  const first = store.add({ title: '分析 RX', task: '读 protocol/rx 并给出报告' })
  assert.equal(first.state, 'queued')
  assert.equal(first.title, '分析 RX')
  assert.equal(store.runningCount(), 0)
  assert.equal(store.nextQueued()?.id, 't-1')

  const saved = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(saved.tickets.length, 1)
  assert.equal(saved.tickets[0].task, '读 protocol/rx 并给出报告')

  // --- a title is derived when missing ------------------------------------
  const second = store.add({ task: '把 gates 表贴出来\n第二行不该进标题' })
  assert.equal(second.title, '把 gates 表贴出来')
  assert.equal(summarize('a\nb'), 'a')

  // --- empty task rejected -------------------------------------------------
  assert.throws(() => store.add({ task: '   ' }), /task 不能为空/)

  // --- running state ------------------------------------------------------
  store.patch('t-1', { state: 'running', startedAt: clock })
  assert.equal(store.runningCount(), 1)

  // --- done keeps the report ----------------------------------------------
  store.patch('t-1', { state: 'done', exitCode: 0, report: '报告正文', finishedAt: clock })
  assert.equal(store.find('t-1')?.report, '报告正文')
  assert.equal(store.snapshot().counts.done, 1)

  // --- unknown id ---------------------------------------------------------
  assert.throws(() => store.patch('nope', { state: 'done' }), /没有这张工单/)

  // --- reload keeps finished tickets --------------------------------------
  store = newStore()
  assert.equal(store.snapshot().tickets.length, 2)
  assert.equal(store.find('t-1')?.state, 'done')

  // --- a ticket left running by a dead process becomes failed -------------
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  raw.tickets.push({ id: 't-9', task: '跑一半', state: 'running', createdAt: clock })
  writeFileSync(file, JSON.stringify(raw))
  store = newStore()
  assert.equal(store.find('t-9')?.state, 'failed')
  assert.match(store.find('t-9')?.error ?? '', /Host/)

  // --- a ticket remembers the Session that posted it ----------------------
  const owned = store.add({ title: '带会话', task: 'x', sessionId: 'session-abc' })
  assert.equal(owned.sessionId, 'session-abc')
  assert.equal(owned.notifiedAt, null)
  store.patch(owned.id, { state: 'done', finishedAt: clock })
  const stamp = clock
  store.patch(owned.id, { notifiedAt: stamp })
  assert.equal(store.find(owned.id)?.notifiedAt, stamp)
  // A panel ticket carries no Session: nothing to notify.
  assert.equal(store.add({ task: 'panel only', source: 'panel' }).sessionId, '')

  // --- a summary ticket remembers what it waits for -----------------------
  const upstream = store.add({ title: '上游', task: 'x' })
  const summary = store.add({ title: '汇总', task: 'y', waitsFor: [upstream.id, upstream.id, '  ', 42] })
  assert.deepEqual(summary.waitsFor, [upstream.id], '去重、丢脏值、保持顺序')
  // The queue can be asked for a gated ticket; the gate itself is dispatcher policy.
  assert.equal(store.nextQueued((ticket) => ticket.id === summary.id)?.id, summary.id)
  assert.equal(store.nextQueued((ticket) => ticket.waitsFor.length === 0)?.waitsFor.length, 0)

  // --- reload keeps the ownership fields ----------------------------------
  store = newStore()
  assert.equal(store.find(owned.id)?.sessionId, 'session-abc')
  assert.equal(store.find(owned.id)?.notifiedAt, stamp)
  assert.ok(store.snapshot().tickets.some((ticket) => ticket.id === summary.id && ticket.waitsFor.length === 1), '依赖关系要落盘')

  // --- corrupt file is backed up, list starts empty ------------------------
  writeFileSync(file, '{not json')
  store = newStore()
  assert.equal(store.snapshot().tickets.length, 0)
  assert.match(store.snapshot().note ?? '', /不是合法 JSON/)

  // --- report is capped ---------------------------------------------------
  store.add({ task: 'x' })
  store.patch(store.snapshot().tickets.at(-1).id, { report: 'y'.repeat(25_000) })
  assert.equal(store.find(store.snapshot().tickets.at(-1).id).report.length, 20_000)

  console.log('store: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
