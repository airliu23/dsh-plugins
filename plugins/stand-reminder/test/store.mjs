/**
 * Store regression test — no Cordis, no browser, no real server.
 *
 *   node test/store.mjs
 *
 * Drives the schedule directly: first run, clamping, every ack path, the daily
 * counter, reload persistence and corrupt-file recovery. The clock is a plain
 * variable, so an hour costs nothing.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReminderStore } from '../store.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-stand-store-'))
const file = join(dir, 'state.json')
let clock = Date.parse('2026-10-30T09:00:00+08:00')
const now = () => clock
const minutes = (value) => value * 60_000

const failures = []
function check(label, condition, detail) {
  console.log(`${condition ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  if (!condition) failures.push(label)
}

try {
  // --- first run ----------------------------------------------------------
  let store = createReminderStore({ file, now })
  let snapshot = store.snapshot()
  check('first run is enabled', snapshot.enabled === true)
  check('first run uses the 60 minute default', snapshot.settings.intervalMinutes === 60)
  check('first run schedules one interval out', snapshot.nextDueAt === clock + minutes(60))
  check('first run pretends an hour of sitting', snapshot.sittingSince === clock - minutes(60))
  check('no due at start', store.isDue() === false)
  check('no state file before a mutation', existsSync(file) === false)

  // --- seed from config, and the file wins afterwards ----------------------
  store.configure({ intervalMinutes: 45, breakSeconds: 180, snoozeMinutes: 5 })
  check('configure applies', store.settings.intervalMinutes === 45 && store.settings.breakSeconds === 180)
  check('a new interval restarts the countdown', store.snapshot().nextDueAt === clock + minutes(45))
  check('configure persisted', existsSync(file))
  store = createReminderStore({ file, now, settings: { intervalMinutes: 60, breakSeconds: 120 } })
  snapshot = store.snapshot()
  check('saved settings beat the config seed', snapshot.settings.intervalMinutes === 45, snapshot.settings.intervalMinutes)
  check('saved break length survives', snapshot.settings.breakSeconds === 180)

  // --- clamping -----------------------------------------------------------
  store.configure({ intervalMinutes: 1, breakSeconds: 10, snoozeMinutes: 0 })
  check('interval clamps up to 5', store.settings.intervalMinutes === 5)
  check('break clamps up to 30 s', store.settings.breakSeconds === 30)
  check('snooze clamps up to 1 min', store.settings.snoozeMinutes === 1)
  store.configure({ intervalMinutes: 9_999, breakSeconds: 9_999, snoozeMinutes: 9_999 })
  check('interval clamps down to 480', store.settings.intervalMinutes === 480)
  check('break clamps down to 900 s', store.settings.breakSeconds === 900)
  check('snooze clamps down to 60 min', store.settings.snoozeMinutes === 60)
  store.configure({ intervalMinutes: 60, breakSeconds: 120, snoozeMinutes: 10, sound: 'yes', notify: 1 })
  check('non-boolean sound is ignored', store.settings.sound === true && store.settings.notify === false)

  // --- due / re-anchor ----------------------------------------------------
  clock = store.snapshot().nextDueAt
  check('due exactly on time', store.isDue() === true)
  snapshot = store.markDue()
  check('markDue records when it fired', snapshot.dueAt === clock)
  check('markDue schedules the next interval', snapshot.nextDueAt === clock + minutes(60))
  clock += minutes(3)
  check('not due again', store.isDue() === false)
  store.reanchor()
  check('reanchor restarts from now', store.snapshot().nextDueAt === clock + minutes(60))

  // --- a stand ------------------------------------------------------------
  store = createReminderStore({ file, now, settings: { intervalMinutes: 60, breakSeconds: 120, snoozeMinutes: 10 } })
  clock = Date.parse('2026-10-30T10:00:00+08:00')
  snapshot = store.ack('stood', { breakSeconds: 120 })
  check('stood counts today', snapshot.today.stands === 1)
  check('stood books the break minutes', snapshot.today.seconds === 120)
  check('stood starts the hour after the break', snapshot.nextDueAt === clock + minutes(2) + minutes(60))
  check('stood moves the sit start past the break', snapshot.sittingSince === clock + minutes(2))
  check('snooze marker cleared', snapshot.snoozedUntil === null)

  clock += minutes(2)
  snapshot = store.ack('sat-down', {})
  check('sitting down early restarts the hour now', snapshot.nextDueAt === clock + minutes(60))
  check('sitting down moves the sit start', snapshot.sittingSince === clock)

  // --- snooze / skip ------------------------------------------------------
  snapshot = store.ack('snooze', {})
  check('snooze uses the default 10 minutes', snapshot.nextDueAt === clock + minutes(10))
  check('snooze is marked', snapshot.snoozedUntil === clock + minutes(10))
  snapshot = store.ack('snooze', { minutes: 30 })
  check('snooze accepts an override', snapshot.nextDueAt === clock + minutes(30))
  snapshot = store.ack('snooze', { minutes: 0 })
  check('a zero snooze clamps to one minute', snapshot.nextDueAt === clock + minutes(1))
  snapshot = store.ack('skip', {})
  check('skip is a full interval', snapshot.nextDueAt === clock + minutes(60))
  check('skip clears the snooze marker', snapshot.snoozedUntil === null)
  assert.throws(() => store.ack('bogus'), /未知动作/)

  // --- enable / disable ---------------------------------------------------
  clock += minutes(5)
  snapshot = store.setEnabled(false)
  check('disable clears the schedule', snapshot.nextDueAt === null && snapshot.enabled === false)
  clock += minutes(120)
  check('disabled store never reports due', store.isDue() === false)
  snapshot = store.setEnabled(true)
  check('re-enable schedules one interval out', snapshot.nextDueAt === clock + minutes(60))

  // --- daily counter ------------------------------------------------------
  const otherDay = '2026-10-29'
  const saved = JSON.parse(readFileSync(file, 'utf8'))
  saved.today = { date: otherDay, stands: 7, seconds: 900 }
  writeFileSync(file, JSON.stringify(saved), 'utf8')
  store = createReminderStore({ file, now })
  check('a new day resets the counter', store.snapshot().today.stands === 0)

  // --- corrupt file -------------------------------------------------------
  const corruptFile = join(dir, 'corrupt.json')
  writeFileSync(corruptFile, '{ not json', 'utf8')
  const corrupt = createReminderStore({ file: corruptFile, now })
  check('a corrupt file starts from defaults', corrupt.snapshot().settings.intervalMinutes === 60)
  check('a corrupt file is explained', /不是合法 JSON/.test(corrupt.snapshot().note ?? ''))
  const backups = readdirSync(dir).filter((name) => name.startsWith('corrupt.json.corrupt-'))
  check('the broken bytes were kept', backups.length === 1, backups.join(','))
  check('the fresh state is writable', existsSync(file))

  console.log(failures.length === 0 ? 'store.mjs: ok' : `store.mjs: ${failures.length} failure(s)`)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
process.exit(failures.length === 0 ? 0 : 1)
