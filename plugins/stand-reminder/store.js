/**
 * The reminder itself: settings, the schedule, and today's stands. One JSON
 * document, owned by the Host half.
 *
 * No Cordis context here on purpose — `index.js` wires this store to a timer,
 * the Web routes and the agent tool, and `test/store.mjs` drives it directly.
 * Scheduling is a pair of timestamps, never a live `setTimeout`, so a Host
 * restart (or a sleeping laptop) simply resumes from the file instead of
 * replaying every reminder that was missed. Every mutation persists
 * immediately (write-temp + rename) and then notifies the subscribers.
 */
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The window's presets are a subset of these bounds; the tool may send any. */
export const LIMITS = {
  intervalMinutes: [5, 480],
  breakSeconds: [30, 900],
  snoozeMinutes: [1, 60],
}
/** `snooze` accepts a one-off override (the tool's 「两小时别提醒」). */
const SNOOZE_MAX_MINUTES = 12 * 60

export const DEFAULT_SETTINGS = {
  intervalMinutes: 60,
  breakSeconds: 120,
  snoozeMinutes: 10,
  sound: true,
  notify: false,
}

const describe = (error) => (error instanceof Error ? error.message : String(error))

/** Local calendar day, so the daily counter rolls at midnight, not at UTC. */
function dayKey(timestamp) {
  const date = new Date(timestamp)
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${date.getFullYear()}-${month}-${day}`
}

function clampInt(value, [min, max], fallback) {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function normalizeSettings(value, base = DEFAULT_SETTINGS) {
  const source = typeof value === 'object' && value !== null ? value : {}
  return {
    intervalMinutes: clampInt(source.intervalMinutes, LIMITS.intervalMinutes, base.intervalMinutes),
    breakSeconds: clampInt(source.breakSeconds, LIMITS.breakSeconds, base.breakSeconds),
    snoozeMinutes: clampInt(source.snoozeMinutes, LIMITS.snoozeMinutes, base.snoozeMinutes),
    sound: typeof source.sound === 'boolean' ? source.sound : base.sound,
    notify: typeof source.notify === 'boolean' ? source.notify : base.notify,
  }
}

/**
 * @param {{
 *   file: string,
 *   settings?: Partial<typeof DEFAULT_SETTINGS>,
 *   enabled?: boolean,
 *   now?: () => number,
 * }} options
 */
export function createReminderStore(options = {}) {
  const file = typeof options.file === 'string' ? options.file : ''
  const now = typeof options.now === 'function' ? options.now : Date.now
  const seedSettings = normalizeSettings(options.settings)
  const seedEnabled = typeof options.enabled === 'boolean' ? options.enabled : true

  const current = now()
  let settings = { ...seedSettings }
  let enabled = seedEnabled
  /** The moment the next reminder is due; `null` means "no reminder scheduled". */
  let nextDueAt = enabled ? current + settings.intervalMinutes * 60_000 : null
  /** The last time a reminder was actually shown (for stats and diagnostics). */
  let dueAt = null
  /** Start of the current sitting period: the break end after the last stand. */
  let sittingSince = current - settings.intervalMinutes * 60_000
  /** Set while the next reminder is a snooze, `null` otherwise. */
  let snoozedUntil = null
  /** @type {{date: string, stands: number, seconds: number}} */
  let today = { date: dayKey(current), stands: 0, seconds: 0 }
  let note = null
  let version = 0
  const listeners = new Set()

  const intervalMs = () => settings.intervalMinutes * 60_000
  const breakMs = () => settings.breakSeconds * 1_000

  function rollDay() {
    const todayKey = dayKey(now())
    if (today.date === todayKey) return false
    today = { date: todayKey, stands: 0, seconds: 0 }
    return true
  }

  function load() {
    if (file === '') return
    let raw
    try {
      raw = readFileSync(file, 'utf8')
    } catch (error) {
      // A missing file is the normal first run; anything else is a warning.
      if (error?.code !== 'ENOENT') note = `提醒状态读取失败：${describe(error)}`
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      // Keep the broken bytes next to the file instead of silently dropping them.
      note = `提醒状态不是合法 JSON，已备份并从默认设置开始：${describe(error)}`
      try {
        copyFileSync(file, `${file}.corrupt-${now()}`)
      } catch {
        /* the file may be unreadable for the same reason it is invalid */
      }
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return

    settings = normalizeSettings(parsed.settings, seedSettings)
    enabled = typeof parsed.enabled === 'boolean' ? parsed.enabled : seedEnabled
    dueAt = Number.isFinite(parsed.dueAt) ? parsed.dueAt : null
    sittingSince = Number.isFinite(parsed.sittingSince) ? parsed.sittingSince : now() - intervalMs()
    snoozedUntil = Number.isFinite(parsed.snoozedUntil) ? parsed.snoozedUntil : null
    if (typeof parsed.today === 'object' && parsed.today !== null) {
      today = {
        date: typeof parsed.today.date === 'string' ? parsed.today.date : dayKey(now()),
        stands: Number.isFinite(parsed.today.stands) ? Math.max(0, Math.trunc(parsed.today.stands)) : 0,
        seconds: Number.isFinite(parsed.today.seconds) ? Math.max(0, Math.trunc(parsed.today.seconds)) : 0,
      }
    }

    // A clock jump or a long shutdown must not leave the schedule absurdly far
    // away; more than two intervals ahead is treated as a fresh start.
    const currentNow = now()
    if (Number.isFinite(parsed.nextDueAt) && parsed.nextDueAt - currentNow <= intervalMs() * 2) {
      nextDueAt = parsed.nextDueAt
    } else {
      nextDueAt = enabled ? currentNow + intervalMs() : null
    }
    if (!enabled) nextDueAt = null
    rollDay()
  }

  function persist() {
    if (file === '') return
    try {
      mkdirSync(dirname(file), { recursive: true })
      const temp = `${file}.${process.pid}.tmp`
      const body = {
        version: 1,
        enabled,
        settings,
        nextDueAt,
        dueAt,
        sittingSince,
        snoozedUntil,
        today,
      }
      writeFileSync(temp, `${JSON.stringify(body, null, 2)}\n`, 'utf8')
      renameSync(temp, file)
    } catch (error) {
      note = `提醒状态写入失败（改动只在内存里）：${describe(error)}`
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

  function snapshot() {
    rollDay()
    return {
      version,
      enabled,
      settings: { ...settings },
      nextDueAt,
      dueAt,
      sittingSince,
      snoozedUntil,
      today: { ...today },
      file,
      note,
      serverNow: now(),
    }
  }

  /** Enabled and the scheduled moment has arrived. */
  function isDue(at = now()) {
    return enabled && Number.isFinite(nextDueAt) && at >= nextDueAt
  }

  /** Push the schedule one interval out without counting a stand. */
  function reanchor(at = now()) {
    if (!enabled) {
      nextDueAt = null
      return
    }
    nextDueAt = at + intervalMs()
    snoozedUntil = null
    emit()
  }

  /** The reminder was shown: start the next hour from now. */
  function markDue(at = now()) {
    dueAt = at
    snoozedUntil = null
    nextDueAt = enabled ? at + intervalMs() : null
    rollDay()
    emit()
    return snapshot()
  }

  function setEnabled(on) {
    const next = on === true
    if (enabled === next) return snapshot()
    enabled = next
    if (enabled) {
      nextDueAt = now() + intervalMs()
      sittingSince = now()
      snoozedUntil = null
    } else {
      nextDueAt = null
      snoozedUntil = null
    }
    emit()
    return snapshot()
  }

  function configure(patch) {
    if (typeof patch !== 'object' || patch === null) return snapshot()
    const before = settings
    const requested = {}
    for (const key of ['intervalMinutes', 'breakSeconds', 'snoozeMinutes']) {
      if (patch[key] !== undefined) requested[key] = patch[key]
    }
    for (const key of ['sound', 'notify']) {
      if (typeof patch[key] === 'boolean') requested[key] = patch[key]
    }
    const next = normalizeSettings({ ...settings, ...requested }, settings)
    const intervalChanged = next.intervalMinutes !== before.intervalMinutes
    settings = next
    if (typeof patch.enabled === 'boolean' && patch.enabled !== enabled) {
      return setEnabled(patch.enabled)
    }
    // A new interval means "count from now": the user just set the clock.
    if (intervalChanged && enabled) {
      nextDueAt = now() + intervalMs()
      snoozedUntil = null
    }
    emit()
    return snapshot()
  }

  /**
   * `stood` — the user got up; the sit counter restarts after the break ends.
   * `sat-down` — the user ended the break early; count from now.
   * `snooze` — ask again in N minutes.
   * `skip` — drop this round, next one is a full interval away.
   */
  function ack(action, options = {}) {
    const at = now()
    const breakSeconds = clampInt(options.breakSeconds, LIMITS.breakSeconds, settings.breakSeconds)
    rollDay()
    if (action === 'stood') {
      today = { ...today, stands: today.stands + 1, seconds: today.seconds + breakSeconds }
      sittingSince = at + breakSeconds * 1_000
      nextDueAt = enabled ? sittingSince + intervalMs() : null
      snoozedUntil = null
    } else if (action === 'sat-down') {
      sittingSince = at
      nextDueAt = enabled ? at + intervalMs() : null
      snoozedUntil = null
    } else if (action === 'snooze') {
      const minutes = clampInt(options.minutes, [1, SNOOZE_MAX_MINUTES], settings.snoozeMinutes)
      nextDueAt = at + minutes * 60_000
      snoozedUntil = nextDueAt
      // Snoozing means "still sitting here" — keep the sit counter running.
    } else if (action === 'skip') {
      sittingSince = at
      nextDueAt = enabled ? at + intervalMs() : null
      snoozedUntil = null
    } else {
      throw new Error(`未知动作：${action}`)
    }
    emit()
    return snapshot()
  }

  load()
  rollDay()

  return {
    file,
    get settings() {
      return { ...settings }
    },
    get enabled() {
      return enabled
    },
    get version() {
      return version
    },
    get note() {
      return note
    },
    snapshot,
    isDue,
    markDue,
    reanchor,
    setEnabled,
    configure,
    ack,
    /** @param {() => void} listener */
    onChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
