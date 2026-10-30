/**
 * Client half of the todo-list bundle.
 *
 * One data source (the Host's `/plugins/todo-list` routes), three seats:
 *   conversation.session.header.utilities → 「待办」toggle in the session header
 *   sidebar.footer.action                 → the same toggle beside Settings
 *   shell.overlay                         → the floating panel those toggles open
 *
 * The panel floats over the app without taking the conversation away: it is
 * draggable by its header, closable with × or Escape, and its position is kept
 * for the rest of the page session. Pure-JS module: React comes from the
 * browser module table, styles use host theme tokens only.
 */
window.__ModuleLoader__.load({
  id: '@local/todo-list',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'todo-list'
    const API = '/plugins/todo-list'

    const zh = {
      nav: '待办',
      title: '待办事项',
      count: '{active} 项未完成 · 共 {total} 项',
      placeholder: '添加一条待办，回车保存',
      add: '添加',
      all: '全部',
      active: '未完成',
      done: '已完成',
      clearDone: '清除已完成',
      remove: '删除',
      close: '收起',
      save: '保存',
      cancel: '取消',
      openHint: '打开待办浮窗',
      closeHint: '收起待办浮窗',
      editHint: '双击编辑',
      emptyAll: '还没有待办。在上面输入一条开始。',
      emptyActive: '没有未完成的待办，今天很清爽。',
      emptyDone: '还没有完成的事项。',
      loading: '加载中…',
      loadFailed: '读不到待办数据，确认 Host 半已启用。',
      emptyDraft: '先写点什么再添加。',
      completedAt: '完成于 {date}',
      hint: '与 AI 共用一份清单：聊天里说「加到待办」即可。',
    }

    const en = {
      nav: 'Todos',
      title: 'Todo list',
      count: '{active} open · {total} total',
      placeholder: 'Add a task, press Enter',
      add: 'Add',
      all: 'All',
      active: 'Open',
      done: 'Done',
      clearDone: 'Clear done',
      remove: 'Delete',
      close: 'Hide',
      save: 'Save',
      cancel: 'Cancel',
      openHint: 'Open the todo window',
      closeHint: 'Hide the todo window',
      editHint: 'Double-click to edit',
      emptyAll: 'No todos yet. Add one above to start.',
      emptyActive: 'Nothing open — enjoy the clean slate.',
      emptyDone: 'Nothing completed yet.',
      loading: 'Loading…',
      loadFailed: 'Could not read the todo data. Is the Host half enabled?',
      emptyDraft: 'Write something before adding it.',
      completedAt: 'Done {date}',
      hint: 'Shared with the agent — just say “add this to my todos”.',
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

    // --- window state -------------------------------------------------------
    const ui = {
      open: false,
      position: null,
      listeners: new Set(),
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      emit() {
        for (const listener of [...this.listeners]) listener()
      },
      toggle() {
        this.open = !this.open
        this.emit()
      },
      close() {
        if (!this.open) return
        this.open = false
        this.emit()
      },
    }

    function useUi() {
      const [, bump] = React.useState(0)
      React.useEffect(() => ui.subscribe(() => bump((value) => value + 1)), [])
      return ui
    }

    // --- shortcut -----------------------------------------------------------
    function todoShortcut(event) {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || !event.shiftKey) return false
      return event.code === 'KeyD' || (event.key || '').toLowerCase() === 'd'
    }

    const shortcutLabel = (() => {
      let mac = false
      try {
        mac = /mac/i.test(navigator.platform || '') || /mac/i.test(navigator.userAgentData?.platform || '')
      } catch {
        mac = false
      }
      return mac ? '⌘⇧D' : 'Ctrl+Shift+D'
    })()

    // --- list state ---------------------------------------------------------
    const store = {
      items: [],
      counts: { total: 0, active: 0, done: 0 },
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
        if (typeof payload !== 'object' || payload === null || !Array.isArray(payload.items)) return
        this.items = payload.items
        this.counts = payload.counts ?? {
          total: payload.items.length,
          active: payload.items.filter((item) => !item.done).length,
          done: payload.items.filter((item) => item.done).length,
        }
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

    async function requestJson(url, init) {
      const response = await fetch(url, { cache: 'no-store', ...init })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        const message = payload && typeof payload.error === 'string' ? payload.error : `HTTP ${response.status}`
        throw new Error(message)
      }
      return payload ?? {}
    }

    const act = async (path, body) => {
      try {
        store.apply(
          await requestJson(`${API}/${path}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body ?? {}),
          }),
        )
        return true
      } catch (error) {
        store.fail(error)
        return false
      }
    }

    // --- push transport ----------------------------------------------------
    // Started once per page load: the launcher badge needs live counts even
    // while the panel is closed.
    let started = false
    let pushSource = null
    let pollTimer = null

    async function refresh() {
      try {
        store.apply(await requestJson(`${API}/state`))
      } catch (error) {
        store.fail(error)
      }
    }

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
        if (payload !== null) store.apply(payload)
      })
      source.addEventListener('state', (event) => {
        const payload = parseEvent(event)
        if (payload !== null) store.apply(payload)
      })
      source.addEventListener('error', () => startPollFallback())
    }

    function startData() {
      if (started) return
      started = true
      openPush()
      void refresh()
    }

    function useTodos() {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const off = store.subscribe(() => bump((value) => value + 1))
        startData()
        return off
      }, [])
      return store
    }

    // --- styles ------------------------------------------------------------
    const subtle = { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }

    const CSS = `
@keyframes dsh-todo-enter { from { opacity: 0; transform: translateY(8px) scale(0.985); } to { opacity: 1; transform: none; } }
@keyframes dsh-todo-pulse { from { opacity: 0.45; } to { opacity: 1; } }
.dsh-todo-float { position: fixed; z-index: 40; width: min(408px, calc(100vw - 24px)); max-height: min(580px, calc(100vh - 96px)); display: flex; flex-direction: column; border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; background: var(--dsw-alias-bg-overlay); box-shadow: 0 24px 64px -16px rgba(0, 0, 0, 0.34), 0 2px 8px rgba(0, 0, 0, 0.08), 0 0 42px -18px var(--dsw-alias-brand-primary); pointer-events: auto; overflow: hidden; animation: dsh-todo-enter 160ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.dsh-todo-float::before { content: ''; position: absolute; top: 0; left: 12%; right: 12%; height: 1px; background: linear-gradient(90deg, transparent, var(--dsw-alias-brand-primary), transparent); opacity: 0.6; pointer-events: none; z-index: 2; }
.dsh-todo-float-header { display: flex; align-items: center; gap: 9px; padding: 10px 10px 10px 11px; background: linear-gradient(180deg, var(--dsw-alias-bg-layer-1), var(--dsw-alias-bg-overlay)); cursor: grab; user-select: none; touch-action: none; }
.dsh-todo-float-header:active { cursor: grabbing; }
.dsh-todo-float-title { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
.dsh-todo-progress { height: 2px; background: var(--dsw-alias-bg-layer-2); flex: 0 0 auto; }
.dsh-todo-progress > div { height: 100%; background: var(--dsw-alias-brand-primary); transition: width 220ms ease; }
.dsh-todo-float-body { display: flex; flex-direction: column; gap: 10px; padding: 12px; min-height: 0; flex: 1 1 auto; overflow: hidden; background-image: linear-gradient(rgba(127, 127, 127, 0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(127, 127, 127, 0.05) 1px, transparent 1px); background-size: 26px 26px; }
.dsh-todo-float-list { display: flex; flex-direction: column; overflow: auto; min-height: 72px; flex: 1 1 auto; padding: 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); box-shadow: inset 0 1px 0 rgba(127, 127, 127, 0.06); }
.dsh-todo-float-list::-webkit-scrollbar { width: 10px; }
.dsh-todo-float-list::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2); border-radius: 5px; border: 3px solid transparent; background-clip: padding-box; }
.dsh-todo-float-list::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-label-secondary); border: 3px solid transparent; background-clip: padding-box; }
.dsh-todo-float-row { display: flex; align-items: flex-start; gap: 9px; padding: 9px 10px; border-radius: 7px; transition: background 120ms ease, box-shadow 120ms ease; }
.dsh-todo-float-row:hover { background: var(--dsw-alias-bg-layer-2); box-shadow: inset 2px 0 0 var(--dsw-alias-brand-primary); }
.dsh-todo-float-row .dsh-todo-remove { opacity: 0; transition: opacity 120ms ease, color 120ms ease; }
.dsh-todo-float-row:hover .dsh-todo-remove, .dsh-todo-float-row:focus-within .dsh-todo-remove { opacity: 1; }
.dsh-todo-empty { display: flex; flex-direction: column; align-items: center; gap: 9px; padding: 24px 12px 20px; text-align: center; }
.dsh-todo-empty-badge { width: 40px; height: 40px; border-radius: 10px; border: 1px solid var(--dsw-alias-border-l1); display: flex; align-items: center; justify-content: center; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-brand-primary); box-shadow: 0 0 20px -8px var(--dsw-alias-brand-primary); }
.dsh-todo-check { transition: background 120ms ease, border-color 120ms ease, transform 120ms ease, box-shadow 160ms ease; }
.dsh-todo-check:active { transform: scale(0.92); }
.dsh-todo-check:hover { border-color: var(--dsw-alias-brand-primary) !important; }
.dsh-todo-check.is-done { box-shadow: 0 0 10px -1px var(--dsw-alias-brand-primary); }
.dsh-todo-add:focus, .dsh-todo-edit:focus { outline: none; border-color: var(--dsw-alias-brand-primary) !important; box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary), 0 0 14px -2px var(--dsw-alias-brand-primary); }
.dsh-todo-close { transition: background 120ms ease, color 120ms ease; }
.dsh-todo-close:hover { color: var(--dsw-alias-label-primary) !important; background: var(--dsw-alias-bg-layer-2) !important; }
.dsh-todo-remove:hover { color: var(--dsw-alias-state-error-primary) !important; background: var(--dsw-alias-bg-layer-1) !important; }
.dsh-todo-launcher { transition: background 120ms ease, color 120ms ease; }
.dsh-todo-launcher:hover { background: var(--dsw-alias-bg-layer-2) !important; color: var(--dsw-alias-label-primary) !important; }
.dsh-todo-submit { transition: box-shadow 160ms ease, filter 160ms ease; }
.dsh-todo-submit:hover:not(:disabled) { filter: brightness(1.08); box-shadow: 0 0 18px -4px var(--dsw-alias-brand-primary); }
.dsh-todo-footer { display: flex; align-items: center; gap: 7px; border-top: 1px solid var(--dsw-alias-border-l1); padding: 8px 12px; font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.dsh-todo-footer-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-todo-kbd { flex: 0 0 auto; padding: 3px 5px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 9px; line-height: 1.2; letter-spacing: 0.02em; box-shadow: inset 0 -1px 0 var(--dsw-alias-border-l2); }
.dsh-todo-footer-dot { width: 5px; height: 5px; border-radius: 50%; flex: 0 0 auto; background: var(--dsw-alias-brand-primary); box-shadow: 0 0 7px var(--dsw-alias-brand-primary); animation: dsh-todo-pulse 2.6s ease-in-out infinite alternate; }
@media (prefers-reduced-motion: reduce) { .dsh-todo-float { animation: none; } .dsh-todo-footer-dot { animation: none; } .dsh-todo-float-row, .dsh-todo-check, .dsh-todo-add, .dsh-todo-submit, .dsh-todo-remove, .dsh-todo-progress > div { transition: none; } }
`

    // --- components --------------------------------------------------------
    function TodoIcon(props) {
      const size = Number.isFinite(props?.size) ? props.size : 18
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block', pointerEvents: 'none' },
        },
        h('rect', { x: 3.5, y: 3.5, width: 17, height: 17, rx: 4.5, stroke: 'currentColor', strokeWidth: 1.6 }),
        h('path', {
          d: 'M7.8 12.4l2.7 2.7 5.9-6.1',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
        h('path', { d: 'M8 17.4h8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', opacity: 0.45 }),
      )
    }

    function gripIcon() {
      const dot = (key, x, y) =>
        h('circle', { key, cx: x, cy: y, r: 1.4, fill: 'var(--dsw-alias-label-secondary)', opacity: 0.55 })
      return h(
        'svg',
        { viewBox: '0 0 10 18', width: 10, height: 18, 'aria-hidden': true, style: { display: 'block', flex: '0 0 auto' } },
        dot('a', 3, 4),
        dot('b', 7, 4),
        dot('c', 3, 9),
        dot('d', 7, 9),
        dot('e', 3, 14),
        dot('f', 7, 14),
      )
    }

    function checkMark() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 11, height: 11, 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M2.6 8.4l3 3 7.1-7.2',
          fill: 'none',
          stroke: 'var(--dsw-alias-bg-base)',
          strokeWidth: 2.2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function closeIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M3.8 3.8l8.4 8.4M12.2 3.8l-8.4 8.4',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
        }),
      )
    }

    function trashIcon() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 13, height: 13, fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('path', {
          d: 'M3 4.5h10M6.2 4.5V3h3.6v1.5M4.6 4.5l.6 8h5.6l.6-8',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }),
      )
    }

    function formatDate(timestamp) {
      try {
        return new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric' }).format(new Date(timestamp))
      } catch {
        return ''
      }
    }

    const countBadge = (count) =>
      h(
        'span',
        {
          'aria-hidden': true,
          style: {
            minWidth: 14,
            height: 14,
            padding: '0 3px',
            borderRadius: 7,
            background: 'var(--dsw-alias-brand-primary)',
            color: 'var(--dsw-alias-bg-base)',
            fontSize: 9,
            lineHeight: '14px',
            fontWeight: 600,
            textAlign: 'center',
            boxSizing: 'border-box',
          },
        },
        count > 99 ? '99+' : String(count),
      )

    function makeHeaderToggle(bind) {
      const pick = makeTranslator(bind)
      return function TodoHeaderToggle(props) {
        const translate = pick(props)
        const state = useTodos()
        const view = useUi()
        const active = state.counts?.active ?? 0
        return h(
          'button',
          {
            type: 'button',
            onClick: () => ui.toggle(),
            'aria-label': translate('nav'),
            'aria-expanded': view.open,
            title: `${view.open ? translate('closeHint') : translate('openHint')} · ${shortcutLabel}`,
            className: 'dsh-todo-header-toggle',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 26,
              padding: '0 10px',
              borderRadius: 6,
              border: `1px solid ${view.open ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l1)'}`,
              background: view.open ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
              boxShadow: view.open ? '0 0 12px -4px var(--dsw-alias-brand-primary)' : 'none',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: 12,
              cursor: 'pointer',
            },
          },
          h(TodoIcon, { size: 15 }),
          translate('nav'),
          active > 0 ? countBadge(active) : null,
        )
      }
    }

    function makeFooterToggle(bind) {
      const pick = makeTranslator(bind)
      return function TodoFooterToggle(props) {
        const translate = pick(props)
        const state = useTodos()
        const view = useUi()
        const active = state.counts?.active ?? 0
        return h(
          'button',
          {
            type: 'button',
            onClick: () => ui.toggle(),
            'aria-label': translate('nav'),
            'aria-expanded': view.open,
            title: `${view.open ? translate('closeHint') : translate('openHint')} · ${shortcutLabel}`,
            className: 'dsh-todo-launcher',
            style: {
              position: 'relative',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 32,
              height: 32,
              padding: 0,
              border: '1px solid transparent',
              borderRadius: 8,
              background: view.open ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
              boxShadow: view.open ? '0 0 12px -4px var(--dsw-alias-brand-primary)' : 'none',
              color: view.open ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
              cursor: 'pointer',
            },
          },
          h(TodoIcon, { size: 18 }),
          active > 0
            ? h(
                'span',
                {
                  style: {
                    position: 'absolute',
                    top: -2,
                    right: -2,
                    minWidth: 14,
                    height: 14,
                    padding: '0 3px',
                    borderRadius: 7,
                    background: 'var(--dsw-alias-brand-primary)',
                    color: 'var(--dsw-alias-bg-base)',
                    fontSize: 9,
                    lineHeight: '14px',
                    fontWeight: 600,
                    textAlign: 'center',
                    boxSizing: 'border-box',
                  },
                },
                active > 99 ? '99+' : String(active),
              )
            : null,
        )
      }
    }

    const PANEL_WIDTH = 408
    const PANEL_HEIGHT = 580
    const MARGIN = 8

    function clampPosition(position) {
      const width = Math.min(PANEL_WIDTH, window.innerWidth - MARGIN * 2)
      const height = Math.min(PANEL_HEIGHT, window.innerHeight - MARGIN * 2)
      return {
        left: Math.min(Math.max(MARGIN, position.left), Math.max(MARGIN, window.innerWidth - width - MARGIN)),
        top: Math.min(Math.max(MARGIN, position.top), Math.max(MARGIN, window.innerHeight - height - MARGIN)),
      }
    }

    function defaultPosition() {
      const width = Math.min(PANEL_WIDTH, window.innerWidth - MARGIN * 2)
      return clampPosition({
        left: Math.max(MARGIN, window.innerWidth - width - 24),
        top: Math.max(MARGIN, Math.round(window.innerHeight * 0.12)),
      })
    }

    function makeFloatingPanel(bind) {
      const pick = makeTranslator(bind)

      return function TodoFloatingPanel(props) {
        const translate = pick(props)
        const state = useTodos()
        const view = useUi()
        const [position, setPosition] = React.useState(() => ui.position ?? defaultPosition())
        const [filter, setFilter] = React.useState('all')
        const [draft, setDraft] = React.useState('')
        const [editingId, setEditingId] = React.useState(null)
        const [editDraft, setEditDraft] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [notice, setNotice] = React.useState(null)
        const dragRef = React.useRef(null)
        const commitRef = React.useRef(false)

        React.useEffect(() => {
          const onResize = () => setPosition((current) => clampPosition(current))
          window.addEventListener('resize', onResize)
          return () => window.removeEventListener('resize', onResize)
        }, [])

        React.useEffect(() => {
          if (!view.open) return undefined
          const onKeyDown = (event) => {
            if (event.key === 'Escape' && editingId === null) ui.close()
          }
          window.addEventListener('keydown', onKeyDown)
          return () => window.removeEventListener('keydown', onKeyDown)
        }, [view.open, editingId])

        React.useEffect(() => {
          ui.position = position
        }, [position])

        const counts = state.counts ?? { total: 0, active: 0, done: 0 }
        const items = state.items.filter((item) => (filter === 'done' ? item.done : filter === 'active' ? !item.done : true))

        const run = async (path, body) => {
          setBusy(true)
          setNotice(null)
          const ok = await act(path, body)
          setBusy(false)
          if (!ok) setNotice(state.error ?? translate('loadFailed'))
          return ok
        }

        const submitDraft = async () => {
          const text = draft.trim()
          if (text === '') {
            setNotice(translate('emptyDraft'))
            return
          }
          if (await run('add', { text })) setDraft('')
        }

        const startEdit = (item) => {
          commitRef.current = false
          setEditingId(item.id)
          setEditDraft(item.text)
          setNotice(null)
        }

        const finishEdit = async (item) => {
          if (commitRef.current) return
          commitRef.current = true
          const text = editDraft.trim()
          setEditingId(null)
          if (text !== '' && text !== item.text) await run('update', { id: item.id, text })
        }

        const cancelEdit = () => {
          commitRef.current = true
          setEditingId(null)
        }

        const onPointerDown = (event) => {
          if (event.button !== 0) return
          event.preventDefault()
          dragRef.current = {
            pointerId: event.pointerId,
            startX: event.clientX,
            startY: event.clientY,
            left: position.left,
            top: position.top,
          }
          try {
            event.currentTarget.setPointerCapture?.(event.pointerId)
          } catch {
            /* capture is a nicety, not a requirement */
          }
        }

        const onPointerMove = (event) => {
          const drag = dragRef.current
          if (drag === null) return
          setPosition(
            clampPosition({
              left: drag.left + event.clientX - drag.startX,
              top: drag.top + event.clientY - drag.startY,
            }),
          )
        }

        const onPointerUp = (event) => {
          const drag = dragRef.current
          if (drag === null) return
          dragRef.current = null
          try {
            event.currentTarget.releasePointerCapture?.(event.pointerId)
          } catch {
            /* already released */
          }
          // A cancelled gesture keeps the last position instead of jumping to
          // coordinates the browser did not deliver.
          if (event.type === 'pointercancel') return
          const finished = clampPosition({
            left: drag.left + event.clientX - drag.startX,
            top: drag.top + event.clientY - drag.startY,
          })
          setPosition(finished)
          ui.position = finished
        }

        if (!view.open) return null

        const filters = [
          ['all', translate('all')],
          ['active', translate('active')],
          ['done', translate('done')],
        ]

        const progress = counts.total === 0 ? 0 : Math.round((counts.done / counts.total) * 100)

        const header = h(
          'div',
          {
            className: 'dsh-todo-float-header',
            onPointerDown,
            onPointerMove,
            onPointerUp,
            onPointerCancel: onPointerUp,
          },
          gripIcon(),
          h(
            'span',
            {
              style: {
                width: 26,
                height: 26,
                borderRadius: 6,
                border: '1px solid var(--dsw-alias-border-l1)',
                borderLeft: '2px solid var(--dsw-alias-brand-primary)',
                background: 'var(--dsw-alias-bg-layer-2)',
                color: 'var(--dsw-alias-brand-primary)',
                boxShadow: '0 0 16px -8px var(--dsw-alias-brand-primary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flex: '0 0 auto',
              },
            },
            h(TodoIcon, { size: 15 }),
          ),
          h(
            'div',
            { className: 'dsh-todo-float-title' },
            h(
              'span',
              {
                style: {
                  fontSize: 13.5,
                  fontWeight: 600,
                  lineHeight: 1.3,
                  letterSpacing: '-0.01em',
                  color: 'var(--dsw-alias-label-primary)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                },
              },
              translate('title'),
            ),
            h(
              'span',
              {
                style: {
                  ...subtle,
                  fontSize: 10,
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
                  fontVariantNumeric: 'tabular-nums',
                  letterSpacing: '0.02em',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                },
              },
              fill(translate('count'), counts),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-todo-close',
              onClick: () => ui.close(),
              onPointerDown: (event) => event.stopPropagation(),
              'aria-label': translate('close'),
              title: translate('close'),
              style: {
                width: 26,
                height: 26,
                padding: 0,
                border: 'none',
                borderRadius: 7,
                background: 'transparent',
                color: 'var(--dsw-alias-label-secondary)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
                flex: '0 0 auto',
              },
            },
            closeIcon(),
          ),
        )

        const progressBar = h(
          'div',
          { className: 'dsh-todo-progress', 'aria-hidden': true },
          h('div', {
            style: {
              width: `${progress}%`,
              boxShadow: progress > 0 ? '0 0 10px var(--dsw-alias-brand-primary)' : 'none',
            },
          }),
        )

        const addBar = h(
          'div',
          { style: { display: 'flex', gap: 7, flex: '0 0 auto' } },
          h('input', {
            className: 'dsh-todo-add',
            value: draft,
            onChange: (event) => {
              setDraft(event.target.value)
              if (notice !== null) setNotice(null)
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !event.nativeEvent?.isComposing) void submitDraft()
            },
            placeholder: translate('placeholder'),
            'aria-label': translate('placeholder'),
            autoFocus: true,
            style: {
              flex: '1 1 auto',
              minWidth: 0,
              height: 36,
              padding: '0 11px',
              borderRadius: 9,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-1)',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: 13,
              boxSizing: 'border-box',
            },
          }),
          h(
            'button',
            {
              type: 'button',
              className: 'dsh-todo-submit',
              onClick: () => void submitDraft(),
              disabled: busy || draft.trim() === '',
              style: {
                height: 36,
                padding: '0 14px',
                borderRadius: 9,
                border: '1px solid var(--dsw-alias-brand-primary)',
                background: 'var(--dsw-alias-brand-primary)',
                color: 'var(--dsw-alias-bg-base)',
                fontSize: 12.5,
                fontWeight: 600,
                letterSpacing: '0.03em',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                cursor: busy || draft.trim() === '' ? 'default' : 'pointer',
                opacity: busy || draft.trim() === '' ? 0.5 : 1,
                flex: '0 0 auto',
              },
            },
            h('span', { style: { fontSize: 15, lineHeight: 1, fontWeight: 500, opacity: 0.95 } }, '+'),
            translate('add'),
          ),
        )

        const filterBar = h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', flex: '0 0 auto' } },
          h(
            'div',
            {
              style: {
                display: 'flex',
                gap: 2,
                padding: 2,
                borderRadius: 7,
                background: 'var(--dsw-alias-bg-layer-2)',
                border: '1px solid var(--dsw-alias-border-l1)',
              },
            },
            filters.map(([key, label]) =>
              h(
                'button',
                {
                  key,
                  type: 'button',
                  'aria-pressed': filter === key,
                  onClick: () => setFilter(key),
                  style: {
                    height: 22,
                    padding: '0 8px',
                    borderRadius: 5,
                    border: '1px solid transparent',
                    background: filter === key ? 'var(--dsw-alias-bg-layer-1)' : 'transparent',
                    boxShadow: filter === key ? '0 1px 2px rgba(0, 0, 0, 0.10), 0 0 10px -4px var(--dsw-alias-brand-primary)' : 'none',
                    color: filter === key ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)',
                    fontSize: 11,
                    fontWeight: filter === key ? 600 : 400,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  },
                },
                label,
              ),
            ),
          ),
          h('span', { style: { flex: '1 1 auto' } }),
          counts.done > 0
            ? h(
                'button',
                {
                  type: 'button',
                  disabled: busy,
                  onClick: () => void run('clear-done'),
                  style: {
                    height: 24,
                    padding: '0 8px',
                    borderRadius: 6,
                    border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'transparent',
                    color: 'var(--dsw-alias-label-secondary)',
                    fontSize: 11,
                    cursor: busy ? 'default' : 'pointer',
                    whiteSpace: 'nowrap',
                  },
                },
                translate('clearDone'),
              )
            : null,
        )

        const banner = (() => {
          const message = notice ?? state.error ?? state.note
          if (message === null || message === undefined || message === '') return null
          const isError = notice !== null || state.error !== null
          return h(
            'div',
            {
              style: {
                padding: '7px 9px',
                borderRadius: 7,
                border: `1px solid ${isError ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-warn-primary)'}`,
                color: isError ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-warn-primary)',
                background: 'var(--dsw-alias-bg-layer-1)',
                fontSize: 11,
                lineHeight: 1.5,
              },
            },
            message,
          )
        })()

        const rows = items.map((item) => {
          const editing = editingId === item.id
          return h(
            'div',
            { key: item.id, className: 'dsh-todo-float-row' },
            h(
              'button',
              {
                type: 'button',
                className: item.done ? 'dsh-todo-check is-done' : 'dsh-todo-check',
                role: 'checkbox',
                'aria-checked': item.done,
                'aria-label': item.text,
                onClick: () => void run('toggle', { id: item.id }),
                style: {
                  width: 19,
                  height: 19,
                  marginTop: 1,
                  padding: 0,
                  borderRadius: 6,
                  border: `1.5px solid ${item.done ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'}`,
                  background: item.done ? 'var(--dsw-alias-brand-primary)' : 'transparent',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  flex: '0 0 auto',
                },
              },
              item.done ? checkMark() : null,
            ),
            editing
              ? h('input', {
                  className: 'dsh-todo-edit',
                  autoFocus: true,
                  value: editDraft,
                  onChange: (event) => setEditDraft(event.target.value),
                  onKeyDown: (event) => {
                    if (event.key === 'Enter' && !event.nativeEvent?.isComposing) {
                      event.preventDefault()
                      void finishEdit(item)
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      cancelEdit()
                    }
                  },
                  onBlur: () => void finishEdit(item),
                  'aria-label': translate('save'),
                  style: {
                    flex: '1 1 auto',
                    minWidth: 0,
                    height: 26,
                    padding: '0 8px',
                    borderRadius: 6,
                    border: '1px solid var(--dsw-alias-border-l1)',
                    background: 'var(--dsw-alias-bg-base)',
                    color: 'var(--dsw-alias-label-primary)',
                    fontSize: 13,
                    boxSizing: 'border-box',
                  },
                })
              : h(
                  'div',
                  { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 } },
                  h(
                    'span',
                    {
                      onDoubleClick: () => startEdit(item),
                      title: translate('editHint'),
                      style: {
                        fontSize: 13,
                        lineHeight: 1.5,
                        color: item.done ? 'var(--dsw-alias-label-secondary)' : 'var(--dsw-alias-label-primary)',
                        textDecoration: item.done ? 'line-through' : 'none',
                        wordBreak: 'break-word',
                        cursor: 'text',
                        userSelect: 'text',
                      },
                    },
                    item.text,
                  ),
                  item.done && Number.isFinite(item.doneAt)
                    ? h(
                        'span',
                        { style: { fontSize: 10.5, fontVariantNumeric: 'tabular-nums', color: 'var(--dsw-alias-label-secondary)' } },
                        fill(translate('completedAt'), { date: formatDate(item.doneAt) }),
                      )
                    : null,
                ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsh-todo-remove',
                title: translate('remove'),
                'aria-label': translate('remove'),
                onClick: () => void run('remove', { id: item.id }),
                style: {
                  width: 22,
                  height: 22,
                  padding: 0,
                  border: 'none',
                  borderRadius: 5,
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  flex: '0 0 auto',
                },
              },
              trashIcon(),
            ),
          )
        })

        const emptyKey = filter === 'done' ? 'emptyDone' : filter === 'active' ? 'emptyActive' : 'emptyAll'

        const emptyState = (text) =>
          h(
            'div',
            { className: 'dsh-todo-empty' },
            h('span', { className: 'dsh-todo-empty-badge' }, h(TodoIcon, { size: 18 })),
            h(
              'span',
              {
                style: {
                  fontSize: 11.5,
                  lineHeight: 1.6,
                  maxWidth: 230,
                  color: 'var(--dsw-alias-label-secondary)',
                },
              },
              text,
            ),
          )

        const listBody = !state.loaded
          ? h(
              'div',
              { className: 'dsh-todo-empty' },
              h('span', { style: { ...subtle, fontSize: 11.5 } }, state.error !== null ? translate('loadFailed') : translate('loading')),
            )
          : rows.length === 0
            ? emptyState(translate(emptyKey))
            : rows

        return h(
          'div',
          { className: 'dsh-todo-float', style: { left: position.left, top: position.top }, role: 'dialog', 'aria-label': translate('title') },
          h('style', null, CSS),
          header,
          progressBar,
          h('div', { className: 'dsh-todo-float-body' }, addBar, filterBar, banner, h('div', { className: 'dsh-todo-float-list' }, listBody)),
          h('div', { className: 'dsh-todo-footer' },
            h('span', { className: 'dsh-todo-footer-dot', 'aria-hidden': true }),
            h('span', { className: 'dsh-todo-footer-text', title: translate('hint') }, translate('hint')),
            h('kbd', { className: 'dsh-todo-kbd' }, shortcutLabel),
          ),
        )
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          if (typeof window === 'undefined') return () => {}
          const onKeyDown = (event) => {
            if (event.defaultPrevented || event.repeat) return
            if (!todoShortcut(event)) return
            event.preventDefault()
            ui.toggle()
          }
          window.addEventListener('keydown', onKeyDown)
          return () => window.removeEventListener('keydown', onKeyDown)
        }, 'todo-list: shortcut')
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'todo-list: dictionaries')
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
            { name: 'conversation.session.header.utilities', id: 'todo-list-toggle', order: 30, label: () => t('nav'), locale: NS },
            makeHeaderToggle(bind),
          ),
        )
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'todo-list-toggle', order: 20, label: () => t('nav'), locale: NS },
            makeFooterToggle(bind),
          ),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'todo-list-float', order: 40, label: () => t('nav'), locale: NS },
            makeFloatingPanel(bind),
          ),
        )
      },
    }
  },
})
