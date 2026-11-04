/**
 * Client half of the dsh-team bundle.
 *
 * One data source (the Host's `/plugins/dsh-team` routes + SSE), three seats:
 *   conversation.session.header.utilities → 「工单」toggle in the session header
 *   sidebar.panellist                      → the rail icon, with a running badge
 *   shell.overlay                          → the ticket board itself
 *
 * The board is a right-side drawer: it slides over the app without taking the
 * conversation away, closes with × or Escape, and keeps streaming while it is
 * open. Pure-JS module: React comes from the browser module table, styles use
 * host theme tokens only.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-team',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-team'
    const API = '/plugins/dsh-team'

    const zh = {
      nav: '工单',
      title: '后台工单',
      subtitle: '每张工单 = 一个独立的 dsh headless worker',
      counts: '排队 {queued} · 运行 {running} · 完成 {done} · 失败 {failed}',
      queued: '排队',
      running: '运行中',
      done: '完成',
      failed: '失败',
      canceled: '已取消',
      filterAll: '全部',
      filterActive: '进行中',
      filterDone: '已完成',
      filterFailed: '失败',
      newTicket: '投一张工单',
      titlePlaceholder: '短标题，一行，便于看板识别',
      taskPlaceholder: '任务正文：worker 看不到本会话，写清项目路径、范围、验收标准',
      post: '投递',
      posting: '投递中…',
      cancel: '取消',
      retry: '重跑',
      close: '收起',
      empty: '还没有工单。上面投一张试试。',
      emptyFilter: '这个筛选下没有工单。',
      loading: '加载中…',
      loadFailed: '读不到工单数据，确认 Host 半已启用。',
      needTask: '任务正文不能为空。',
      report: '报告',
      error: '错误',
      output: '输出目录',
      copy: '复制路径',
      copied: '已复制',
      hint: 'worker 是独立进程，失败不拖累对话；「运行中」的工单不能取消。',
    }

    const en = {
      nav: 'Tickets',
      title: 'Background tickets',
      subtitle: 'One ticket = one dsh headless worker',
      counts: '{queued} queued · {running} running · {done} done · {failed} failed',
      queued: 'Queued',
      running: 'Running',
      done: 'Done',
      failed: 'Failed',
      canceled: 'Canceled',
      filterAll: 'All',
      filterActive: 'Active',
      filterDone: 'Done',
      filterFailed: 'Failed',
      newTicket: 'New ticket',
      titlePlaceholder: 'Short title, one line',
      taskPlaceholder: 'Task body: the worker cannot see this conversation, so spell out paths, scope and acceptance',
      post: 'Post',
      posting: 'Posting…',
      cancel: 'Cancel',
      retry: 'Retry',
      close: 'Close',
      empty: 'No tickets yet. Post one above.',
      emptyFilter: 'Nothing in this filter.',
      loading: 'Loading…',
      loadFailed: 'Cannot read tickets — is the Host half enabled?',
      needTask: 'The task body cannot be empty.',
      report: 'Report',
      error: 'Error',
      output: 'Output directory',
      copy: 'Copy path',
      copied: 'Copied',
      hint: 'A worker is its own process: a failure never breaks the conversation. Running tickets cannot be canceled.',
    }

    const STATE_LABEL = { queued: 'queued', running: 'running', done: 'done', failed: 'failed', canceled: 'canceled' }
    const STATE_COLOR = {
      queued: 'var(--dsw-alias-label-secondary)',
      running: 'var(--dsw-alias-brand-primary)',
      done: 'var(--dsw-alias-state-success-primary)',
      failed: 'var(--dsw-alias-state-error-primary)',
      canceled: 'var(--dsw-alias-label-secondary)',
    }

    const describe = (error) => (error instanceof Error ? error.message : String(error))

    // --- data store ---------------------------------------------------------
    // One snapshot for every seat: the rail badge and the drawer always agree.
    const store = {
      loaded: false,
      error: null,
      note: null,
      counts: { queued: 0, running: 0, done: 0, failed: 0, canceled: 0 },
      tickets: [],
      version: 0,
      listeners: new Set(),
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      emit() {
        for (const listener of [...this.listeners]) listener()
      },
      apply(payload) {
        if (typeof payload !== 'object' || payload === null || !Array.isArray(payload.tickets)) return
        this.tickets = payload.tickets
        this.counts = payload.counts ?? this.counts
        this.note = typeof payload.note === 'string' ? payload.note : null
        this.version = Number.isFinite(payload.version) ? payload.version : this.version
        this.loaded = true
        this.error = null
        this.emit()
      },
      fail(error) {
        this.error = describe(error)
        this.emit()
      },
    }

    // --- open / close state -------------------------------------------------
    const ui = {
      open: false,
      listeners: new Set(),
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      set(open) {
        if (this.open === open) return
        this.open = open
        for (const listener of [...this.listeners]) listener()
      },
      toggle() {
        this.set(!this.open)
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
        store.apply(await requestJson(`${API}/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body ?? {}),
        }))
        return true
      } catch (error) {
        store.fail(error)
        return false
      }
    }

    // --- push transport -----------------------------------------------------
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
      for (const name of ['snapshot', 'state']) {
        source.addEventListener(name, (event) => {
          const payload = parseEvent(event)
          if (payload !== null) store.apply(payload)
        })
      }
      source.addEventListener('error', () => startPollFallback())
    }

    function startData() {
      if (started) return
      started = true
      openPush()
      void refresh()
    }

    function useTickets() {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const off = store.subscribe(() => bump((value) => value + 1))
        startData()
        return off
      }, [])
      return store
    }

    function useOpen() {
      const [, bump] = React.useState(0)
      React.useEffect(() => ui.subscribe(() => bump((value) => value + 1)), [])
      return ui.open
    }

    // --- helpers ------------------------------------------------------------
    function duration(ticket) {
      const start = Number.isFinite(ticket.startedAt) ? ticket.startedAt : ticket.createdAt
      const end = Number.isFinite(ticket.finishedAt) ? ticket.finishedAt : Date.now()
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return '-'
      const seconds = Math.round((end - start) / 1000)
      if (seconds < 60) return `${seconds}s`
      const minutes = Math.floor(seconds / 60)
      if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`
      return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`
    }

    const isTerminal = (ticket) => ticket.state === 'done' || ticket.state === 'failed' || ticket.state === 'canceled'

    // --- pieces -------------------------------------------------------------
    function StateDot({ state }) {
      return h('span', {
        className: 'dsh-team-dot',
        style: { background: STATE_COLOR[state] ?? 'var(--dsw-alias-label-secondary)' },
        'aria-hidden': true,
      })
    }

    function CountChips({ counts, t }) {
      const order = ['queued', 'running', 'done', 'failed']
      return h(
        'div',
        { className: 'dsh-team-chips' },
        ...order.map((key) =>
          h(
            'span',
            { key, className: 'dsh-team-chip', title: t(STATE_LABEL[key]) },
            h('span', { className: 'dsh-team-chip-dot', style: { background: STATE_COLOR[key] } }),
            h('span', null, t(STATE_LABEL[key])),
            h('b', null, String(counts[key] ?? 0)),
          ),
        ),
      )
    }

    function ReportBlock({ ticket, t }) {
      const [copied, setCopied] = React.useState(false)
      const body = ticket.state === 'failed' ? ticket.error || ticket.report : ticket.report
      const label = ticket.state === 'failed' ? t('error') : t('report')
      const copy = () => {
        const path = ticket.outDir
        if (typeof navigator !== 'undefined' && navigator.clipboard && path) {
          navigator.clipboard.writeText(path).then(
            () => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1_500)
            },
            () => {},
          )
        }
      }
      return h(
        'div',
        { className: 'dsh-team-report' },
        h(
          'div',
          { className: 'dsh-team-report-bar' },
          h('span', { className: 'dsh-team-report-label' }, label),
          ticket.outDir
            ? h(
                'button',
                { type: 'button', className: 'dsh-team-link', onClick: copy, title: ticket.outDir },
                copied ? t('copied') : t('copy'),
              )
            : null,
        ),
        h('pre', { className: 'dsh-team-report-body' }, body === '' || body === undefined ? '—' : body),
        ticket.outDir ? h('div', { className: 'dsh-team-path' }, `${t('output')}: ${ticket.outDir}`) : null,
      )
    }

    function TicketRow({ ticket, expanded, t, onToggle, onCancel, onRetry, busy }) {
      const canCancel = ticket.state === 'queued'
      const canRetry = isTerminal(ticket)
      return h(
        'div',
        { className: `dsh-team-row${expanded ? ' is-open' : ''}` },
        h(
          'button',
          { type: 'button', className: 'dsh-team-row-main', onClick: onToggle, 'aria-expanded': expanded },
          h(StateDot, { state: ticket.state }),
          h(
            'span',
            { className: 'dsh-team-row-text' },
            h('span', { className: 'dsh-team-row-title' }, ticket.title || ticket.id),
            h(
              'span',
              { className: 'dsh-team-row-meta' },
              h('span', { className: 'dsh-team-badge', style: { color: STATE_COLOR[ticket.state] } }, t(STATE_LABEL[ticket.state] ?? 'queued')),
              h('span', { className: 'dsh-team-sep' }, '·'),
              h('span', null, duration(ticket)),
              h('span', { className: 'dsh-team-sep' }, '·'),
              h('code', { className: 'dsh-team-id' }, ticket.id),
            ),
          ),
        ),
        expanded
          ? h(
              'div',
              { className: 'dsh-team-row-detail' },
              h(ReportBlock, { ticket, t }),
              h(
                'div',
                { className: 'dsh-team-actions' },
                canCancel
                  ? h(
                      'button',
                      { type: 'button', className: 'dsh-team-btn', disabled: busy, onClick: onCancel },
                      t('cancel'),
                    )
                  : null,
                canRetry
                  ? h(
                      'button',
                      { type: 'button', className: 'dsh-team-btn', disabled: busy, onClick: onRetry },
                      t('retry'),
                    )
                  : null,
              ),
            )
          : null,
      )
    }

    function PostForm({ t, onPosted }) {
      const [title, setTitle] = React.useState('')
      const [task, setTask] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [problem, setProblem] = React.useState(null)

      const submit = async () => {
        if (busy) return
        if (task.trim() === '') {
          setProblem(t('needTask'))
          return
        }
        setBusy(true)
        setProblem(null)
        const ok = await act('post', { title: title.trim(), task, source: 'panel' })
        setBusy(false)
        if (ok) {
          setTitle('')
          setTask('')
          if (typeof onPosted === 'function') onPosted()
        } else {
          setProblem(store.error ?? 'post failed')
        }
      }

      return h(
        'div',
        { className: 'dsh-team-form' },
        h('input', {
          className: 'dsh-team-input',
          value: title,
          placeholder: t('titlePlaceholder'),
          onChange: (event) => setTitle(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault()
              void submit()
            }
          },
        }),
        h('textarea', {
          className: 'dsh-team-textarea',
          value: task,
          rows: 4,
          placeholder: t('taskPlaceholder'),
          onChange: (event) => setTask(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void submit()
            }
          },
        }),
        problem !== null ? h('div', { className: 'dsh-team-problem' }, problem) : null,
        h(
          'div',
          { className: 'dsh-team-form-foot' },
          h('span', { className: 'dsh-team-form-hint' }, '⌘/Ctrl + Enter'),
          h(
            'button',
            { type: 'button', className: 'dsh-team-submit', disabled: busy, onClick: () => void submit() },
            busy ? t('posting') : t('post'),
          ),
        ),
      )
    }

    // --- board --------------------------------------------------------------
    function makeBoard(bind) {
      const t = (key) => {
        try {
          const text = bind(key)
          return typeof text === 'string' && text !== '' ? text : (zh[key] ?? key)
        } catch {
          return zh[key] ?? key
        }
      }

      return function Board() {
        const data = useTickets()
        const [filter, setFilter] = React.useState('all')
        const [expanded, setExpanded] = React.useState(null)
        const [busy, setBusy] = React.useState(false)

        const filters = [
          ['all', 'filterAll'],
          ['active', 'filterActive'],
          ['done', 'filterDone'],
          ['failed', 'filterFailed'],
        ]

        const tickets = data.tickets.filter((ticket) => {
          if (filter === 'active') return ticket.state === 'queued' || ticket.state === 'running'
          if (filter === 'done') return ticket.state === 'done'
          if (filter === 'failed') return ticket.state === 'failed' || ticket.state === 'canceled'
          return true
        })

        const rows = tickets.map((ticket) =>
          h(TicketRow, {
            key: ticket.id,
            ticket,
            t,
            busy,
            expanded: expanded === ticket.id,
            onToggle: () => setExpanded(expanded === ticket.id ? null : ticket.id),
            onCancel: async () => {
              setBusy(true)
              await act('cancel', { id: ticket.id })
              setBusy(false)
            },
            onRetry: async () => {
              setBusy(true)
              await act('retry', { id: ticket.id })
              setBusy(false)
            },
          }),
        )

        const body = !data.loaded
          ? h('div', { className: 'dsh-team-empty' }, h('span', null, data.error !== null ? t('loadFailed') : t('loading')))
          : rows.length === 0
            ? h('div', { className: 'dsh-team-empty' }, h('span', null, filter === 'all' ? t('empty') : t('emptyFilter')))
            : rows

        return h(
          'div',
          { className: 'dsh-team-board' },
          h('style', null, CSS),
          h(
            'div',
            { className: 'dsh-team-head' },
            h(
              'div',
              { className: 'dsh-team-head-left' },
              h('span', { className: 'dsh-team-title' }, t('title')),
              h('span', { className: 'dsh-team-subtitle' }, t('subtitle')),
            ),
            h(
              'button',
              { type: 'button', className: 'dsh-team-close', onClick: () => ui.set(false), title: t('close'), 'aria-label': t('close') },
              '×',
            ),
          ),
          h(CountChips, { counts: data.counts, t }),
          data.note !== null ? h('div', { className: 'dsh-team-problem' }, data.note) : null,
          h('div', { className: 'dsh-team-body' },
            h(PostForm, { t, onPosted: () => setFilter('all') }),
            h(
              'div',
              { className: 'dsh-team-tabs' },
              ...filters.map(([key, label]) =>
                h(
                  'button',
                  {
                    key,
                    type: 'button',
                    className: `dsh-team-tab${filter === key ? ' is-on' : ''}`,
                    onClick: () => setFilter(key),
                  },
                  t(label),
                ),
              ),
            ),
            h('div', { className: 'dsh-team-list' }, body),
          ),
          h('div', { className: 'dsh-team-footer' }, h('span', null, t('hint'))),
        )
      }
    }

    function makeHeaderToggle(bind) {
      return function HeaderToggle() {
        const open = useOpen()
        useTickets()
        return h(
          'button',
          {
            type: 'button',
            className: `dsh-team-toggle${open ? ' is-on' : ''}`,
            onClick: () => ui.toggle(),
            title: zh.nav,
          },
          h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true }, h('path', {
            d: 'M2 4h12M2 8h12M2 12h7',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            fill: 'none',
          })),
          h('span', { className: 'dsh-team-toggle-label' }, bind('nav') ?? zh.nav),
        )
      }
    }

    function makePanelIcon(bind) {
      return function PanelIcon() {
        const data = useTickets()
        const open = useOpen()
        const badge = (data.counts.queued ?? 0) + (data.counts.running ?? 0)
        return h(
          'button',
          {
            type: 'button',
            className: `dsh-team-rail${open ? ' is-on' : ''}`,
            onClick: () => ui.toggle(),
            title: bind('nav') ?? zh.nav,
            'aria-label': bind('nav') ?? zh.nav,
          },
          h('svg', { width: 18, height: 18, viewBox: '0 0 16 16', 'aria-hidden': true },
            h('rect', { x: 2.2, y: 2.2, width: 11.6, height: 11.6, rx: 2.4, stroke: 'currentColor', strokeWidth: 1.4, fill: 'none' }),
            h('path', { d: 'M5 6h6M5 9.2h4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', fill: 'none' }),
          ),
          badge > 0 ? h('span', { className: 'dsh-team-badge-count' }, String(badge)) : null,
        )
      }
    }

    function makeDrawer(bind) {
      const Board = makeBoard(bind)
      return function Drawer() {
        const open = useOpen()
        React.useEffect(() => {
          if (!open) return () => {}
          const onKeyDown = (event) => {
            if (event.defaultPrevented) return
            if (event.key === 'Escape') ui.set(false)
          }
          window.addEventListener('keydown', onKeyDown)
          return () => window.removeEventListener('keydown', onKeyDown)
        }, [open])
        if (!open) return null
        return h(
          'div',
          { className: 'dsh-team-drawer-shell' },
          h('div', { className: 'dsh-team-drawer-backdrop', onClick: () => ui.set(false), 'aria-hidden': true }),
          h('div', { className: 'dsh-team-drawer', role: 'dialog', 'aria-label': zh.title }, h(Board, null)),
        )
      }
    }

    // --- styles -------------------------------------------------------------
    const CSS = `
@keyframes dsh-team-slide { from { transform: translateX(18px); opacity: 0; } to { transform: none; opacity: 1; } }
@keyframes dsh-team-pulse { from { opacity: 0.35; } to { opacity: 1; } }
.dsh-team-drawer-shell { position: fixed; inset: 0; z-index: 45; pointer-events: none; }
.dsh-team-drawer-backdrop { position: absolute; inset: 0; background: rgba(0, 0, 0, 0.18); pointer-events: auto; animation: dsh-team-slide 140ms ease; }
.dsh-team-drawer { position: absolute; top: 0; right: 0; bottom: 0; width: min(452px, 100vw); display: flex; flex-direction: column; pointer-events: auto; border-left: 1px solid var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-overlay); box-shadow: -18px 0 48px -24px rgba(0, 0, 0, 0.45); animation: dsh-team-slide 160ms cubic-bezier(0.2, 0.8, 0.2, 1); }
.dsh-team-board { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.dsh-team-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; padding: 14px 14px 8px; }
.dsh-team-head-left { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.dsh-team-title { font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.dsh-team-subtitle { font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.dsh-team-close { flex: 0 0 auto; width: 24px; height: 24px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 16px; line-height: 1; cursor: pointer; }
.dsh-team-close:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dsh-team-chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 0 14px 10px; }
.dsh-team-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; background: var(--dsw-alias-bg-layer-1); font-size: 10.5px; color: var(--dsw-alias-label-secondary); }
.dsh-team-chip b { color: var(--dsw-alias-label-primary); font-weight: 600; }
.dsh-team-chip-dot { width: 5px; height: 5px; border-radius: 50%; }
.dsh-team-body { display: flex; flex-direction: column; gap: 10px; padding: 0 14px 12px; flex: 1 1 auto; min-height: 0; }
.dsh-team-form { display: flex; flex-direction: column; gap: 6px; padding: 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }
.dsh-team-input, .dsh-team-textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-overlay); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 12px; padding: 6px 8px; resize: vertical; }
.dsh-team-textarea { min-height: 68px; line-height: 1.5; }
.dsh-team-input:focus, .dsh-team-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary); }
.dsh-team-form-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsh-team-form-hint { font-size: 9.5px; color: var(--dsw-alias-label-secondary); }
.dsh-team-submit { padding: 5px 12px; border: 0; border-radius: 7px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-size: 11.5px; font-weight: 600; cursor: pointer; }
.dsh-team-submit:hover:not(:disabled) { filter: brightness(1.08); }
.dsh-team-submit:disabled { opacity: 0.6; cursor: default; }
.dsh-team-problem { font-size: 11px; color: var(--dsw-alias-state-error-primary); padding: 0 2px; }
.dsh-team-tabs { display: flex; gap: 4px; }
.dsh-team-tab { padding: 3px 9px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; }
.dsh-team-tab:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-team-tab.is-on { border-color: var(--dsw-alias-border-l2); background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-team-list { display: flex; flex-direction: column; gap: 6px; overflow: auto; flex: 1 1 auto; min-height: 80px; padding-right: 2px; }
.dsh-team-row { border: 1px solid var(--dsw-alias-border-l1); border-radius: 9px; background: var(--dsw-alias-bg-layer-1); overflow: hidden; }
.dsh-team-row.is-open { border-color: var(--dsw-alias-border-l2); }
.dsh-team-row-main { display: flex; align-items: flex-start; gap: 8px; width: 100%; padding: 8px 10px; border: 0; background: transparent; text-align: left; cursor: pointer; }
.dsh-team-row-main:hover { background: var(--dsw-alias-bg-layer-2); }
.dsh-team-dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; margin-top: 5px; }
.dsh-team-row-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.dsh-team-row-title { font-size: 12px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-team-row-meta { display: flex; align-items: center; gap: 5px; font-size: 10px; color: var(--dsw-alias-label-secondary); }
.dsh-team-badge { font-weight: 600; }
.dsh-team-sep { opacity: 0.5; }
.dsh-team-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 9.5px; opacity: 0.8; }
.dsh-team-row-detail { display: flex; flex-direction: column; gap: 7px; padding: 0 10px 9px 24px; }
.dsh-team-report { border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-overlay); overflow: hidden; }
.dsh-team-report-bar { display: flex; align-items: center; justify-content: space-between; padding: 3px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); }
.dsh-team-report-label { font-size: 9.5px; letter-spacing: 0.04em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
.dsh-team-link { border: 0; background: transparent; color: var(--dsw-alias-brand-primary); font-size: 10px; cursor: pointer; padding: 0; }
.dsh-team-report-body { margin: 0; padding: 7px 8px; max-height: 220px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px; line-height: 1.5; color: var(--dsw-alias-label-primary); white-space: pre-wrap; word-break: break-word; }
.dsh-team-path { padding: 0 8px 6px; font-size: 9.5px; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; }
.dsh-team-actions { display: flex; gap: 6px; }
.dsh-team-btn { padding: 3px 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 10.5px; cursor: pointer; }
.dsh-team-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); }
.dsh-team-empty { display: flex; align-items: center; justify-content: center; padding: 22px 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); text-align: center; }
.dsh-team-footer { padding: 8px 14px 10px; border-top: 1px solid var(--dsw-alias-border-l1); font-size: 10px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }
.dsh-team-toggle { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; }
.dsh-team-toggle:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dsh-team-toggle.is-on { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 12px -5px var(--dsw-alias-brand-primary); }
.dsh-team-toggle-label { white-space: nowrap; }
.dsh-team-rail { position: relative; display: flex; align-items: center; justify-content: center; width: 30px; height: 30px; border: 1px solid transparent; border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.dsh-team-rail:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dsh-team-rail.is-on { color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-layer-2); }
.dsh-team-badge-count { position: absolute; top: 1px; right: 1px; min-width: 13px; height: 13px; padding: 0 3px; border-radius: 999px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-size: 8.5px; font-weight: 700; line-height: 13px; text-align: center; animation: dsh-team-pulse 2.4s ease-in-out infinite alternate; }
`

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-team: dictionaries')
        const bind = ctx.locale.bind(NS)

        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'dsh-team-toggle', order: 32, label: () => bind('nav'), locale: NS },
            makeHeaderToggle(bind),
          ),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'dsh-team', order: 22, label: () => bind('nav'), locale: NS },
            makePanelIcon(bind),
          ),
        )
        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register(
            { name: 'shell.overlay', id: 'dsh-team-drawer', order: 45, label: () => bind('nav'), locale: NS },
            makeDrawer(bind),
          ),
        )
      },
    }
  },
})
