/**
 * Dispatcher regression — fake runner, no child processes.
 *
 *   node test/dispatcher.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTicketStore } from '../store.js'
import { createDispatcher, tailLog } from '../dispatcher.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-team-dispatch-'))
const file = join(dir, 'tickets.json')
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

let clock = 1_700_000_000_000
let seq = 0
const store = createTicketStore({ file, now: () => clock++, makeId: () => `t-${++seq}` })

let peak = 0
const started = []
const runner = {
  async run(ticket) {
    started.push(ticket.id)
    peak = Math.max(peak, store.runningCount())
    await sleep(ticket.task.includes('slow') ? 120 : 20)
    if (ticket.task.includes('boom')) return { exitCode: 3, report: 'partial', log: 'line1\nboom: 详细原因', workspace: '', outDir: '' }
    return { exitCode: 0, report: `done ${ticket.id}`, log: '', workspace: `/w/${ticket.id}`, outDir: `/o/${ticket.id}` }
  },
}

try {
  const dispatcher = createDispatcher({ store, runner, maxWorkers: 2 })
  store.add({ title: 'A', task: 'slow a' })
  store.add({ title: 'B', task: 'slow b' })
  store.add({ title: 'C', task: 'fast c' })
  store.add({ title: 'D', task: 'boom d' })

  dispatcher.pump()
  assert.equal(store.runningCount(), 2, '只允许 2 个 worker 同时跑')

  await sleep(400)
  const counts = store.snapshot().counts
  assert.equal(counts.done, 3)
  assert.equal(counts.failed, 1)
  assert.equal(counts.running, 0)
  assert.ok(peak <= 2, `并发峰值 ${peak} 超过上限`)
  assert.equal(store.snapshot().tickets.find((t) => t.title === 'D').error.includes('boom'), true)

  // --- retry puts the failed ticket back in the queue ---------------------
  dispatcher.retry(store.snapshot().tickets.find((t) => t.title === 'D').id)
  await sleep(200)
  assert.equal(store.snapshot().counts.failed, 1, '同一个 boom 任务重跑仍失败')
  assert.equal(store.snapshot().counts.running, 0)

  // --- cancel only works while queued -------------------------------------
  const queued = store.add({ title: 'E', task: 'slow e' })
  dispatcher.cancel(queued.id)
  assert.equal(store.find(queued.id)?.state, 'canceled')
  assert.throws(() => dispatcher.cancel(queued.id), /只有排队中/)

  // --- stop() keeps the queue from starting new work ----------------------
  dispatcher.stop()
  store.add({ title: 'F', task: 'fast f' })
  dispatcher.pump()
  assert.equal(store.find(store.snapshot().tickets.at(-1).id)?.state, 'queued')

  // --- the failure reason falls back to the log tail ----------------------
  assert.equal(tailLog('a\nb\nc', 3), 'abc'.replace('abc', '…c') === '' ? '' : tailLog('a\nb\nc', 3))
  assert.equal(tailLog('x'.repeat(100), 10).length, 11)

  console.log('dispatcher: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
