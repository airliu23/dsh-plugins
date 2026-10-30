/**
 * Host store regression test — no Harness, no browser, no server.
 *
 *   node test/store.mjs
 *
 * Uses a throwaway directory under the OS temp dir and removes it afterwards.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTodoStore } from '../store.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-todo-test-'))
const file = join(dir, 'todos.json')

let clock = 1_700_000_000_000
let seq = 0
const newStore = (options = {}) =>
  createTodoStore({
    file,
    now: () => (clock += 1_000),
    makeId: () => `id-${++seq}`,
    ...options,
  })

try {
  // --- empty state --------------------------------------------------------
  let store = newStore()
  assert.deepEqual(store.snapshot().counts, { total: 0, active: 0, done: 0 })
  assert.equal(store.snapshot().items.length, 0)

  // --- add: newest first, trimmed, one line --------------------------------
  const first = store.add('  买牛奶  ')
  assert.equal(first.text, '买牛奶')
  const second = store.add('交\n房租')
  assert.equal(second.text, '交 房租')
  assert.deepEqual(
    store.snapshot().items.map((item) => item.text),
    ['交 房租', '买牛奶'],
  )
  assert.deepEqual(store.snapshot().counts, { total: 2, active: 2, done: 0 })

  // Persisted immediately, even before any client connects.
  const onDisk = JSON.parse(readFileSync(file, 'utf8'))
  assert.equal(onDisk.items.length, 2)

  // --- toggle by index (as the tool documents) -----------------------------
  store.toggle('2', true)
  assert.deepEqual(store.snapshot().counts, { total: 2, active: 1, done: 1 })
  assert.equal(store.snapshot().items[1].done, true)
  assert.equal(typeof store.snapshot().items[1].doneAt, 'number')

  // --- toggle by id, both directions ---------------------------------------
  store.toggle(second.id, true)
  store.toggle(second.id, false)
  assert.equal(store.snapshot().items[0].done, false)
  assert.equal(store.snapshot().items[0].doneAt, null)

  // --- update / remove -----------------------------------------------------
  store.update(first.id, '买两盒牛奶')
  assert.equal(store.snapshot().items.find((item) => item.id === first.id).text, '买两盒牛奶')
  store.remove(second.id)
  assert.deepEqual(
    store.snapshot().items.map((item) => item.text),
    ['买两盒牛奶'],
  )

  // --- clear done ----------------------------------------------------------
  store.toggle(first.id, true)
  assert.equal(store.clearDone(), 1)
  assert.equal(store.snapshot().items.length, 0)

  // --- reload from disk ----------------------------------------------------
  store.add('写周报')
  store.add('回邮件')
  const reloaded = newStore()
  assert.deepEqual(
    reloaded.snapshot().items.map((item) => item.text),
    ['回邮件', '写周报'],
  )

  // --- validation ----------------------------------------------------------
  assert.throws(() => reloaded.add('   '), /不能为空/)
  assert.throws(() => reloaded.update(reloaded.snapshot().items[0].id, ''), /不能为空/)
  assert.throws(() => reloaded.toggle('does-not-exist'), /找不到/)
  assert.throws(() => reloaded.remove('99'), /找不到/)

  // --- maxItems ------------------------------------------------------------
  const capped = createTodoStore({ file: join(dir, 'capped.json'), maxItems: 2, now: () => 1 })
  capped.add('a')
  capped.add('b')
  assert.throws(() => capped.add('c'), /上限/)

  // --- corrupt file: keep a backup, start empty, surface the note ----------
  writeFileSync(join(dir, 'broken.json'), '{not json', 'utf8')
  const broken = createTodoStore({ file: join(dir, 'broken.json'), now: () => 42 })
  assert.equal(broken.snapshot().items.length, 0)
  assert.match(broken.snapshot().note ?? '', /不是合法 JSON/)
  assert.ok(readdirSync(dir).some((name) => name.startsWith('broken.json.corrupt-')))

  console.log('store.mjs: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
