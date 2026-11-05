/**
 * Owns the queue: how many workers run at once, who starts next, and what a
 * finished worker means for its ticket.
 *
 * The dispatcher never touches the network or the browser — it mutates the
 * store, and the store's subscribers push the change to the panel and the tool.
 */
const describe = (error) => (error instanceof Error ? error.message : String(error))

const TERMINAL = new Set(['done', 'failed', 'canceled'])

/** Upstream tickets of this one that have not settled yet (an evicted id is settled). */
export function openDeps(store, ticket) {
  return (ticket.waitsFor ?? []).filter((id) => {
    const dep = store.find(id)
    return dep !== undefined && !TERMINAL.has(dep.state)
  })
}

/**
 * The upstream reports, pasted under the task. A summary ticket is a captain
 * that must not re-read what its workers already read, so the material arrives
 * in the prompt; sizes are capped because the worker's own context is finite.
 */
export const UPSTREAM_REPORT_CHARS = 6_000
export const UPSTREAM_TOTAL_CHARS = 14_000

export function upstreamSection(store, ticket) {
  const deps = (ticket.waitsFor ?? []).map((id) => store.find(id)).filter((dep) => dep !== undefined)
  if (deps.length === 0) return ''
  const lines = ['', '## 上游工单报告', '']
  let spent = 0
  for (const dep of deps) {
    const body = (dep.state === 'done' ? dep.report : dep.error || dep.report).trim()
    const room = Math.max(0, Math.min(UPSTREAM_REPORT_CHARS, UPSTREAM_TOTAL_CHARS - spent))
    const clipped =
      body.length > room ? `${body.slice(0, room)}\n…（已截断，完整报告在 ${dep.outDir || 'outbox'} 的 reply.md）` : body
    spent += Math.min(body.length, room)
    lines.push(`### ${dep.id} · ${dep.title}（${dep.state}）`, '')
    lines.push(clipped === '' ? '（这张工单没有留下报告）' : clipped, '')
  }
  lines.push(`以上是上游工单的成品报告（共 ${deps.length} 张），可以直接引用，不需要重读它们读过的文件。`)
  return lines.join('\n')
}

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
    // Everything upstream has settled by now: hand its reports to the worker.
    const upstream = upstreamSection(store, ticket)
    const task = upstream === '' ? ticket.task : `${ticket.task}\n${upstream}`
    const runnerTask = runner
      .run(ticket, task)
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
      // A gated ticket keeps its place in the queue but lets later ones start.
      const ticket = store.nextQueued((candidate) => openDeps(store, candidate).length === 0)
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
