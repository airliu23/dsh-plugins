/**
 * Client half of the serial-monitor bundle.
 *
 * Two seats, fed by the Host's parallel captures (one per port@baud):
 *   conversation.session.header.utilities → the toggle button in the header
 *   sidebar.right.pane.tab (keyed)        → the log as a RIGHT SIDEBAR TAB
 *
 * Nothing is probed here: the ports and baud rates come from the session
 * (`serial_monitor watch`) or from the add row in this panel.
 */
window.__ModuleLoader__.load({
  id: '@local/serial-monitor',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'serial-monitor'
    const API = '/plugins/serial-monitor'
    const TEXT_LIMIT = 200_000
    /** Tab type id: also the key both sidebar.right.pane.tab slots dispatch on. */
    const TAB_ID = '@local/serial-monitor'
    const TAB_KIND = 'serial-monitor'

    const zh = {
      title: '串口回显',
      echo: '串口',
      empty: '清单是空的。在下面指定端口与波特率，或让会话用 watch 声明。',
      resume: '按清单重开',
      stopAll: '全部停止',
      autoscroll: '自动滚动',
      clear: '清空',
      copy: '复制',
      copied: '已复制',
      remove: '停止',
      add: '添加',
      port: '端口',
      baud: '波特率',
      addHint: '指定端口与波特率',
      declared: '清单',
      noPorts: '没发现串口',
      bytes: 'B',
      hint: '端口只由你在这些按钮里开关，会话只能读数据',
      errors: '错误：',
      truncated: '更早的日志已被丢弃（缓冲区上限）',
      noSurface: '右侧栏还没准备好，先打开一个会话再点一次。',
      running: '接收中',
      idle: '未连接',
      portList: '端口列表',
    }

    const en = {
      title: 'Serial echo',
      echo: 'Serial',
      empty: 'Nothing declared. Pick a port and baud below, or let the session declare one with watch.',
      resume: 'Reopen',
      stopAll: 'Stop all',
      autoscroll: 'Auto-scroll',
      clear: 'Clear',
      copy: 'Copy',
      copied: 'Copied',
      remove: 'Stop',
      add: 'Add',
      port: 'Port',
      baud: 'Baud',
      addHint: 'Port and baud',
      declared: 'Declared',
      noPorts: 'No serial port found',
      bytes: 'B',
      hint: 'Only you open or close a port here — the session can merely read it',
      errors: 'Error: ',
      truncated: 'Older lines were dropped (buffer limit)',
      noSurface: 'The right sidebar is not ready — open a session and try again.',
      running: 'Receiving',
      idle: 'Not connected',
      portList: 'Ports',
    }

    const store = {
      streams: [],
      byKey: new Map(),
      manual: false,
      diag: null,
      declared: [],
      ports: [],
      autoscroll: true,
      listeners: new Set(),
      subscribe(listener) {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
      },
      emit() {
        for (const listener of [...this.listeners]) listener()
      },
      clearText() {
        for (const stream of this.streams) stream.text = ''
      },
      apply(payload) {
        if (typeof payload !== 'object' || payload === null) return
        // Every subscriber repaints on `emit()`, so it must fire exactly when
        // something visible changed — a cursor-only tick must stay silent.
        let changed = false
        if (typeof payload.manual === 'boolean' && payload.manual !== this.manual) {
          this.manual = payload.manual
          changed = true
        }
        if (payload.diag !== undefined && payload.diag !== this.diag) {
          this.diag = payload.diag
          changed = true
        }
        if (Array.isArray(payload.declared) && JSON.stringify(payload.declared) !== JSON.stringify(this.declared)) {
          this.declared = payload.declared
          changed = true
        }
        if (!Array.isArray(payload.streams)) {
          if (changed) this.emit()
          return
        }
        const seen = new Set()
        for (const incoming of payload.streams) {
          if (typeof incoming?.key !== 'string') continue
          seen.add(incoming.key)
          let stream = this.byKey.get(incoming.key)
          if (stream === undefined) {
            stream = { key: incoming.key, port: incoming.port, baud: incoming.baud, text: '', cursor: 0, total: 0, running: false, error: null }
            this.byKey.set(incoming.key, stream)
            this.streams.push(stream)
            changed = true
          }
          if (typeof incoming.text === 'string' && incoming.text !== '') {
            stream.text += incoming.text
            if (stream.text.length > TEXT_LIMIT) stream.text = stream.text.slice(stream.text.length - TEXT_LIMIT)
            changed = true
          }
          if (typeof incoming.cursor === 'number') stream.cursor = incoming.cursor
          if (typeof incoming.total === 'number') stream.total = incoming.total
          if (typeof incoming.running === 'boolean' && incoming.running !== stream.running) {
            stream.running = incoming.running
            changed = true
          }
          if (incoming.port !== undefined) stream.port = incoming.port
          if (incoming.baud !== undefined) stream.baud = incoming.baud
          const error = typeof incoming.error === 'string' ? incoming.error : null
          if (error !== stream.error) {
            stream.error = error
            changed = true
          }
          if ((incoming.truncated === true) !== stream.truncated) {
            stream.truncated = incoming.truncated === true
            changed = true
          }
        }
        for (const stream of [...this.streams]) {
          if (!seen.has(stream.key)) {
            this.streams = this.streams.filter((entry) => entry !== stream)
            this.byKey.delete(stream.key)
            changed = true
          }
        }
        if (changed) this.emit()
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

    const describe = (error) => (error instanceof Error ? error.message : String(error))

    // One shared poll loop, ref-counted by whichever seat is mounted.
    let loopUsers = 0
    let loopTimer = null
    let loopInFlight = false

    const sinceQuery = () =>
      store.streams
        .map((stream) => `${encodeURIComponent(stream.key)}:${stream.cursor}`)
        .join(',')

    function scheduleLoop() {
      if (loopUsers <= 0) return
      const delay = store.streams.some((stream) => stream.running) ? 300 : 1200
      loopTimer = setTimeout(() => {
        loopTimer = null
        void pollOnce()
      }, delay)
    }

    async function pollOnce() {
      if (loopInFlight) return
      loopInFlight = true
      try {
        const payload = await requestJson(`${API}/poll?since=${sinceQuery()}`)
        store.apply(payload)
      } catch {
        /* the next tick retries; a transient 401 during reload is expected */
      } finally {
        loopInFlight = false
        if (loopTimer === null) scheduleLoop()
      }
    }

    function useSerial() {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        const off = store.subscribe(() => bump((value) => value + 1))
        loopUsers += 1
        if (loopTimer === null && !loopInFlight) void pollOnce()
        return () => {
          off()
          loopUsers -= 1
          if (loopUsers <= 0) {
            loopUsers = 0
            if (loopTimer !== null) {
              clearTimeout(loopTimer)
              loopTimer = null
            }
          }
        }
      }, [])
      return store
    }

    const mono = {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 12,
      lineHeight: 1.5,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-all',
      margin: 0,
    }

    const subtle = { fontSize: 11, color: 'var(--dsw-alias-label-secondary)' }

    const dot = (color) =>
      h('span', {
        style: { width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block', flex: '0 0 auto' },
      })

    function makeTranslator(bind) {
      return (translateProps) => {
        if (typeof translateProps?.t === 'function') return translateProps.t
        return (key) => {
          try {
            const text = bind(key)
            return typeof text === 'string' && text !== '' ? text : key
          } catch {
            return zh[key] ?? key
          }
        }
      }
    }

    const actionStyle = {
      height: 22,
      padding: '0 8px',
      borderRadius: 5,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 11,
      lineHeight: '20px',
      cursor: 'pointer',
    }

    const fieldStyle = {
      height: 22,
      borderRadius: 5,
      border: '1px solid var(--dsw-alias-border-l1)',
      background: 'var(--dsw-alias-bg-layer-2)',
      color: 'var(--dsw-alias-label-primary)',
      fontSize: 11,
      padding: '0 6px',
      boxSizing: 'border-box',
    }

    function makeHeaderButton(bind, openPanel) {
      const pick = makeTranslator(bind)
      return function SerialHeaderButton(props) {
        const translate = pick(props)
        const state = useSerial()
        const [notice, setNotice] = React.useState(null)
        const count = state.streams.length
        const running = state.streams.filter((stream) => stream.running).length
        const color = running > 0 ? 'var(--dsw-alias-state-success-primary)' : count > 0 ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-idle-primary)'
        return h(
          'button',
          {
            type: 'button',
            onClick: () => {
              const failure = openPanel()
              if (failure) {
                setNotice(failure)
                setTimeout(() => setNotice(null), 2500)
              }
            },
            title: notice ?? (count > 0 ? `${translate('title')} · ${count} 路` : translate('title')),
            'aria-label': translate('title'),
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 26,
              padding: '0 10px',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l1)',
              background: 'transparent',
              color: 'var(--dsw-alias-label-primary)',
              fontSize: 12,
              cursor: 'pointer',
            },
          },
          dot(color),
          translate('echo'),
          count > 0 ? h('span', { style: { ...subtle, fontSize: 11 } }, String(count)) : null,
        )
      }
    }

    function makeTabTitle(bind) {
      const pick = makeTranslator(bind)
      return function SerialTabTitle(props) {
        const translate = pick(props)
        const state = useSerial()
        const running = state.streams.filter((stream) => stream.running).length
        return h(
          'span',
          { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
          dot(running > 0 ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)'),
          translate('echo'),
          state.streams.length > 0 ? h('span', { style: { ...subtle, fontSize: 11 } }, `${state.streams.length}`) : null,
        )
      }
    }

    function makeTabBody(bind) {
      const pick = makeTranslator(bind)
      return function SerialTabBody(props) {
        const translate = pick(props)
        const state = useSerial()
        const logRefs = React.useRef(new Map())
        /** key → still pinned to the bottom? Scrolling up opts one card out. */
        const stickRef = React.useRef(new Map())
        /** The scrolling column that holds the cards, and whether it follows. */
        const listRef = React.useRef(null)
        const listStickRef = React.useRef(true)
        const [portDraft, setPortDraft] = React.useState('')
        const [baudDraft, setBaudDraft] = React.useState('9600')
        const [notice, setNotice] = React.useState(null)

        React.useEffect(() => {
          void requestJson(`${API}/ports`)
            .then((payload) => {
              state.ports = Array.isArray(payload.ports) ? payload.ports : []
              if (Array.isArray(payload.declared)) state.declared = payload.declared
              if (portDraft === '' && state.ports.length > 0) setPortDraft(state.ports[0].device)
              state.emit()
            })
            .catch(() => {})
        }, [])

        // `state.streams` is mutated in place, so it can never be a dependency:
        // a stamp derived from the rendered text is what tells this effect that
        // new lines actually arrived.
        const growth = state.streams.map((stream) => `${stream.key}:${stream.text.length}`).join('|')

        // Pinning must work for whichever node actually scrolls: with a
        // definite-height pane it is the card's own `pre`, but if the tab is
        // laid out with auto height the scroll happens one level up.
        const pin = (key) => {
          const element = logRefs.current.get(key)
          if (element === undefined || element === null) return
          element.scrollTop = element.scrollHeight
          const list = listRef.current
          // The column's own "follow" flag, not its current distance to the
          // end: content has just grown, so measuring now would always look
          // like the user had scrolled away.
          if (list !== null && list !== undefined && listStickRef.current) list.scrollTop = list.scrollHeight
          stickRef.current.set(key, true)
        }

        React.useEffect(() => {
          if (!state.autoscroll) return
          for (const stream of state.streams) if (stickRef.current.get(stream.key) !== false) pin(stream.key)
        }, [growth, state.autoscroll])

        const act = async (path, body) => {
          setNotice(null)
          try {
            const payload = await requestJson(`${API}/${path}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body ?? {}),
            })
            state.apply(payload)
          } catch (error) {
            setNotice(describe(error))
          }
        }

        const running = state.streams.filter((stream) => stream.running).length
        const summary = state.streams.length === 0 ? translate('idle') : `${running}/${state.streams.length} ${translate('running')}`

        const cards = state.streams.map((stream) =>
          h(
            'div',
            {
              key: stream.key,
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
                minHeight: 0,
                flex: '1 1 0',
                border: '1px solid var(--dsw-alias-border-l1)',
                borderRadius: 8,
                padding: 6,
                background: 'var(--dsw-alias-bg-layer-1)',
              },
            },
            h(
              'div',
              { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
              dot(
                stream.running
                  ? 'var(--dsw-alias-state-success-primary)'
                  : stream.error
                    ? 'var(--dsw-alias-state-error-primary)'
                    : 'var(--dsw-alias-state-idle-primary)',
              ),
              h('span', { style: { ...subtle, fontWeight: 600, flex: '0 0 auto' } }, stream.key),
              h('span', { style: { ...subtle, flex: '0 0 auto' } }, `${stream.total} ${translate('bytes')}`),
              stream.error !== null
                ? h(
                    'span',
                    {
                      style: {
                        ...subtle,
                        color: 'var(--dsw-alias-state-error-primary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        minWidth: 0,
                        flex: 1,
                      },
                    },
                    stream.error,
                  )
                : h('span', { style: { flex: 1 } }),
              h('button', { type: 'button', onClick: () => void act('remove', { key: stream.key }), style: actionStyle }, translate('remove')),
            ),
            h(
              'pre',
              {
                ref: (element) => {
                  if (element === null) {
                    logRefs.current.delete(stream.key)
                    return
                  }
                  logRefs.current.set(stream.key, element)
                  // A card that just appeared starts pinned to its newest line.
                  if (stickRef.current.get(stream.key) !== false) element.scrollTop = element.scrollHeight
                },
                onScroll: (event) => {
                  // Scrolled up = "I'm reading history": stop chasing the tail
                  // until this card is back at the bottom.
                  const element = event.currentTarget
                  const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 24
                  stickRef.current.set(stream.key, atBottom)
                },
                style: {
                  ...mono,
                  flex: '1 1 0',
                  minHeight: 0,
                  overflow: 'auto',
                  overscrollBehavior: 'contain',
                  background: 'var(--dsw-alias-bg-layer-2)',
                  border: '1px solid var(--dsw-alias-border-l1)',
                  borderRadius: 6,
                  padding: '6px 8px',
                  boxSizing: 'border-box',
                },
              },
              stream.text === '' ? h('span', { style: subtle }, stream.truncated ? translate('truncated') : '…') : stream.text,
            ),
          ),
        )

        return h(
          'div',
          {
            role: 'region',
            'aria-label': translate('title'),
            'data-serial-monitor': 'pane',
            style: {
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              height: '100%',
              minHeight: 0,
              boxSizing: 'border-box',
              padding: 10,
              color: 'var(--dsw-alias-label-primary)',
            },
          },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            dot(running > 0 ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-idle-primary)'),
            h('span', { style: { ...subtle, flex: 1, minWidth: 60 } }, summary),
            h('button', { type: 'button', onClick: () => void act('resume'), style: actionStyle }, translate('resume')),
            h('button', { type: 'button', onClick: () => void act('stop'), style: actionStyle }, translate('stopAll')),
            h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  state.autoscroll = !state.autoscroll
                  // Re-enabling means "catch up now", including cards that were
                  // opted out by scrolling up.
                  if (state.autoscroll) {
                    for (const stream of state.streams) pin(stream.key)
                  }
                  state.emit()
                },
                'aria-pressed': state.autoscroll,
                style: { ...actionStyle, opacity: state.autoscroll ? 1 : 0.55 },
              },
              translate('autoscroll'),
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  state.clearText()
                  state.emit()
                },
                style: actionStyle,
              },
              translate('clear'),
            ),
            h(
              'button',
              {
                type: 'button',
                onClick: async () => {
                  try {
                    await navigator.clipboard.writeText(
                      state.streams.map((stream) => `===== ${stream.key} =====\n${stream.text}`).join('\n\n'),
                    )
                    setNotice(translate('copied'))
                    setTimeout(() => setNotice(null), 1500)
                  } catch {
                    setNotice(translate('errors') + 'clipboard')
                  }
                },
                style: actionStyle,
              },
              translate('copy'),
            ),
          ),
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' } },
            h('span', { style: subtle }, translate('addHint')),
            h(
              'select',
              {
                value: portDraft,
                onChange: (event) => setPortDraft(event.target.value),
                style: { ...fieldStyle, maxWidth: 170 },
                'aria-label': translate('port'),
              },
              state.ports.length === 0 ? h('option', { value: '' }, translate('noPorts')) : null,
              state.ports.map((entry) =>
                h('option', { key: entry.device, value: entry.device }, entry.description ? `${entry.device} — ${entry.description}` : entry.device),
              ),
            ),
            h('input', {
              value: baudDraft,
              onChange: (event) => setBaudDraft(event.target.value.replace(/[^0-9]/g, '')),
              style: { ...fieldStyle, width: 74 },
              inputMode: 'numeric',
              'aria-label': translate('baud'),
            }),
            h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  const baud = Number.parseInt(baudDraft, 10)
                  if (portDraft === '' || !Number.isFinite(baud)) {
                    setNotice(translate('port'))
                    return
                  }
                  void act('add', { port: portDraft, baud })
                },
                style: actionStyle,
              },
              translate('add'),
            ),
            state.declared.length > 0
              ? h('span', { style: subtle }, `${translate('declared')}: ${state.declared.map((entry) => `${entry.port}@${entry.baud}`).join(', ')}`)
              : null,
            h('span', { style: { flex: 1 } }),
            notice !== null ? h('span', { style: { ...subtle, color: 'var(--dsw-alias-state-warn-primary)' } }, notice) : null,
          ),
          h(
            'div',
            {
              ref: (element) => {
                listRef.current = element
              },
              onScroll: (event) => {
                // A column scrolled away from its end stops chasing the tail,
                // and re-arms every card once it is back at the bottom.
                const element = event.currentTarget
                const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight <= 24
                listStickRef.current = atBottom
                for (const stream of state.streams) stickRef.current.set(stream.key, atBottom)
              },
              style: { display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 0', minHeight: 0, overflow: 'auto' },
            },
            state.streams.length === 0 ? h('div', { style: { ...subtle, padding: '8px 2px' } }, translate('empty')) : cards,
          ),
          h('div', { style: subtle }, translate('hint')),
        )
      }
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'serial-monitor: dictionaries')
        // Self-healing poll loop: a dropped tick must never freeze the panel,
        // which would look like "the log only updates when I click something".
        ctx.effect(
          () => {
            const guard = setInterval(() => {
              if (loopUsers > 0 && loopTimer === null && !loopInFlight) void pollOnce()
            }, 2_000)
            return () => clearInterval(guard)
          },
          'serial-monitor: poll watchdog',
        )
        const bind = ctx.locale.bind(NS)
        const t = (key) => {
          try {
            const text = bind(key)
            return typeof text === 'string' && text !== '' ? text : (zh[key] ?? key)
          } catch {
            return zh[key] ?? key
          }
        }

        /** `sidebarRight.openTab` needs an adopted on-screen session. */
        const openPanel = () => {
          const right = ctx.get('sidebarRight')
          if (right === undefined || right === null) return t('noSurface')
          try {
            right.openTab(TAB_KIND, {})
            return null
          } catch (error) {
            return describe(error)
          }
        }

        const registerType = (scoped) => {
          const registry = scoped.sidebarRightTabs ?? scoped.get?.('sidebarRightTabs')
          if (registry === undefined || registry === null) return
          scoped.effect(
            () =>
              registry.register({
                id: TAB_ID,
                kind: TAB_KIND,
                title: () => t('title'),
              }),
            'serial-monitor: right sidebar tab type',
          )
        }
        try {
          ctx.inject(['sidebarRightTabs'], (scoped) => registerType(scoped))
        } catch {
          registerType(ctx)
        }

        const HeaderButton = makeHeaderButton(bind, openPanel)
        const TabBody = makeTabBody(bind)
        const TabTitle = makeTabTitle(bind)

        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register({ name: 'conversation.session.header.utilities', id: 'serial-monitor-toggle', order: 20, locale: NS }, HeaderButton),
        )
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID, locale: NS }, TabBody))
        ctx.slots.inject('sidebar.right.pane.tab.title', () =>
          ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID, locale: NS }, TabTitle),
        )

        // One-shot self-check posted back to the Host, readable through the tool.
        const postDiag = (payload) => {
          void requestJson(`${API}/diag`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
          }).catch(() => {})
        }
        const probe = () => {
          try {
            const canGet = typeof ctx.get === 'function'
            const tabs = canGet ? ctx.get('sidebarRightTabs') : undefined
            const right = canGet ? ctx.get('sidebarRight') : undefined
            let registered = null
            let types = []
            try {
              registered = tabs?.get?.(TAB_KIND)?.id ?? null
              types = (tabs?.entries?.() ?? []).map((entry) => entry.id).slice(-4)
            } catch (inner) {
              registered = describe(inner)
            }
            postDiag({
              hasGet: canGet,
              hasTabs: tabs !== undefined && tabs !== null,
              hasRight: right !== undefined && right !== null,
              tabKindRegistered: registered,
              types,
            })
          } catch (error) {
            postDiag({ fatal: describe(error) })
          }
        }
        setTimeout(probe, 1200)
        setTimeout(probe, 4000)
      },
    }
  },
})
