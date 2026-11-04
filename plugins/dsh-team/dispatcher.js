/**
 * Owns the queue: how many workers run at once, who starts next, and what a
 * finished worker means for its ticket.
 *
 * The dispatcher never touches the network or the browser — it mutates the
 * store, and the store's subscribers push the change to the panel and the tool.
 */
const describe = (error) => (error instanceof Error ? error.message : String(error))

/** The tail of a worker's stderr is the only useful part when the child dies. */
export function tailLog(log, limit = 600) {
  const text = typeof log === 'string' ? log.trim() : ''
  if (text === '') return ''
  return text.length > limit ? `…${text.slice(-limit)}` : text
}

/**
 * @param {{
 *   store: ReturnType<typeof import('./store.js').createTicketStore>,
 *   runner: ReturnType<typeof import('./runner.js').createRunner>,
 *   maxWorkers?: number,
 * }} options
 */
export function createDispatcher(options) {
  const store = options.store
  const runner = options.runner
  const maxWorkers = Number.isFinite(options.maxWorkers) && options.maxWorkers >= 1 ? Math.trunc(options.maxWorkers) : 3

  /** @type {Map<string, Promise<void>>} */
  const active = new Map()
  let stopped = false

  function start(ticket) {
    store.patch(ticket.id, { state: 'running', startedAt: Date.now(), error: '', report: '' })
    const task = runner
      .run(ticket)
      .then((result) => {
        const finishedAt = Date.now()
        if (result.exitCode === 0) {
          store.patch(ticket.id, {
            state: 'done',
            exitCode: 0,
            finishedAt,
            report: result.report,
            workspace: result.workspace,
            outDir: result.outDir,
          })
        } else {
          store.patch(ticket.id, {
            state: 'failed',
            exitCode: result.exitCode,
            finishedAt,
            workspace: result.workspace,
            outDir: result.outDir,
            error: result.error || tailLog(result.log) || `worker 退出码 ${result.exitCode}`,
          })
        }
      })
      .catch((error) => {
        store.patch(ticket.id, { state: 'failed', finishedAt: Date.now(), error: describe(error) })
      })
      .finally(() => {
        active.delete(ticket.id)
        pump()
      })
    active.set(ticket.id, task)
  }

  function pump() {
    if (stopped) return
    while (active.size < maxWorkers) {
      const ticket = store.nextQueued()
      if (ticket === undefined) break
      start(ticket)
    }
  }

  /** Cancel is only meaningful before a worker owns the ticket. */
  function cancel(id) {
    const ticket = store.find(id)
    if (ticket === undefined) throw new Error(`没有这张工单：${id}`)
    if (ticket.state !== 'queued') throw new Error(`只有排队中的工单能取消（当前：${ticket.state}）`)
    store.patch(id, { state: 'canceled', finishedAt: Date.now() })
  }

  /** Put a finished ticket back in the queue, keeping its id. */
  function retry(id) {
    const ticket = store.find(id)
    if (ticket === undefined) throw new Error(`没有这张工单：${id}`)
    if (ticket.state === 'running' || ticket.state === 'queued') throw new Error(`工单还在进行中：${id}`)
    store.patch(id, { state: 'queued', error: '', report: '', exitCode: null, startedAt: null, finishedAt: null })
    pump()
  }

  return {
    pump,
    cancel,
    retry,
    stop() {
      stopped = true
    },
    get activeCount() {
      return active.size
    },
    get maxWorkers() {
      return maxWorkers
    },
  }
}
