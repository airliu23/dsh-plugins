/**
 * Client half of the dsh-team bundle.
 *
 * One data source (the Host's `/plugins/dsh-team` routes + SSE), three seats:
 *   conversation.session.header.utilities → 「工单」toggle in the session header
 *   sidebar.panellist                      → the rail icon, with a running badge
 *   sidebar.right.pane.tab (+ .title)      → the board, as a right pane
 *
 * The board lives in the **right sidebar**, so it sits *beside* the
 * conversation instead of covering it: you keep reading the chat while a ticket
 * runs, and a ticket's report opens in that same pane (list ⇄ detail, back
 * arrow to return) rather than in a modal.
 *
 * Pure-JS module: React comes from the browser module table, styles use host
 * theme tokens only.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-team',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-team'
    const API = '/plugins/dsh-team'
    const TAB_ID = '@local/dsh-team'
    const TAB_KIND = 'dsh-team'

    const zh = {
      nav: '工单',
      subtitle: '每张工单 = 一个独立的 dsh headless worker',
      queued: '排队',
      running: '运行中',
      done: '完成',
      failed: '失败',
      canceled: '已取消',
      filterAll: '全部',
      filterActive: '进行中',
      filterDone: '已完成',
      filterFailed: '失败',
      titlePlaceholder: '短标题，一行，便于看板识别',
      taskPlaceholder: '任务正文：worker 看不到本会话，写清项目路径、范围、验收标准',
      post: '投递',
      posting: '投递中…',
      cancel: '取消',
      retry: '重跑',
      back: '列表',
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
      hint: 'worker 是独立进程，失败不拖累对话；运行中不能取消。',
      summaryChip: '汇总',
      waitingChip: '等上游',
      upstreamsTitle: '上游',
      feedsTitle: '被汇总',
    }

    const en = {
      nav: 'Tickets',
      subtitle: 'One ticket = one dsh headless worker',
      queued: 'Queued',
      running: 'Running',
      done: 'Done',
      failed: 'Failed',
      canceled: 'Canceled',
      filterAll: 'All',
      filterActive: 'Active',
      filterDone: 'Done',
      filterFailed: 'Failed',
      titlePlaceholder: 'Short title, one line',
      taskPlaceholder: 'Task body: the worker cannot see this conversation, so spell out paths, scope and acceptance',
      post: 'Post',
      posting: 'Posting…',
      cancel: 'Cancel',
      retry: 'Retry',
      back: 'List',
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
      summaryChip: 'Summary',
      waitingChip: 'waits',
      upstreamsTitle: 'Upstream',
      feedsTitle: 'Summarised by',
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
    // One snapshot for every seat: the rail badge and the pane always agree.
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
      // A running ticket's elapsed time changes with the clock, not with the
      // data: without this tick the board reads "0s" until you click something.
      const live = store.tickets.some((ticket) => !isTerminal(ticket))
      React.useEffect(() => {
        if (!live) return undefined
        const timer = setInterval(() => bump((value) => value + 1), 1_000)
        return () => clearInterval(timer)
      }, [live])
      return store
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
      const color = STATE_COLOR[state] ?? 'var(--dsw-alias-label-secondary)'
      return h('span', { className: 'dsh-team-dot', style: { background: color, color }, 'aria-hidden': true })
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
            h('span', { className: 'dsh-team-chip-dot', style: { background: STATE_COLOR[key], color: STATE_COLOR[key] } }),
            h('span', null, t(STATE_LABEL[key])),
            h('b', null, String(counts[key] ?? 0)),
          ),
        ),
      )
    }

    function ReportBlock({ ticket, t, tall }) {
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
        { className: `dsh-team-report${tall ? ' is-tall' : ''}` },
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

    function TicketRow({ ticket, t, onOpen, depth = 0, waiting = 0 }) {
      const color = STATE_COLOR[ticket.state] ?? 'var(--dsw-alias-label-secondary)'
      const deps = Array.isArray(ticket.waitsFor) ? ticket.waitsFor : []
      const chips = []
      if (deps.length > 0) {
        chips.push(
          h(
            'span',
            { key: 'sum', className: 'dsh-team-chip', title: `${t('upstreamsTitle')}:\n${deps.join('\n')}` },
            `${t('summaryChip')} ${deps.length}`,
          ),
        )
      }
      if (waiting > 0) {
        chips.push(h('span', { key: 'wait', className: 'dsh-team-chip is-wait' }, `${t('waitingChip')} ${waiting}`))
      }
      return h(
        'button',
        {
          type: 'button',
          className: `dsh-team-row${ticket.state === 'running' ? ' is-running' : ''}${depth > 0 ? ' is-child' : ''}`,
          onClick: () => onOpen(ticket.id),
          title: ticket.title || ticket.id,
        },
        h('span', { className: 'dsh-team-row-accent', style: { background: color, color }, 'aria-hidden': true }),
        depth > 0 ? h('span', { className: 'dsh-team-tree', 'aria-hidden': true }, '└') : null,
        h(StateDot, { state: ticket.state }),
        h(
          'span',
          { className: 'dsh-team-row-text' },
          h('span', { className: 'dsh-team-row-title' }, ticket.title || ticket.id),
          h(
            'span',
            { className: 'dsh-team-row-meta' },
            h('span', { className: 'dsh-team-badge', style: { color } }, t(STATE_LABEL[ticket.state] ?? 'queued')),
            h('span', { className: 'dsh-team-sep' }, '·'),
            h('span', null, duration(ticket)),
            h('span', { className: 'dsh-team-sep' }, '·'),
            h('code', { className: 'dsh-team-id' }, ticket.id),
            ...chips,
          ),
        ),
        h('span', { className: 'dsh-team-chevron', 'aria-hidden': true }, '›'),
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
          rows: 3,
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

    /** One labelled row of related tickets; each chip opens that ticket. */
    function RelationRow({ label, items, t, onOpen }) {
      if (items.length === 0) return null
      return h(
        'div',
        { className: 'dsh-team-rel' },
        h('span', { className: 'dsh-team-rel-label' }, label),
        ...items.map((item) =>
          h(
            'button',
            { key: item.id, type: 'button', className: 'dsh-team-rel-link', title: `${item.id}\n${item.title}`, onClick: () => onOpen(item.id) },
            `${t(STATE_LABEL[item.state] ?? 'queued')} · ${item.title || item.id}`,
          ),
        ),
      )
    }

    /** Detail view: same pane, one ticket, back arrow to the list. */
    function DetailView({ ticket, t, onBack, busy, onCancel, onRetry, tickets, onOpen }) {
      const color = STATE_COLOR[ticket.state] ?? 'var(--dsw-alias-label-secondary)'
      const all = Array.isArray(tickets) ? tickets : []
      const byId = new Map(all.map((item) => [item.id, item]))
      const upstreams = (ticket.waitsFor ?? []).map((id) => byId.get(id)).filter((item) => item !== undefined)
      const parents = all.filter((item) => (item.waitsFor ?? []).includes(ticket.id))
      const hasRelation = upstreams.length > 0 || parents.length > 0
      return h(
        'div',
        { className: 'dsh-team-detail' },
        h(
          'div',
          { className: 'dsh-team-detail-head' },
          h(
            'button',
            { type: 'button', className: 'dsh-team-back', onClick: onBack, title: t('back') },
            '←',
            h('span', null, t('back')),
          ),
          h(StateDot, { state: ticket.state }),
          h('span', { className: 'dsh-team-badge', style: { color } }, t(STATE_LABEL[ticket.state] ?? 'queued')),
          h('span', { className: 'dsh-team-sep' }, '·'),
          h('span', { className: 'dsh-team-detail-elapsed' }, duration(ticket)),
        ),
        h('div', { className: 'dsh-team-detail-title' }, ticket.title || ticket.id),
        h('div', { className: 'dsh-team-detail-meta' },
          `${ticket.id}${Number.isInteger(ticket.exitCode) ? `  ·  exit ${ticket.exitCode}` : ''}`),
        hasRelation
          ? h(
              'div',
              { className: 'dsh-team-rel-block' },
              h(RelationRow, { label: t('upstreamsTitle'), items: upstreams, t, onOpen }),
              h(RelationRow, { label: t('feedsTitle'), items: parents, t, onOpen }),
            )
          : null,
        h('div', { className: 'dsh-team-detail-body' }, h(ReportBlock, { ticket, t, tall: true })),
        h(
          'div',
          { className: 'dsh-team-detail-foot' },
          ticket.state === 'queued'
            ? h('button', { type: 'button', className: 'dsh-team-btn', disabled: busy, onClick: onCancel }, t('cancel'))
            : null,
          isTerminal(ticket)
            ? h('button', { type: 'button', className: 'dsh-team-btn', disabled: busy, onClick: onRetry }, t('retry'))
            : null,
          h('span', { className: 'dsh-team-foot-dot', 'aria-hidden': true }),
          h('span', { className: 'dsh-team-detail-hint' }, t('hint')),
        ),
      )
    }

    // --- pane: list ⇄ detail -------------------------------------------------
    function makePane(bind) {
      const t = (key) => {
        try {
          const text = bind(key)
          return typeof text === 'string' && text !== '' ? text : (zh[key] ?? key)
        } catch {
          return zh[key] ?? key
        }
      }

      return function TeamPane() {
        const data = useTickets()
        const [filter, setFilter] = React.useState('all')
        const [selected, setSelected] = React.useState(null)
        const [busy, setBusy] = React.useState(false)

        const ticket = selected === null ? null : data.tickets.find((item) => item.id === selected) ?? null

        if (ticket !== null) {
          return h(
            'div',
            { className: 'dsh-team-pane' },
            h('style', null, CSS),
            h(DetailView, {
              ticket,
              t,
              busy,
              tickets: data.tickets,
              onOpen: setSelected,
              onBack: () => setSelected(null),
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
        }

        const filters = [
          ['all', 'filterAll'],
          ['active', 'filterActive'],
          ['done', 'filterDone'],
          ['failed', 'filterFailed'],
        ]

        const tickets = data.tickets.filter((item) => {
          if (filter === 'active') return item.state === 'queued' || item.state === 'running'
          if (filter === 'done') return item.state === 'done'
          if (filter === 'failed') return item.state === 'failed' || item.state === 'canceled'
          return true
        })

        // A summary ticket owns its upstreams: nest them instead of listing
        // both, so the board reads as layers rather than a flat log.
        const byId = new Map(data.tickets.map((item) => [item.id, item]))
        const visible = new Set(tickets.map((item) => item.id))
        const childOf = new Map()
        for (const item of data.tickets) {
          for (const id of item.waitsFor ?? []) {
            if (id !== item.id && byId.has(id) && !childOf.has(id)) childOf.set(id, item.id)
          }
        }
        const childrenOf = new Map()
        for (const [child, parent] of childOf) {
          if (!visible.has(child) || !visible.has(parent)) continue
          const list = childrenOf.get(parent) ?? []
          list.push(child)
          childrenOf.set(parent, list)
        }
        const roots = tickets.filter((item) => {
          const parent = childOf.get(item.id)
          return parent === undefined || parent === item.id || !visible.has(parent)
        })

        const rows = []
        const walk = (item, depth, trail) => {
          if (trail.has(item.id)) return
          const seen = new Set(trail).add(item.id)
          const kids = (childrenOf.get(item.id) ?? []).map((id) => byId.get(id)).filter((child) => child !== undefined)
          const waiting = (item.waitsFor ?? []).filter((id) => {
            const dep = byId.get(id)
            return dep !== undefined && !isTerminal(dep)
          }).length
          rows.push(
            h(TicketRow, { key: item.id, ticket: item, t, onOpen: setSelected, depth, waiting }),
          )
          for (const kid of kids) walk(kid, depth + 1, seen)
        }
        for (const item of roots) walk(item, 0, new Set())

        const body = !data.loaded
          ? h('div', { className: 'dsh-team-empty' }, h('span', null, data.error !== null ? t('loadFailed') : t('loading')))
          : rows.length === 0
            ? h('div', { className: 'dsh-team-empty' }, h('span', null, filter === 'all' ? t('empty') : t('emptyFilter')))
            : rows

        return h(
          'div',
          { className: 'dsh-team-pane' },
          h('style', null, CSS),
          h(
            'div',
            { className: 'dsh-team-head' },
            h(
              'div',
              { className: 'dsh-team-brandtile', 'aria-hidden': true },
              h('svg', { width: 16, height: 16, viewBox: '0 0 16 16' },
                h('rect', { x: 2.2, y: 2.2, width: 11.6, height: 11.6, rx: 2.6, stroke: 'currentColor', strokeWidth: 1.4, fill: 'none' }),
                h('path', { d: 'M5 6.2h6M5 9.4h4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', fill: 'none' }),
              ),
            ),
            h(
              'div',
              { className: 'dsh-team-head-left' },
              h('span', { className: 'dsh-team-eyebrow' }, 'tickets'),
              h('span', { className: 'dsh-team-subtitle' }, t('subtitle')),
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
        )
      }
    }

    function makeTabTitle(bind) {
      const t = (key) => {
        try {
          const text = bind(key)
          return typeof text === 'string' && text !== '' ? text : (zh[key] ?? key)
        } catch {
          return zh[key] ?? key
        }
      }
      return function TeamTabTitle() {
        const data = useTickets()
        const live = (data.counts.queued ?? 0) + (data.counts.running ?? 0)
        const color = live > 0 ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)'
        return h(
          'span',
          { className: 'dsh-team-tabtitle' },
          h('span', { className: 'dsh-team-dot', style: { background: color, color } }),
          t('nav'),
          live > 0 ? h('b', { className: 'dsh-team-tabtitle-count' }, String(live)) : null,
        )
      }
    }

    function makeHeaderToggle(bind, openPane) {
      const t = (key) => {
        try {
          const text = bind(key)
          return typeof text === 'string' && text !== '' ? text : (zh[key] ?? key)
        } catch {
          return zh[key] ?? key
        }
      }
      return function HeaderToggle() {
        return h(
          'button',
          { type: 'button', className: 'dsh-team-toggle', onClick: () => openPane(), title: t('nav') },
          h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true }, h('path', {
            d: 'M2 4h12M2 8h12M2 12h7',
            stroke: 'currentColor',
            strokeWidth: 1.6,
            strokeLinecap: 'round',
            fill: 'none',
          })),
          h('span', { className: 'dsh-team-toggle-label' }, t('nav')),
        )
      }
    }

    /** The rail renders the hit target; this component is only the icon inside
     *  it, so it must not bring its own box (alignment with the built-in
     *  entries depends on that). `props.size` comes from the rail. */
    function makePanelIcon(bind) {
      const t = (key) => {
        try {
          const text = bind(key)
          return typeof text === 'string' && text !== '' ? text : (zh[key] ?? key)
        } catch {
          return zh[key] ?? key
        }
      }
      return function PanelIcon(props) {
        const data = useTickets()
        const size = Number.isFinite(props?.size) ? props.size : 18
        const live = (data.counts.queued ?? 0) + (data.counts.running ?? 0)
        return h(
          'span',
          { className: 'dsh-team-rail-icon', 'aria-label': t('nav') },
          h('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
            h('rect', { x: 2.2, y: 2.2, width: 11.6, height: 11.6, rx: 2.6, stroke: 'currentColor', strokeWidth: 1.4 }),
            h('path', { d: 'M5 6.1h6M5 9.4h4', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
          ),
          live > 0
            ? h('span', { className: 'dsh-team-rail-dot', 'aria-hidden': true })
            : null,
        )
      }
    }

    /** The rail selects a `main` panel by key; this one exists only so the
     *  selection lands somewhere — it opens the right pane and hands the
     *  center column back to the conversation. */
    function makeBridgePanel(openPane, layout) {
      return function TeamBridgePanel() {
        const handled = React.useRef(false)
        const mount = React.useLayoutEffect ?? React.useEffect
        mount(() => {
          if (handled.current) return
          handled.current = true
          openPane()
          layout?.selectPanel?.(null)
        }, [])
        return null
      }
    }

    // --- styles -------------------------------------------------------------
    const CSS = `
@keyframes dsh-team-pulse { from { opacity: 0.32; } to { opacity: 1; } }
@keyframes dsh-team-fade { from { opacity: 0; transform: translateX(6px); } to { opacity: 1; transform: none; } }

.dsh-team-pane { position: relative; display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; height: 100%; background: linear-gradient(180deg, var(--dsw-alias-bg-layer-1), var(--dsw-alias-bg-overlay) 200px); }
.dsh-team-pane::before { content: ''; position: absolute; top: 0; left: 14%; right: 14%; height: 1px; background: linear-gradient(90deg, transparent, var(--dsw-alias-brand-primary), transparent); opacity: 0.55; pointer-events: none; }

.dsh-team-head { display: flex; align-items: center; gap: 9px; padding: 12px 12px 8px 14px; }
.dsh-team-brandtile { width: 28px; height: 28px; flex: 0 0 auto; display: flex; align-items: center; justify-content: center; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: linear-gradient(160deg, var(--dsw-alias-bg-layer-2), var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-brand-primary); box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 0 18px -8px var(--dsw-alias-brand-primary); }
.dsh-team-head-left { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1 1 auto; }
.dsh-team-eyebrow { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 8.5px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
.dsh-team-subtitle { font-size: 10.5px; color: var(--dsw-alias-label-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.dsh-team-chips { display: flex; flex-wrap: wrap; gap: 5px; padding: 0 14px 10px; }
.dsh-team-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: linear-gradient(180deg, var(--dsw-alias-bg-layer-2), var(--dsw-alias-bg-layer-1)); font-size: 9.5px; letter-spacing: 0.02em; color: var(--dsw-alias-label-secondary); box-shadow: inset 0 1px 0 rgba(127, 127, 127, 0.05); }
.dsh-team-chip b { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; font-size: 10px; font-weight: 650; color: var(--dsw-alias-label-primary); }
.dsh-team-chip-dot { width: 5px; height: 5px; border-radius: 50%; flex: 0 0 auto; box-shadow: 0 0 8px currentColor; }

.dsh-team-body { display: flex; flex-direction: column; gap: 9px; padding: 0 14px 12px; flex: 1 1 auto; min-height: 0; }
.dsh-team-form { position: relative; display: flex; flex-direction: column; gap: 6px; padding: 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: linear-gradient(180deg, var(--dsw-alias-bg-layer-1), var(--dsw-alias-bg-overlay)); box-shadow: inset 0 1px 0 rgba(127, 127, 127, 0.06); }
.dsh-team-form::before { content: ''; position: absolute; top: 0; left: 18%; right: 18%; height: 1px; background: linear-gradient(90deg, transparent, var(--dsw-alias-brand-primary), transparent); opacity: 0.5; pointer-events: none; }
.dsh-team-input, .dsh-team-textarea { width: 100%; box-sizing: border-box; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-family: inherit; font-size: 12px; padding: 5px 8px; resize: vertical; transition: border-color 120ms ease, box-shadow 140ms ease; }
.dsh-team-textarea { min-height: 56px; line-height: 1.55; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; }
.dsh-team-input:focus, .dsh-team-textarea:focus { outline: none; border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 1px var(--dsw-alias-brand-primary), 0 0 16px -7px var(--dsw-alias-brand-primary); }
.dsh-team-form-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.dsh-team-form-hint { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 9px; letter-spacing: 0.04em; color: var(--dsw-alias-label-secondary); }
.dsh-team-submit { padding: 4px 12px; border: 1px solid var(--dsw-alias-brand-primary); border-radius: 7px; background: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); font-size: 11px; font-weight: 650; letter-spacing: 0.01em; cursor: pointer; transition: filter 140ms ease, box-shadow 160ms ease; }
.dsh-team-submit:hover:not(:disabled) { filter: brightness(1.1); box-shadow: 0 0 22px -6px var(--dsw-alias-brand-primary); }
.dsh-team-submit:disabled { opacity: 0.55; cursor: default; }
.dsh-team-problem { font-size: 11px; color: var(--dsw-alias-state-error-primary); padding: 0 2px; }

.dsh-team-tabs { display: flex; gap: 4px; }
.dsh-team-tab { padding: 2px 8px; border: 1px solid transparent; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 10.5px; cursor: pointer; transition: background 120ms ease, color 120ms ease, border-color 120ms ease; }
.dsh-team-tab:hover { background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); }
.dsh-team-tab.is-on { border-color: var(--dsw-alias-border-l2); background: linear-gradient(180deg, var(--dsw-alias-bg-layer-2), var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-label-primary); box-shadow: 0 0 14px -9px var(--dsw-alias-brand-primary); }

.dsh-team-list { display: flex; flex-direction: column; gap: 6px; overflow: auto; flex: 1 1 auto; min-height: 60px; padding-right: 2px; }
.dsh-team-list::-webkit-scrollbar { width: 8px; }
.dsh-team-list::-webkit-scrollbar-thumb { background: var(--dsw-alias-border-l2); border-radius: 5px; border: 3px solid transparent; background-clip: padding-box; }
.dsh-team-list::-webkit-scrollbar-thumb:hover { background: var(--dsw-alias-label-secondary); border: 3px solid transparent; background-clip: padding-box; }

.dsh-team-row { position: relative; display: flex; align-items: flex-start; gap: 7px; width: 100%; padding: 8px 8px 8px 11px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: linear-gradient(180deg, var(--dsw-alias-bg-layer-1), var(--dsw-alias-bg-overlay)); text-align: left; cursor: pointer; overflow: hidden; transition: border-color 140ms ease, box-shadow 160ms ease; }
.dsh-team-row:hover { border-color: var(--dsw-alias-border-l2); box-shadow: 0 0 22px -14px var(--dsw-alias-brand-primary); }
.dsh-team-row-accent { position: absolute; left: 0; top: 0; bottom: 0; width: 2px; }
.dsh-team-row.is-running .dsh-team-row-accent { box-shadow: 0 0 10px currentColor; animation: dsh-team-pulse 1.8s ease-in-out infinite alternate; }
.dsh-team-dot { flex: 0 0 auto; width: 6px; height: 6px; border-radius: 50%; margin-top: 5px; box-shadow: 0 0 8px currentColor; }
.dsh-team-row-text { display: flex; flex-direction: column; gap: 3px; min-width: 0; flex: 1 1 auto; }
.dsh-team-row-title { font-size: 11.5px; color: var(--dsw-alias-label-primary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dsh-team-row-meta { display: flex; align-items: center; gap: 4px; font-size: 9.5px; color: var(--dsw-alias-label-secondary); }
.dsh-team-badge { font-weight: 650; letter-spacing: 0.02em; }
.dsh-team-sep { opacity: 0.45; }
.dsh-team-id { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 9px; opacity: 0.75; font-variant-numeric: tabular-nums; }
.dsh-team-chevron { flex: 0 0 auto; align-self: center; color: var(--dsw-alias-label-secondary); font-size: 14px; opacity: 0.6; }

.dsh-team-row.is-child { margin-left: 13px; }
.dsh-team-tree { flex: 0 0 auto; align-self: center; font-size: 9px; color: var(--dsw-alias-label-secondary); opacity: 0.55; }
.dsh-team-chip { flex: 0 0 auto; padding: 0 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 4px; background: var(--dsw-alias-bg-layer-1); font-size: 8.5px; letter-spacing: 0.02em; color: var(--dsw-alias-label-secondary); }
.dsh-team-chip.is-wait { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.dsh-team-chip.is-quiet { opacity: 0.65; }
.dsh-team-rel-block { display: flex; flex-direction: column; gap: 4px; padding: 0 14px 8px; }
.dsh-team-rel { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.dsh-team-rel-label { font-size: 9px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); opacity: 0.75; }
.dsh-team-rel-link { max-width: 100%; padding: 1px 6px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; background: transparent; color: var(--dsw-alias-label-primary); font-size: 9.5px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: border-color 120ms ease; }
.dsh-team-rel-link:hover { border-color: var(--dsw-alias-brand-primary); }

.dsh-team-detail { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.dsh-team-detail-head { display: flex; align-items: center; gap: 6px; padding: 10px 12px 8px; }
.dsh-team-back { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px 2px 4px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 10px; cursor: pointer; transition: color 120ms ease, border-color 120ms ease; }
.dsh-team-back:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.dsh-team-detail-elapsed { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dsh-team-detail-title { padding: 0 14px; font-size: 13.5px; font-weight: 650; letter-spacing: -0.01em; line-height: 1.4; color: var(--dsw-alias-label-primary); animation: dsh-team-fade 160ms ease-out; }
.dsh-team-detail-meta { padding: 2px 14px 8px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 9.5px; color: var(--dsw-alias-label-secondary); font-variant-numeric: tabular-nums; }
.dsh-team-detail-body { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; padding: 0 14px; }
.dsh-team-detail-foot { display: flex; align-items: center; gap: 7px; padding: 8px 14px 10px; border-top: 1px solid var(--dsw-alias-border-l1); }
.dsh-team-detail-hint { flex: 1 1 auto; min-width: 0; font-size: 9.5px; line-height: 1.45; color: var(--dsw-alias-label-secondary); }

.dsh-team-report { position: relative; display: flex; flex-direction: column; min-height: 0; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-base); overflow: hidden; box-shadow: inset 0 1px 0 rgba(127, 127, 127, 0.05); }
.dsh-team-report.is-tall { flex: 1 1 auto; }
.dsh-team-report::before { content: ''; position: absolute; top: 0; left: 22%; right: 22%; height: 1px; background: linear-gradient(90deg, transparent, var(--dsw-alias-brand-primary), transparent); opacity: 0.45; pointer-events: none; }
.dsh-team-report-bar { display: flex; align-items: center; justify-content: space-between; padding: 3px 8px; border-bottom: 1px solid var(--dsw-alias-border-l1); background: linear-gradient(180deg, var(--dsw-alias-bg-layer-1), transparent); }
.dsh-team-report-label { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 8.5px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--dsw-alias-label-secondary); }
.dsh-team-report-body { margin: 0; padding: 8px; overflow: auto; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 10.5px; line-height: 1.55; color: var(--dsw-alias-label-primary); white-space: pre-wrap; word-break: break-word; }
.dsh-team-report:not(.is-tall) .dsh-team-report-body { max-height: 220px; }
.dsh-team-path { padding: 0 8px 7px; font-size: 9px; color: var(--dsw-alias-label-secondary); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; word-break: break-all; }
.dsh-team-link { border: 1px solid var(--dsw-alias-border-l1); border-radius: 5px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 9.5px; padding: 1px 5px; cursor: pointer; transition: color 120ms ease, border-color 120ms ease; }
.dsh-team-link:hover { color: var(--dsw-alias-label-primary); border-color: var(--dsw-alias-border-l2); }
.dsh-team-btn { padding: 3px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: linear-gradient(180deg, var(--dsw-alias-bg-layer-2), var(--dsw-alias-bg-layer-1)); color: var(--dsw-alias-label-primary); font-size: 10.5px; cursor: pointer; transition: border-color 120ms ease, box-shadow 140ms ease; }
.dsh-team-btn:hover:not(:disabled) { border-color: var(--dsw-alias-brand-primary); box-shadow: 0 0 16px -8px var(--dsw-alias-brand-primary); }
.dsh-team-btn:disabled { opacity: 0.55; cursor: default; }

.dsh-team-empty { display: flex; align-items: center; justify-content: center; padding: 22px 10px; font-size: 11px; color: var(--dsw-alias-label-secondary); text-align: center; }
.dsh-team-foot-dot { width: 5px; height: 5px; border-radius: 50%; flex: 0 0 auto; background: var(--dsw-alias-brand-primary); box-shadow: 0 0 7px var(--dsw-alias-brand-primary); animation: dsh-team-pulse 2.4s ease-in-out infinite alternate; }

.dsh-team-tabtitle { display: inline-flex; align-items: center; gap: 6px; }
.dsh-team-tabtitle-count { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 9.5px; font-weight: 650; color: var(--dsw-alias-brand-primary); }
.dsh-team-toggle { display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 8px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; cursor: pointer; transition: color 120ms ease, border-color 120ms ease, box-shadow 160ms ease; }
.dsh-team-toggle:hover { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-2); }
.dsh-team-toggle-label { white-space: nowrap; }
.dsh-team-rail-icon { position: relative; display: inline-flex; align-items: center; justify-content: center; }
.dsh-team-rail-dot { position: absolute; top: -1px; right: -2px; width: 5px; height: 5px; border-radius: 50%; background: var(--dsw-alias-brand-primary); box-shadow: 0 0 6px var(--dsw-alias-brand-primary); animation: dsh-team-pulse 2.4s ease-in-out infinite alternate; }
`

    return {
      inject: ['slots', 'locale', 'layout'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-team: dictionaries')
        const bind = ctx.locale.bind(NS)

        // The pane lives in the right sidebar, so it sits beside the chat
        // instead of covering it. Both entry points only need to open the tab.
        const openPane = () => {
          const right = ctx.get('sidebarRight')
          if (right === undefined || right === null || typeof right.openTab !== 'function') return false
          try {
            right.openTab(TAB_KIND, {})
            return true
          } catch {
            return false
          }
        }

        const registerTabType = (scoped) => {
          const registry = scoped.sidebarRightTabs ?? scoped.get?.('sidebarRightTabs')
          if (registry === undefined || registry === null || typeof registry.register !== 'function') return
          scoped.effect(
            () => registry.register({ id: TAB_ID, kind: TAB_KIND, title: () => bind('nav') }),
            'dsh-team: right sidebar tab type',
          )
        }
        try {
          ctx.inject(['sidebarRightTabs'], (scoped) => registerTabType(scoped))
        } catch {
          registerTabType(ctx)
        }

        const Pane = makePane(bind)
        const TabTitle = makeTabTitle(bind)
        const HeaderToggle = makeHeaderToggle(bind, openPane)
        const PanelIcon = makePanelIcon(bind)
        const BridgePanel = makeBridgePanel(openPane, ctx.layout)

        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'dsh-team-toggle', order: 32, label: () => bind('nav'), locale: NS },
            HeaderToggle,
          ),
        )
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: 'dsh-team', order: 22, label: () => bind('nav'), locale: NS },
            PanelIcon,
          ),
        )
        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: 'dsh-team', locale: NS }, BridgePanel),
        )
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS }, Pane),
        )
        ctx.slots.inject('sidebar.right.pane.tab.title', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS }, TabTitle),
        )
      },
    }
  },
})
