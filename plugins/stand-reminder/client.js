/**
 * Client half of the stand-reminder bundle.
 *
 * One data source (the Host's `/plugins/stand-reminder` routes), two seats:
 *   conversation.session.header.utilities → 「站 · 42m」countdown / settings entry
 *   shell.overlay                          → the reminder window itself
 *
 * The window has four faces: `stand` (the reminder), `break` (standing
 * countdown), `done` (a short congratulation) and `setup` (interval, break
 * length, snooze, sound, notifications). Only the Host owns the schedule: this
 * half renders `nextDueAt` and never runs its own hour timer, so reloading the
 * page does not restart the hour. Pure-JS module: React comes from the browser
 * module table, styles use host theme tokens only.
 */
window.__ModuleLoader__.load({
  id: '@local/stand-reminder',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'stand-reminder'
    const API = '/plugins/stand-reminder'
    /** How long the `done` face stays up before closing itself. */
    const DONE_CLOSE_MS = 6_000

    const zh = {
      nav: '站一站',
      title: '站起来动一动',
      eyebrow: '久坐提醒',
      sitFor: '已经坐了 {minutes} 分钟。',
      body: '起身走两步，转转肩颈，看看远处。',
      stood: '我站起来了',
      breakFor: '休息 {minutes} 分钟',
      snooze: '稍后 {minutes} 分钟',
      snoozeShort: '稍后提醒',
      skip: '跳过这次',
      dismissStand: '按 Esc 或点空白处 = 稍后提醒',
      settings: '设置',
      nextIn: '下次提醒 {time}后',
      soon: '马上提醒',
      off: '提醒已关闭',
      offShort: '关',
      loading: '正在读取提醒…',
      loadFailed: '读不到提醒数据，确认 Host 半已启用。',
      breakTitle: '站着，很好',
      breakBody: '走两步，转转眼，深呼吸。',
      breakLeft: '还剩 {time}',
      sitting: '站立中',
      sitDown: '提前坐下',
      doneTitle: '站得不错',
      doneBody: '接下来 {time} 安心坐着。',
      doneOk: '好',
      setupTitle: '久坐提醒',
      setupNext: '下一次：{time}后（{clock}）',
      enable: '开启提醒',
      interval: '提醒间隔',
      breakLen: '休息时长',
      snoozeLen: '稍后提醒',
      sound: '提示音',
      notify: '后台系统通知',
      notifyHint: '页面在后台时改用系统通知；需要浏览器授权。',
      notifyAllow: '授权系统通知',
      notifyBlocked: '浏览器拒绝了通知权限，只会在页面里弹窗。',
      notifyDenied: '当前浏览器不支持或未授权系统通知。',
      today: '今天：站起来 {stands} 次 · 共 {minutes} 分钟',
      remindNow: '现在提醒一次',
      close: '完成',
      kicker: '每 {interval} 分钟站起来，休息 {break} 分钟',
      unavailable: '页面没连上 Host，这次没有弹窗。',
      settingsHint: '提醒窗的 × 等于「稍后提醒」。',
    }

    const en = {
      nav: 'Stand up',
      title: 'Time to stand up',
      eyebrow: 'Sitting reminder',
      sitFor: 'You have been sitting for {minutes} min.',
      body: 'Walk a little, roll your shoulders, look far away.',
      stood: 'I stood up',
      breakFor: 'Take {minutes} min',
      snooze: 'Snooze {minutes} min',
      snoozeShort: 'Snooze',
      skip: 'Skip this one',
      dismissStand: 'Esc or click outside = snooze',
      settings: 'Settings',
      nextIn: 'Next reminder in {time}',
      soon: 'Any moment',
      off: 'Reminders are off',
      offShort: 'off',
      loading: 'Reading the reminder…',
      loadFailed: 'Could not read the reminder data. Is the Host half enabled?',
      breakTitle: 'Standing — nice',
      breakBody: 'Walk, look around, breathe.',
      breakLeft: '{time} left',
      sitting: 'Standing',
      sitDown: 'Sit down early',
      doneTitle: 'Well done',
      doneBody: 'Sit comfortably for the next {time}.',
      doneOk: 'OK',
      setupTitle: 'Sitting reminder',
      setupNext: 'Next: in {time} ({clock})',
      enable: 'Enable reminders',
      interval: 'Every',
      breakLen: 'Break',
      snoozeLen: 'Snooze',
      sound: 'Chime',
      notify: 'System notification',
      notifyHint: 'Use a system notification while the page is in the background; needs browser permission.',
      notifyAllow: 'Allow notifications',
      notifyBlocked: 'The browser refused notifications; the window will still pop up.',
      notifyDenied: 'This browser does not support notifications here.',
      today: 'Today: {stands} stands · {minutes} min',
      remindNow: 'Remind me now',
      close: 'Done',
      kicker: 'Stand every {interval} min and rest {break} min',
      unavailable: 'The page could not reach the Host, so no window was shown.',
      settingsHint: 'The reminder window’s × means “snooze”.',
    }

    const fill = (text, values) => text.replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match))
    const describe = (error) => (error instanceof Error ? error.message : String(error))

    function makeTranslator(bind) {
      return (translateProps) => {
        if (typeof translateProps?.t === 'function') return translateProps.t
        return (key) => {
          try {
            const text = bind(key)
            return typeof text === 'string' && text !== '' ? text : (zh[key] ?? key)
          } catch {
            return zh[key] ?? key
          }
        }
      }
    }

    // --- time formatting ---------------------------------------------------
    function formatSpan(ms) {
      const total = Math.max(0, Math.ceil(ms / 1_000))
      // Long horizons read better in whole minutes; short ones keep seconds.
      if (total >= 600) {
        const minutes = Math.ceil(total / 60)
        if (minutes >= 60) return `${Math.floor(minutes / 60)} 小时 ${String(minutes % 60).padStart(2, '0')} 分`
        return `${minutes} 分钟`
      }
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      if (minutes > 0) return seconds > 0 ? `${minutes} 分 ${String(seconds).padStart(2, '0')} 秒` : `${minutes} 分钟`
      return `${seconds} 秒`
    }

    /** Narrow header label: 42m / 1h05 / 12s. */
    function formatCompact(ms) {
      const total = Math.max(0, Math.ceil(ms / 1_000))
      if (total >= 3_600) {
        const hours = Math.floor(total / 3_600)
        const minutes = Math.floor((total % 3_600) / 60)
        return `${hours}h${String(minutes).padStart(2, '0')}`
      }
      if (total >= 60) return `${Math.ceil(total / 60)}m`
      return `${total}s`
    }

    function formatClock(timestamp) {
      try {
        return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(timestamp))
      } catch {
        return ''
      }
    }

    function formatCountdown(ms) {
      const total = Math.max(0, Math.ceil(ms / 1_000))
      const minutes = Math.floor(total / 60)
      const seconds = total % 60
      return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    }

    // --- reminder state ----------------------------------------------------
    const state = {
      enabled: true,
      settings: { intervalMinutes: 60, breakSeconds: 120, snoozeMinutes: 10, sound: true, notify: false },
      nextDueAt: null,
      dueAt: null,
      sittingSince: null,
      snoozedUntil: null,
      today: { date: '', stands: 0, seconds: 0 },
      /** `serverNow - Date.now()`; keeps the countdown honest across clock skew. */
      offset: 0,
      loaded: false,
      error: null,
      note: null,
      listeners: new Set(),
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      emit() {
        for (const listener of [...this.listeners]) listener()
      },
      apply(payload) {
        if (typeof payload !== 'object' || payload === null) return
        if (Number.isFinite(payload.serverNow)) this.offset = payload.serverNow - Date.now()
        if (typeof payload.enabled === 'boolean') this.enabled = payload.enabled
        if (typeof payload.settings === 'object' && payload.settings !== null) this.settings = { ...this.settings, ...payload.settings }
        this.nextDueAt = Number.isFinite(payload.nextDueAt) ? payload.nextDueAt : null
        this.dueAt = Number.isFinite(payload.dueAt) ? payload.dueAt : null
        this.sittingSince = Number.isFinite(payload.sittingSince) ? payload.sittingSince : null
        this.snoozedUntil = Number.isFinite(payload.snoozedUntil) ? payload.snoozedUntil : null
        if (typeof payload.today === 'object' && payload.today !== null) this.today = { ...this.today, ...payload.today }
        this.note = typeof payload.note === 'string' ? payload.note : null
        this.loaded = true
        this.error = null
        this.emit()
      },
      fail(error) {
        this.error = describe(error)
        this.emit()
      },
    }

    const serverNow = () => Date.now() + state.offset

    function useReminder() {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const off = state.subscribe(() => bump((value) => value + 1))
        startData()
        return off
      }, [])
      return state
    }

    // --- window state ------------------------------------------------------
    const ui = {
      /** closed | stand | break | done | setup */
      view: 'closed',
      breakEndsAt: 0,
      breakTotal: 0,
      closeTimer: null,
      listeners: new Set(),
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      emit() {
        for (const listener of [...this.listeners]) listener()
      },
      open(view) {
        // A running break owns the window: a second due event must not wipe it.
        if (this.view === 'break' && view !== 'break') return
        this.view = view
        this.emit()
      },
      close() {
        if (this.view === 'closed') return
        if (this.closeTimer !== null) clearTimeout(this.closeTimer)
        this.closeTimer = null
        this.view = 'closed'
        this.emit()
      },
      startBreak(seconds) {
        if (this.closeTimer !== null) clearTimeout(this.closeTimer)
        this.closeTimer = null
        this.breakTotal = Math.max(1, Math.round(seconds))
        this.breakEndsAt = Date.now() + this.breakTotal * 1_000
        this.view = 'break'
        this.emit()
      },
      finishBreak() {
        if (this.view !== 'break') return
        this.view = 'done'
        this.closeTimer = setTimeout(() => {
          if (this.view === 'done') this.close()
        }, DONE_CLOSE_MS)
        this.emit()
      },
    }

    function useUi() {
      const [, bump] = React.useState(0)
      React.useEffect(() => ui.subscribe(() => bump((value) => value + 1)), [])
      return ui
    }

    /** Re-render once a second while the window/header is showing a countdown. */
    function useTick(enabled = true, interval = 1_000) {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        if (!enabled) return undefined
        const id = setInterval(() => bump((value) => value + 1), interval)
        return () => clearInterval(id)
      }, [enabled, interval])
      return Date.now()
    }

    // --- transport ---------------------------------------------------------
    async function requestJson(url, init) {
      const response = await fetch(url, { cache: 'no-store', ...init })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        const message = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
        throw new Error(message)
      }
      return payload ?? {}
    }

    const post = (path, body) =>
      requestJson(`${API}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })

    async function refresh() {
      try {
        state.apply(await requestJson(`${API}/state`))
      } catch (error) {
        state.fail(error)
      }
    }

    /** One `due` must produce one window, whichever transport reports it first. */
    let presentedDueAt = 0

    function presentReminder(at) {
      if (Number.isFinite(at) && at === presentedDueAt) return
      if (Number.isFinite(at)) presentedDueAt = at
      if (ui.view === 'break') return
      // Already showing the prompt (the user has not answered yet): a second
      // transport reporting the same reminder must not ring twice.
      if (ui.view === 'stand') return
      ui.open('stand')
      chime(state.settings)
      notify(state.settings, sitMinutes())
    }

    function applyPayload(payload) {
      const before = state.dueAt
      state.apply(payload)
      // The poll fallback (or a reconnect snapshot) may be the first to tell us
      // a reminder fired; a stale one is ignored.
      if (
        Number.isFinite(state.dueAt) &&
        state.dueAt !== before &&
        Date.now() + state.offset - state.dueAt <= 90_000
      ) {
        presentReminder(state.dueAt)
      }
    }

    let started = false
    let pushSource = null
    let pollTimer = null

    function startPollFallback() {
      if (pollTimer !== null) return
      pollTimer = setInterval(() => void refresh(), 5_000)
    }

    function stopPollFallback() {
      if (pollTimer === null) return
      clearInterval(pollTimer)
      pollTimer = null
    }

    const parseEvent = (event) => {
      try {
        return JSON.parse(event.data)
      } catch {
        return null
      }
    }

    function openPush() {
      if (pushSource !== null) return
      if (typeof EventSource !== 'function') {
        startPollFallback()
        return
      }
      let source
      try {
        source = new EventSource(`${API}/events`)
      } catch {
        startPollFallback()
        return
      }
      pushSource = source
      source.addEventListener('open', () => {
        stopPollFallback()
        void refresh()
      })
      source.addEventListener('snapshot', (event) => {
        const payload = parseEvent(event)
        if (payload !== null) applyPayload(payload)
      })
      source.addEventListener('state', (event) => {
        const payload = parseEvent(event)
        if (payload !== null) applyPayload(payload)
      })
      source.addEventListener('due', (event) => {
        const payload = parseEvent(event)
        if (payload !== null && Number.isFinite(payload.at)) presentReminder(payload.at)
      })
      source.addEventListener('error', () => startPollFallback())
    }

    function startData() {
      if (started) return
      started = true
      openPush()
      void refresh()
    }

    // --- sound -------------------------------------------------------------
    let audio = null

    function audioContext() {
      if (audio !== null) return audio
      const Ctor = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null
      if (typeof Ctor !== 'function') return null
      try {
        audio = new Ctor()
      } catch {
        audio = null
      }
      return audio
    }

    /** A soft two-note cue; silently skipped when the browser blocks audio. */
    function chime(settings) {
      if (!settings?.sound) return
      const ctx = audioContext()
      if (ctx === null) return
      const play = () => {
        try {
          const start = ctx.currentTime
          for (const [index, frequency] of [[0, 660], [0.19, 880]].map(([offset, value]) => [offset, value])) {
            const oscillator = ctx.createOscillator()
            const gain = ctx.createGain()
            oscillator.type = 'sine'
            oscillator.frequency.value = frequency
            gain.gain.setValueAtTime(0.0001, start + index)
            gain.gain.exponentialRampToValueAtTime(0.075, start + index + 0.03)
            gain.gain.exponentialRampToValueAtTime(0.0001, start + index + 0.42)
            oscillator.connect(gain)
            gain.connect(ctx.destination)
            oscillator.start(start + index)
            oscillator.stop(start + index + 0.45)
          }
        } catch {
          /* audio is a nicety, never a requirement */
        }
      }
      if (ctx.state === 'suspended') ctx.resume().then(play).catch(() => {})
      else play()
    }

    function unlockAudio() {
      const ctx = audioContext()
      if (ctx !== null && ctx.state === 'suspended') ctx.resume().catch(() => {})
    }

    // --- system notification ----------------------------------------------
    function notificationPermission() {
      try {
        return typeof window !== 'undefined' && typeof window.Notification === 'function'
          ? window.Notification.permission
          : 'unsupported'
      } catch {
        return 'unsupported'
      }
    }

    async function requestNotificationPermission() {
      if (notificationPermission() !== 'default') return notificationPermission() === 'granted'
      try {
        const result = await window.Notification.requestPermission()
        return result === 'granted'
      } catch {
        return false
      }
    }

    function notify(settings, minutes) {
      if (!settings?.notify) return
      if (notificationPermission() !== 'granted') return
      if (typeof document === 'undefined' || !document.hidden) return
      try {
        const notification = new window.Notification('站起来动一动', {
          body: fill(zh.sitFor, { minutes }) + zh.body,
          tag: 'dsh-stand-reminder',
          renotify: true,
          silent: true,
        })
        notification.onclick = () => {
          try {
            window.focus()
          } catch {
            /* nothing to focus onto */
          }
          notification.close()
          ui.open('stand')
        }
      } catch {
        /* a blocked notification is not a failure worth showing */
      }
    }

    function sitMinutes() {
      if (!Number.isFinite(state.sittingSince)) return state.settings.intervalMinutes
      return Math.max(1, Math.floor((serverNow() - state.sittingSince) / 60_000))
    }

    // --- styles ------------------------------------------------------------
    const CSS = `
@keyframes dsh-stand-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes dsh-stand-rise { from { opacity: 0; transform: translateY(10px) scale(0.985); } to { opacity: 1; transform: none; } }
@keyframes dsh-stand-glow { from { opacity: 0.5; transform: scale(0.98); } to { opacity: 1; transform: scale(1.02); } }
@keyframes dsh-stand-pulse { from { opacity: 0.45; } to { opacity: 1; } }
.dsh-stand-backdrop { position: fixed; inset: 0; z-index: 60; display: flex; align-items: center; justify-content: center; padding: 20px; background: rgba(6, 10, 16, 0.42); backdrop-filter: blur(3px); -webkit-backdrop-filter: blur(3px); animation: dsh-stand-fade 160ms ease-out; overflow: auto; }
.dsh-stand-card { position: relative; width: min(400px, 100%); max-height: calc(100vh - 40px); display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l2); border-radius: 16px; background: var(--dsw-alias-bg-overlay); box-shadow: 0 28px 72px -18px rgba(0, 0, 0, 0.5), 0 2px 10px rgba(0, 0, 0, 0.1), 0 0 48px -22px var(--dsw-alias-brand-primary); overflow: hidden; animation: dsh-stand-rise 220ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.dsh-stand-card::before { content: ''; position: absolute; top: 0; left: 14%; right: 14%; height: 1px; background: linear-gradient(90deg, transparent, var(--dsw-alias-brand-primary), transparent); opacity: 0.7; pointer-events: none; z-index: 2; }
.dsh-stand-head { display: flex; align-items: center; gap: 9px; padding: 12px 12px 10px 14px; }
.dsh-stand-badge { width: 28px; height: 28px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-brand-primary); box-shadow: 0 0 16px -8px var(--dsw-alias-brand-primary); }
.dsh-stand-headtext { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1 1 auto; }
.dsh-stand-eyebrow { font-size: 12px; font-weight: 600; letter-spacing: 0.02em; color: var(--dsw-alias-label-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-stand-meta { font-size: 10.5px; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dsh-stand-x { width: 26px; height: 26px; flex: 0 0 auto; padding: 0; border: none; border-radius: 7px; background: transparent; color: var(--dsw-alias-label-secondary); display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background 120ms ease, color 120ms ease; }
.dsh-stand-x:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dsh-stand-body { display: flex; flex-direction: column; gap: 12px; padding: 4px 16px 16px; overflow: auto; min-height: 0; }
.dsh-stand-hero { display: flex; flex-direction: column; align-items: center; gap: 6px; text-align: center; padding: 6px 0 2px; }
.dsh-stand-pulse { width: 92px; height: 92px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: var(--dsw-alias-brand-primary); background: radial-gradient(circle at 50% 42%, var(--dsw-alias-bg-layer-2), transparent 70%); box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1), 0 0 34px -14px var(--dsw-alias-brand-primary); animation: dsh-stand-glow 2.6s ease-in-out infinite alternate; }
.dsh-stand-title { margin: 4px 0 0; font-size: 19px; line-height: 1.3; font-weight: 650; letter-spacing: -0.01em; color: var(--dsw-alias-label-primary); }
.dsh-stand-copy { margin: 0; font-size: 12.5px; line-height: 1.65; color: var(--dsw-alias-label-primary); max-width: 300px; }
.dsh-stand-copy b { color: var(--dsw-alias-label-primary); font-weight: 600; font-variant-numeric: tabular-nums; }
.dsh-stand-primary { width: 100%; height: 42px; border: 1px solid var(--dsw-alias-brand-primary); border-radius: 10px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-size: 13.5px; font-weight: 650; letter-spacing: 0.01em; display: inline-flex; align-items: center; justify-content: center; gap: 7px; cursor: pointer; transition: filter 140ms ease, box-shadow 160ms ease; }
.dsh-stand-primary:hover:not(:disabled) { filter: brightness(1.08); box-shadow: 0 0 22px -6px var(--dsw-alias-brand-primary); }
.dsh-stand-primary:disabled { opacity: 0.55; cursor: default; }
.dsh-stand-row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.dsh-stand-secondary { height: 34px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: transparent; color: var(--dsw-alias-label-primary); font-size: 12px; cursor: pointer; transition: border-color 120ms ease, background 120ms ease; }
.dsh-stand-secondary:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-1); }
.dsh-stand-secondary:disabled { opacity: 0.5; cursor: default; }
.dsh-stand-hint { text-align: center; font-size: 10.5px; color: var(--dsw-alias-label-primary); }
.dsh-stand-foot { display: flex; align-items: center; gap: 7px; padding: 8px 14px 9px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 10.5px; color: var(--dsw-alias-label-secondary); background: var(--dsw-alias-bg-layer-1); }
.dsh-stand-dot { width: 5px; height: 5px; border-radius: 50%; flex: 0 0 auto; background: var(--dsw-alias-brand-primary); box-shadow: 0 0 7px var(--dsw-alias-brand-primary); animation: dsh-stand-pulse 2.6s ease-in-out infinite alternate; }
.dsh-stand-foot-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-stand-link { flex: 0 0 auto; padding: 2px 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 10.5px; cursor: pointer; }
.dsh-stand-link:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.dsh-stand-break { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 10px 0 2px; }
.dsh-stand-ring { position: relative; width: 128px; height: 128px; display: flex; align-items: center; justify-content: center; }
.dsh-stand-ring svg { position: absolute; inset: 0; transform: rotate(-90deg); }
.dsh-stand-ring-text { display: flex; flex-direction: column; align-items: center; gap: 1px; }
.dsh-stand-clock { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 24px; line-height: 1.1; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-primary); }
.dsh-stand-ring-label { font-size: 10px; letter-spacing: 0.08em; color: var(--dsw-alias-label-primary); }
.dsh-stand-row { display: flex; align-items: center; gap: 8px; min-height: 30px; }
.dsh-stand-row-label { flex: 0 0 auto; width: 60px; font-size: 12px; color: var(--dsw-alias-label-primary); }
.dsh-stand-row-value { flex: 1 1 auto; display: flex; flex-wrap: wrap; gap: 4px; justify-content: flex-end; }
.dsh-stand-seg { height: 24px; min-width: 34px; padding: 0 7px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-primary); font-size: 11px; cursor: pointer; font-variant-numeric: tabular-nums; transition: border-color 120ms ease, color 120ms ease, background 120ms ease; }
.dsh-stand-seg[aria-pressed='true'] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-brand-primary); font-weight: 600; box-shadow: 0 0 12px -6px var(--dsw-alias-brand-primary); }
.dsh-stand-status { display: flex; align-items: center; gap: 9px; padding: 9px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); }
.dsh-stand-status-text { flex: 1 1 auto; min-width: 0; font-size: 12px; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.dsh-stand-status-sub { display: block; margin-top: 1px; font-size: 10.5px; color: var(--dsw-alias-label-primary); }
.dsh-stand-switch { position: relative; width: 36px; height: 20px; flex: 0 0 auto; padding: 0; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); cursor: pointer; transition: background 140ms ease, border-color 140ms ease; }
.dsh-stand-switch[aria-checked='true'] { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
.dsh-stand-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--dsw-alias-label-secondary); transition: transform 140ms ease, background 140ms ease; }
.dsh-stand-switch[aria-checked='true']::after { transform: translateX(16px); background: var(--dsw-alias-bg-base); }
.dsh-stand-toggle { display: flex; align-items: flex-start; gap: 9px; padding: 2px 0; }
.dsh-stand-toggle-text { flex: 1 1 auto; min-width: 0; }
.dsh-stand-toggle-label { display: block; font-size: 12px; color: var(--dsw-alias-label-primary); }
.dsh-stand-toggle-sub { display: block; margin-top: 2px; font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.dsh-stand-notice { padding: 7px 9px; border-radius: 7px; border: 1px solid var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-primary); background: var(--dsw-alias-bg-layer-1); font-size: 11px; line-height: 1.5; }
.dsh-stand-stats { font-size: 11px; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.dsh-stand-actions { display: flex; gap: 8px; }
.dsh-stand-actions > * { flex: 1 1 0; }
.dsh-stand-actions > .dsh-stand-primary { height: 36px; }
.dsh-stand-actions > .dsh-stand-secondary { height: 36px; }
.dsh-stand-done-icon { color: var(--dsw-alias-brand-primary); display: flex; align-items: center; justify-content: center; width: 64px; height: 64px; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); box-shadow: 0 0 28px -12px var(--dsw-alias-brand-primary); }
@media (prefers-reduced-motion: reduce) { .dsh-stand-backdrop, .dsh-stand-card, .dsh-stand-pulse, .dsh-stand-dot { animation: none; } .dsh-stand-ring circle { transition: none !important; } }
`

    // --- icons -------------------------------------------------------------
    function StandIcon(props) {
      const size = Number.isFinite(props?.size) ? props.size : 18
      return h(
        'svg',
        { viewBox: '0 0 64 64', width: size, height: size, fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('circle', { cx: 32, cy: 13, r: 6, stroke: 'currentColor', strokeWidth: 3.2 }),
        h('path', { d: 'M32 20v17', stroke: 'currentColor', strokeWidth: 3.2, strokeLinecap: 'round' }),
        h('path', { d: 'M32 25l-10 6M32 25l10 6', stroke: 'currentColor', strokeWidth: 3.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M32 37l-8 15M32 37l8 15', stroke: 'currentColor', strokeWidth: 3.2, strokeLinecap: 'round', strokeLinejoin: 'round' }),
        h('path', { d: 'M14 55h10M40 55h10', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', opacity: 0.45 }),
      )
    }

    function CheckIcon(props) {
      const size = Number.isFinite(props?.size) ? props.size : 26
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M5 12.8l4.2 4.2L19 7.4',
          stroke: 'currentColor',
          strokeWidth: 2.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function closeIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('path', { d: 'M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
      )
    }

    function Ring({ progress, children }) {
      const size = 128
      const stroke = 5
      const radius = (size - stroke) / 2
      const circumference = 2 * Math.PI * radius
      const clamped = Math.min(1, Math.max(0, progress))
      return h(
        'div',
        { className: 'dsh-stand-ring' },
        h(
          'svg',
          { width: size, height: size, viewBox: `0 0 ${size} ${size}`, 'aria-hidden': true },
          h('circle', {
            cx: size / 2,
            cy: size / 2,
            r: radius,
            fill: 'none',
            stroke: 'var(--dsw-alias-bg-layer-2)',
            strokeWidth: stroke,
          }),
          h('circle', {
            cx: size / 2,
            cy: size / 2,
            r: radius,
            fill: 'none',
            stroke: 'var(--dsw-alias-brand-primary)',
            strokeWidth: stroke,
            strokeLinecap: 'round',
            strokeDasharray: `${circumference} ${circumference}`,
            strokeDashoffset: circumference * (1 - clamped),
            style: { transition: 'stroke-dashoffset 0.9s linear' },
          }),
        ),
        children,
      )
    }

    // --- header entry ------------------------------------------------------
    function makeHeaderButton(bind) {
      const pick = makeTranslator(bind)
      return function StandHeaderButton(props) {
        const translate = pick(props)
        const snapshot = useReminder()
        const view = useUi()
        useTick(snapshot.enabled && view.view === 'closed')
        const due = snapshot.enabled && snapshot.nextDueAt !== null ? snapshot.nextDueAt - serverNow() : null
        const active = view.view !== 'closed'
        const countdown = !snapshot.loaded
          ? '…'
          : !snapshot.enabled
            ? translate('offShort')
            : due === null || due <= 0
              ? '0m'
              : formatCompact(due)
        return h(
          'button',
          {
            type: 'button',
            onClick: () => ui.open('setup'),
            'aria-label': translate('nav'),
            'aria-expanded': active,
            title: snapshot.enabled
              ? `${translate('setupTitle')} · ${snapshot.enabled && snapshot.nextDueAt ? fill(translate('nextIn'), { time: formatSpan(snapshot.nextDueAt - serverNow()) }) : translate('soon')}`
              : translate('off'),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 26,
              padding: '0 9px',
              borderRadius: 6,
              border: `1px solid ${active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
              background: active ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
              boxShadow: active ? '0 0 12px -4px var(--dsw-alias-brand-primary)' : 'none',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: 12,
              cursor: 'pointer',
            },
          },
          h(StandIcon, { size: 15 }),
          h('span', { style: { display: 'inline-flex', alignItems: 'baseline', gap: 4 } }, translate('nav'), h(
            'span',
            {
              style: {
                fontSize: 10.5,
                fontVariantNumeric: 'tabular-nums',
                letterSpacing: '0.02em',
                color: snapshot.enabled ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
              },
            },
            countdown,
          )),
        )
      }
    }

    // --- the window --------------------------------------------------------
    function makeWindow(bind) {
      const pick = makeTranslator(bind)

      return function StandWindow(props) {
        const translate = pick(props)
        const snapshot = useReminder()
        const view = useUi()
        const now = useTick(view.view !== 'closed' && view.view !== 'setup')
        const [busy, setBusy] = React.useState(false)
        const [notice, setNotice] = React.useState(null)
        const open = view.view !== 'closed'
        const settings = snapshot.settings

        // Close the break exactly when it ends, even if no re-render started it.
        React.useEffect(() => {
          if (view.view !== 'break') return undefined
          const remaining = Math.max(0, ui.breakEndsAt - Date.now())
          const id = setTimeout(() => ui.finishBreak(), remaining)
          return () => clearTimeout(id)
        }, [view.view, ui.breakEndsAt])

        React.useEffect(() => {
          if (!open) return undefined
          const onKeyDown = (event) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return
            event.preventDefault()
            dismiss()
          }
          window.addEventListener('keydown', onKeyDown)
          return () => window.removeEventListener('keydown', onKeyDown)
        }, [open, view.view, view.breakEndsAt, busy])

        const run = async (work) => {
          if (busy) return false
          setBusy(true)
          setNotice(null)
          try {
            await work()
            return true
          } catch (error) {
            setNotice(describe(error))
            return false
          } finally {
            setBusy(false)
          }
        }

        const ack = async (action, extra = {}) => {
          const payload = await post('ack', { action, ...extra })
          state.apply(payload)
          return payload
        }

        const dismiss = () => {
          const mode = view.view
          ui.close()
          // A dismissal is the last action: send it even while another request
          // is still in flight, so the Host's schedule always learns about it.
          if (mode === 'break') void ack('sat-down').catch(() => {})
          else if (mode === 'stand') void ack('snooze').catch(() => {})
        }

        const standUp = () =>
          run(async () => {
            await ack('stood', { breakSeconds: settings.breakSeconds })
            ui.startBreak(settings.breakSeconds)
          })

        const snooze = () =>
          run(async () => {
            ui.close()
            await ack('snooze', {})
          })

        const skip = () =>
          run(async () => {
            ui.close()
            await ack('skip', {})
          })

        const satDown = () =>
          run(async () => {
            ui.close()
            await ack('sat-down', {})
          })

        const configure = (patch) =>
          run(async () => {
            const payload = await post('settings', patch)
            state.apply(payload)
          })

        const remindNow = () =>
          run(async () => {
            const payload = await post('remind', {})
            state.apply(payload)
            if (payload.shown === false) setNotice(translate('unavailable'))
            else ui.open('stand')
          })

        const toggleNotify = async () => {
          if (settings.notify) {
            await configure({ notify: false })
            return
          }
          const granted = await requestNotificationPermission()
          await configure({ notify: true })
          if (!granted) setNotice(translate(notificationPermission() === 'unsupported' ? 'notifyDenied' : 'notifyBlocked'))
        }

        if (!open) return null

        const due = snapshot.nextDueAt !== null ? snapshot.nextDueAt - serverNow() : null
        const nextLabel =
          !snapshot.enabled
            ? translate('off')
            : due === null
              ? translate('soon')
              : fill(translate('nextIn'), { time: due <= 0 ? ' ' : `${formatSpan(due)}` })

        const head = (subtitle) => {
          const closeLabel =
            view.view === 'stand' ? translate('snoozeShort') : view.view === 'break' ? translate('sitDown') : translate('close')
          return h(
            'div',
            { className: 'dsh-stand-head' },
            h('span', { className: 'dsh-stand-badge' }, h(StandIcon, { size: 17 })),
            h(
              'div',
              { className: 'dsh-stand-headtext' },
              h('span', { className: 'dsh-stand-eyebrow' }, translate(view.view === 'setup' ? 'setupTitle' : 'eyebrow')),
              h('span', { className: 'dsh-stand-meta' }, subtitle),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-stand-x',
                onClick: () => dismiss(),
                'aria-label': closeLabel,
                title: closeLabel,
              },
              closeIcon(),
            ),
          )
        }

        const noticeBanner = notice === null ? null : h('div', { className: 'dsh-stand-notice' }, notice)

        if (view.view === 'stand') {
          const minutes = sitMinutes()
          const breakMinutes = Math.max(1, Math.round(settings.breakSeconds / 60))
          return h(
            'div',
            {
              className: 'dsh-stand-backdrop',
              onClick: (event) => {
                if (event.target === event.currentTarget) dismiss()
              },
            },
            h(
              'div',
              { className: 'dsh-stand-card', role: 'dialog', 'aria-label': translate('title'), 'aria-modal': 'false' },
              h('style', null, CSS),
              head(nextLabel),
              h(
                'div',
                { className: 'dsh-stand-body' },
                h(
                  'div',
                  { className: 'dsh-stand-hero' },
                  h('span', { className: 'dsh-stand-pulse' }, h(StandIcon, { size: 50 })),
                  h('h2', { className: 'dsh-stand-title' }, translate('title')),
                  h(
                    'p',
                    { className: 'dsh-stand-copy' },
                    h('b', null, fill(translate('sitFor'), { minutes })),
                    translate('body'),
                  ),
                ),
                noticeBanner,
                h(
                  'button',
                  { type: 'button', className: 'dsh-stand-primary', disabled: busy, onClick: () => void standUp() },
                  h(StandIcon, { size: 16 }),
                  `${translate('stood')} · ${fill(translate('breakFor'), { minutes: breakMinutes })}`,
                ),
                h(
                  'div',
                  { className: 'dsh-stand-row2' },
                  h(
                    'button',
                    { type: 'button', className: 'dsh-stand-secondary', disabled: busy, onClick: () => void snooze() },
                    fill(translate('snooze'), { minutes: settings.snoozeMinutes }),
                  ),
                  h(
                    'button',
                    { type: 'button', className: 'dsh-stand-secondary', disabled: busy, onClick: () => void skip() },
                    translate('skip'),
                  ),
                ),
                h('div', { className: 'dsh-stand-hint' }, translate('dismissStand')),
              ),
              h(
                'div',
                { className: 'dsh-stand-foot' },
                h('span', { className: 'dsh-stand-dot' }),
                h(
                  'span',
                  { className: 'dsh-stand-foot-text' },
                  fill(translate('kicker'), { interval: settings.intervalMinutes, break: Math.max(1, Math.round(settings.breakSeconds / 60)) }),
                ),
                h(
                  'button',
                  { type: 'button', className: 'dsh-stand-link', onClick: () => ui.open('setup') },
                  translate('settings'),
                ),
              ),
            ),
          )
        }

        if (view.view === 'break') {
          const remaining = Math.max(0, view.breakEndsAt - Date.now())
          const total = Math.max(1_000, view.breakTotal * 1_000)
          return h(
            'div',
            {
              className: 'dsh-stand-backdrop',
              onClick: (event) => {
                if (event.target === event.currentTarget) dismiss()
              },
            },
            h(
              'div',
              { className: 'dsh-stand-card', role: 'dialog', 'aria-label': translate('breakTitle'), 'aria-modal': 'false' },
              h('style', null, CSS),
              head(nextLabel),
              h(
                'div',
                { className: 'dsh-stand-body' },
                h(
                  'div',
                  { className: 'dsh-stand-break' },
                  h(
                    Ring,
                    { progress: remaining / total },
                    h(
                      'div',
                      { className: 'dsh-stand-ring-text' },
                      h('span', { className: 'dsh-stand-clock' }, formatCountdown(remaining)),
                      h('span', { className: 'dsh-stand-ring-label' }, translate('sitting')),
                    ),
                  ),
                  h('h2', { className: 'dsh-stand-title' }, translate('breakTitle')),
                  h('p', { className: 'dsh-stand-copy' }, translate('breakBody')),
                ),
                noticeBanner,
                h(
                  'button',
                  { type: 'button', className: 'dsh-stand-secondary', disabled: busy, onClick: () => void satDown() },
                  translate('sitDown'),
                ),
              ),
              h(
                'div',
                { className: 'dsh-stand-foot' },
                h('span', { className: 'dsh-stand-dot' }),
                h('span', { className: 'dsh-stand-foot-text' }, fill(translate('breakLeft'), { time: formatSpan(remaining) })),
              ),
            ),
          )
        }

        if (view.view === 'done') {
          return h(
            'div',
            {
              className: 'dsh-stand-backdrop',
              onClick: (event) => {
                if (event.target === event.currentTarget) dismiss()
              },
            },
            h(
              'div',
              { className: 'dsh-stand-card', role: 'dialog', 'aria-label': translate('doneTitle'), 'aria-modal': 'false' },
              h('style', null, CSS),
              head(fill(translate('today'), { stands: snapshot.today.stands, minutes: Math.round(snapshot.today.seconds / 60) })),
              h(
                'div',
                { className: 'dsh-stand-body' },
                h(
                  'div',
                  { className: 'dsh-stand-break' },
                  h('span', { className: 'dsh-stand-done-icon' }, h(CheckIcon, { size: 30 })),
                  h('h2', { className: 'dsh-stand-title' }, translate('doneTitle')),
                  h(
                    'p',
                    { className: 'dsh-stand-copy' },
                    fill(translate('doneBody'), {
                      time: formatSpan(Math.max(0, (snapshot.nextDueAt ?? serverNow()) - serverNow())),
                    }),
                  ),
                ),
                h(
                  'button',
                  { type: 'button', className: 'dsh-stand-primary', onClick: () => ui.close() },
                  translate('doneOk'),
                ),
              ),
            ),
          )
        }

        // setup
        const minutesToday = Math.round((snapshot.today.seconds ?? 0) / 60)
        const segments = (key, values, current, unit) =>
          values.map((value) =>
            h(
              'button',
              {
                key: value,
                type: 'button',
                className: 'dsh-stand-seg',
                'aria-pressed': Number(current) === value,
                disabled: busy,
                onClick: () => void configure({ [key]: value }),
              },
              `${value}${unit}`,
            ),
          )

        return h(
          'div',
          {
            className: 'dsh-stand-backdrop',
            onClick: (event) => {
              if (event.target === event.currentTarget) dismiss()
            },
          },
          h(
            'div',
            { className: 'dsh-stand-card', role: 'dialog', 'aria-label': translate('setupTitle'), 'aria-modal': 'false' },
            h('style', null, CSS),
            head(snapshot.enabled ? fill(translate('setupNext'), { time: due === null ? ' ' : formatSpan(Math.max(0, due)), clock: formatClock(snapshot.nextDueAt ?? serverNow()) }) : translate('off')),
            h(
              'div',
              { className: 'dsh-stand-body' },
              !snapshot.loaded && snapshot.error === null
                ? h('div', { className: 'dsh-stand-stats' }, translate('loading'))
                : snapshot.error !== null
                  ? h('div', { className: 'dsh-stand-notice' }, translate('loadFailed'))
                  : null,
              h(
                'div',
                { className: 'dsh-stand-status' },
                h(
                  'div',
                  { className: 'dsh-stand-status-text' },
                  translate('enable'),
                  h(
                    'span',
                    { className: 'dsh-stand-status-sub' },
                    snapshot.enabled
                      ? fill(translate('kicker'), {
                          interval: snapshot.settings.intervalMinutes,
                          break: Math.max(1, Math.round(snapshot.settings.breakSeconds / 60)),
                        })
                      : translate('off'),
                  ),
                ),
                h('button', {
                  type: 'button',
                  role: 'switch',
                  className: 'dsh-stand-switch',
                  'aria-checked': snapshot.enabled,
                  'aria-label': translate('enable'),
                  onClick: () => void configure({ enabled: !snapshot.enabled }),
                }),
              ),
              h(
                'div',
                { className: 'dsh-stand-row' },
                h('span', { className: 'dsh-stand-row-label' }, translate('interval')),
                h('div', { className: 'dsh-stand-row-value' }, segments('intervalMinutes', [30, 45, 60, 90, 120], snapshot.settings.intervalMinutes, '′')),
              ),
              h(
                'div',
                { className: 'dsh-stand-row' },
                h('span', { className: 'dsh-stand-row-label' }, translate('breakLen')),
                h(
                  'div',
                  { className: 'dsh-stand-row-value' },
                  [1, 2, 3, 5].map((value) =>
                    h(
                      'button',
                      {
                        key: value,
                        type: 'button',
                        className: 'dsh-stand-seg',
                        'aria-pressed': Math.round(snapshot.settings.breakSeconds / 60) === value,
                        disabled: busy,
                        onClick: () => void configure({ breakSeconds: value * 60 }),
                      },
                      `${value}′`,
                    ),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'dsh-stand-row' },
                h('span', { className: 'dsh-stand-row-label' }, translate('snoozeLen')),
                h('div', { className: 'dsh-stand-row-value' }, segments('snoozeMinutes', [5, 10, 15, 30], snapshot.settings.snoozeMinutes, '′')),
              ),
              h(
                'div',
                { className: 'dsh-stand-toggle' },
                h(
                  'div',
                  { className: 'dsh-stand-toggle-text' },
                  h('span', { className: 'dsh-stand-toggle-label' }, translate('sound')),
                ),
                h('button', {
                  type: 'button',
                  role: 'switch',
                  className: 'dsh-stand-switch',
                  'aria-checked': snapshot.settings.sound,
                  'aria-label': translate('sound'),
                  onClick: () => void configure({ sound: !snapshot.settings.sound }),
                }),
              ),
              h(
                'div',
                { className: 'dsh-stand-toggle' },
                h(
                  'div',
                  { className: 'dsh-stand-toggle-text' },
                  h('span', { className: 'dsh-stand-toggle-label' }, translate('notify')),
                  h('span', { className: 'dsh-stand-toggle-sub' }, translate('notifyHint')),
                ),
                h('button', {
                  type: 'button',
                  role: 'switch',
                  className: 'dsh-stand-switch',
                  'aria-checked': snapshot.settings.notify,
                  'aria-label': translate('notify'),
                  disabled: busy,
                  onClick: () => void toggleNotify(),
                }),
              ),
              noticeBanner,
              h(
                'div',
                { className: 'dsh-stand-stats' },
                fill(translate('today'), {
                  stands: snapshot.today.stands ?? 0,
                  minutes: minutesToday,
                }),
              ),
              h(
                'div',
                { className: 'dsh-stand-actions' },
                h(
                  'button',
                  { type: 'button', className: 'dsh-stand-secondary', disabled: busy, onClick: () => void remindNow() },
                  translate('remindNow'),
                ),
                h('button', { type: 'button', className: 'dsh-stand-primary', onClick: () => ui.close() }, translate('close')),
              ),
              h('div', { className: 'dsh-stand-hint' }, translate('settingsHint')),
            ),
          )
        )
      }
    }

    // --- wiring ------------------------------------------------------------
    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          if (typeof window === 'undefined') return () => {}
          const unlock = () => unlockAudio()
          window.addEventListener('pointerdown', unlock, { once: true })
          window.addEventListener('keydown', unlock, { once: true })
          return () => {
            window.removeEventListener('pointerdown', unlock)
            window.removeEventListener('keydown', unlock)
          }
        }, 'stand-reminder: audio unlock')

        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'stand-reminder: dictionaries')
        const bind = ctx.locale.bind(NS)
        const t = (key) => {
          try {
            const text = bind(key)
            return typeof text === 'string' && text !== '' ? text : (zh[key] ?? key)
          } catch {
            return zh[key] ?? key
          }
        }

        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            {
              name: 'conversation.session.header.utilities',
              id: 'stand-reminder-toggle',
              order: 35,
              label: () => t('nav'),
              locale: NS,
            },
            makeHeaderButton(bind),
          ),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            {
              name: 'shell.overlay',
              id: 'stand-reminder-window',
              order: 45,
              label: () => t('nav'),
              locale: NS,
            },
            makeWindow(bind),
          ),
        )
      },
    }
  },
})
