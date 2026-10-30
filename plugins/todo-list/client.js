/**
 * Client half of the todo-list bundle.
 *
 * Two seats, one data source (the Host's `/plugins/todo-list` routes):
 *   sidebar.panellist → the「待办」icon in the left rail
 *   main (key)        → the full-width panel it opens
 *
 * The Host pushes every mutation over SSE, so a task added by the agent shows
 * up in an open panel without a refresh. Pure-JS module: React comes from the
 * browser module table, styles use host theme tokens only.
 */
window.__ModuleLoader__.load({
  id: '@local/todo-list',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'todo-list'
    const API = '/plugins/todo-list'
    /** Panel id: `sidebar.panellist` dispatches the matching `main` key. */
    const PANEL_ID = 'todo-list'

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
      save: '保存',
      cancel: '取消',
      editHint: '双击编辑',
      emptyAll: '还没有待办。在上面输入一条开始。',
      emptyActive: '没有未完成的待办，今天很清爽。',
      emptyDone: '还没有完成的事项。',
      loading: '加载中…',
      loadFailed: '读不到待办数据，确认 Host 半已启用。',
      emptyDraft: '先写点什么再添加。',
      completedAt: '完成于 {date}',
      hint: '与 AI 共用同一份清单：在会话里说「把 X 加到待办」，或让它调用 todo 工具。数据存在本机。',
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
      save: 'Save',
      cancel: 'Cancel',
      editHint: 'Double-click to edit',
      emptyAll: 'No todos yet. Add one above to start.',
      emptyActive: 'Nothing open — enjoy the clean slate.',
      emptyDone: 'Nothing completed yet.',
      loading: 'Loading…',
      loadFailed: 'Could not read the todo data. Is the Host half enabled?',
      emptyDraft: 'Write something before adding it.',
      completedAt: 'Done {date}',
      hint: 'Shared with the agent: say "add X to my todos" in chat, or let it call the todo tool. Data stays on this machine.',
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

    // --- state -------------------------------------------------------------
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
    let pushUsers = 0
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
      if (pollTimer !== null || pushUsers <= 0) return
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
      if (pushSource !== null || pushUsers <= 0) return
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
      // EventSource retries on its own; a slow poll covers a stream that stays down.
      source.addEventListener('error', () => startPollFallback())
    }

    function closePush() {
      if (pushSource !== null) {
        const source = pushSource
        pushSource = null
        try {
          source.close()
        } catch {
          /* already closed */
        }
      }
      stopPollFallback()
    }

    function useTodos() {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const off = store.subscribe(() => bump((value) => value + 1))
        pushUsers += 1
        openPush()
        void refresh()
        return () => {
          off()
          pushUsers -= 1
          if (pushUsers <= 0) {
            pushUsers = 0
            closePush()
          }
        }
      }, [])
      return store
    }

    // --- styles ------------------------------------------------------------
    const subtle = { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }

    const CSS = `
.dsh-todo-page { height: 100%; min-height: 0; overflow: auto; background: var(--dsw-alias-bg-base); }
.dsh-todo-content { max-width: 760px; margin: 0 auto; padding: 28px 28px 56px; display: flex; flex-direction: column; gap: 18px; box-sizing: border-box; }
.dsh-todo-row { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border-radius: 8px; }
.dsh-todo-row .dsh-todo-remove { opacity: 0; transition: opacity 120ms ease; }
.dsh-todo-row:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-todo-row:hover .dsh-todo-remove, .dsh-todo-row:focus-within .dsh-todo-remove { opacity: 1; }
.dsh-todo-add:focus-visible, .dsh-todo-edit:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.dsh-todo-chip:hover { color: var(--dsw-alias-label-primary) !important; }
.dsh-todo-remove:hover { color: var(--dsw-alias-state-error-primary) !important; background: var(--dsw-alias-bg-layer-1) !important; }
.dsh-todo-add:hover:not(:disabled) { filter: brightness(1.06); }
.dsh-todo-panel-icon { color: inherit; }
@media (prefers-reduced-motion: reduce) { .dsh-todo-row .dsh-todo-remove { transition: none; } }
`

    // --- components --------------------------------------------------------
    function TodoIcon(props) {
      const size = Number.isFinite(props?.size) ? props.size : 20
      return h(
        'svg',
        {
          className: 'dsh-todo-panel-icon',
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block', pointerEvents: 'none' },
        },
        h('rect', {
          x: 3.5,
          y: 3.5,
          width: 17,
          height: 17,
          rx: 4.5,
          stroke: 'currentColor',
          strokeWidth: 1.6,
        }),
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

    function formatDate(timestamp) {
      try {
        return new Intl.DateTimeFormat(undefined, { month: 'numeric', day: 'numeric' }).format(new Date(timestamp))
      } catch {
        return ''
      }
    }

    function makePanel(bind) {
      const pick = makeTranslator(bind)

      return function TodoPanel(props) {
        const translate = pick(props)
        const state = useTodos()
        const [filter, setFilter] = React.useState('all')
        const [draft, setDraft] = React.useState('')
        const [editingId, setEditingId] = React.useState(null)
        const [editDraft, setEditDraft] = React.useState('')
        const [busy, setBusy] = React.useState(false)
        const [notice, setNotice] = React.useState(null)
        const commitRef = React.useRef(false)

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

        const filters = [
          ['all', translate('all')],
          ['active', translate('active')],
          ['done', translate('done')],
        ]

        const filterBar = h(
          'div',
          {
            style: {
              display: 'flex',
              gap: 2,
              padding: 2,
              borderRadius: 8,
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
                className: 'dsh-todo-chip',
                onClick: () => setFilter(key),
                style: {
                  height: 24,
                  padding: '0 10px',
                  borderRadius: 6,
                  border: '1px solid transparent',
                  background: filter === key ? 'var(--dsw-alias-bg-layer-1)' : 'transparent',
                  color: filter === key ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-secondary)',
                  fontSize: 12,
                  fontWeight: filter === key ? 600 : 400,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                },
              },
              label,
            ),
          ),
        )

        const header = h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' } },
          h(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
            h(
              'h1',
              { style: { margin: 0, fontSize: 20, lineHeight: 1.3, fontWeight: 600, letterSpacing: '-0.01em', color: 'var(--dsw-alias-label-primary)' } },
              translate('title'),
            ),
            h('div', { style: subtle }, fill(translate('count'), counts)),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
            filterBar,
            counts.done > 0
              ? h(
                  'button',
                  {
                    type: 'button',
                    disabled: busy,
                    onClick: () => void run('clear-done'),
                    style: {
                      height: 28,
                      padding: '0 10px',
                      borderRadius: 7,
                      border: '1px solid var(--dsw-alias-border-l1)',
                      background: 'transparent',
                      color: 'var(--dsw-alias-label-secondary)',
                      fontSize: 12,
                      cursor: busy ? 'default' : 'pointer',
                    },
                  },
                  translate('clearDone'),
                )
              : null,
          ),
        )

        const addBar = h(
          'div',
          { style: { display: 'flex', gap: 8 } },
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
            style: {
              flex: '1 1 auto',
              minWidth: 0,
              height: 38,
              padding: '0 12px',
              borderRadius: 9,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'var(--dsw-alias-bg-layer-1)',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: 13.5,
              boxSizing: 'border-box',
            },
          }),
          h(
            'button',
            {
              type: 'button',
              onClick: () => void submitDraft(),
              disabled: busy || draft.trim() === '',
              style: {
                height: 38,
                padding: '0 18px',
                borderRadius: 9,
                border: '1px solid var(--dsw-alias-brand-primary)',
                background: 'var(--dsw-alias-brand-primary)',
                color: 'var(--dsw-alias-bg-base)',
                fontSize: 13,
                fontWeight: 600,
                cursor: busy || draft.trim() === '' ? 'default' : 'pointer',
                opacity: busy || draft.trim() === '' ? 0.5 : 1,
                flex: '0 0 auto',
              },
            },
            translate('add'),
          ),
        )

        const banner = (() => {
          const message = notice ?? state.error ?? state.note
          if (message === null || message === undefined || message === '') return null
          const isError = notice !== null || state.error !== null
          return h(
            'div',
            {
              style: {
                padding: '9px 12px',
                borderRadius: 8,
                border: `1px solid ${isError ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-warn-primary)'}`,
                color: isError ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-state-warn-primary)',
                background: 'var(--dsw-alias-bg-layer-1)',
                fontSize: 12,
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
            { key: item.id, className: 'dsh-todo-row' },
            h(
              'button',
              {
                type: 'button',
                role: 'checkbox',
                'aria-checked': item.done,
                'aria-label': item.text,
                onClick: () => void run('toggle', { id: item.id }),
                style: {
                  width: 20,
                  height: 20,
                  marginTop: 1,
                  padding: 0,
                  borderRadius: '50%',
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
                    fontSize: 13.5,
                    boxSizing: 'border-box',
                  },
                })
              : h(
                  'div',
                  { style: { flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 } },
                  h(
                    'span',
                    {
                      onDoubleClick: () => startEdit(item),
                      title: translate('editHint'),
                      style: {
                        fontSize: 13.5,
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
                    ? h('span', { style: { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' } }, fill(translate('completedAt'), { date: formatDate(item.doneAt) }))
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
                  width: 24,
                  height: 24,
                  padding: 0,
                  border: 'none',
                  borderRadius: 6,
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-secondary)',
                  fontSize: 16,
                  lineHeight: 1,
                  cursor: 'pointer',
                  flex: '0 0 auto',
                },
              },
              '×',
            ),
          )
        })

        const emptyKey = filter === 'done' ? 'emptyDone' : filter === 'active' ? 'emptyActive' : 'emptyAll'

        const body = !state.loaded
          ? h('div', { style: { ...subtle, padding: '18px 12px' } }, state.error !== null ? translate('loadFailed') : translate('loading'))
          : rows.length === 0
            ? h('div', { style: { ...subtle, padding: '22px 12px', textAlign: 'center' } }, translate(emptyKey))
            : rows

        return h(
          'div',
          { className: 'dsh-todo-page' },
          h('style', null, CSS),
          h(
            'div',
            { className: 'dsh-todo-content' },
            header,
            addBar,
            banner,
            h(
              'div',
              {
                style: {
                  display: 'flex',
                  flexDirection: 'column',
                  borderRadius: 10,
                  border: '1px solid var(--dsw-alias-border-l1)',
                  background: 'var(--dsw-alias-bg-layer-1)',
                  padding: 4,
                  minHeight: 72,
                  boxSizing: 'border-box',
                },
              },
              body,
            ),
            h('div', { style: { ...subtle, lineHeight: 1.6 } }, translate('hint')),
          ),
        )
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
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

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 30, label: () => t('nav'), locale: NS },
            TodoIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, makePanel(bind)),
        )
      },
    }
  },
})
