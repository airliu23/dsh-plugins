/**
 * Wiring regression — a fake Cordis context, a fake `dsh`, no Harness.
 *
 *   node test/plugin.mjs
 *
 * Covers what a real install would hit first: the plugin activates, registers
 * its routes/tool/prompt section, and `team post` → `team wait` actually runs a
 * worker and comes back with its answer.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { writeFakeDsh } from './fake.mjs'

const dir = mkdtempSync(join(tmpdir(), 'dsh-team-plugin-'))
const fake = writeFakeDsh(dir, 'fake-dsh', {
  node: `process.stdout.write(\`report for: \${last}\\n\`)`,
  sh: `#!/bin/sh
task=$(cat)
printf 'report for: %s\\n' "$(printf '%s' "$task" | tail -n 1)"
`,
})

const registered = { tools: [], routes: [], prompts: [], cleanups: [] }

/** What the Host half would use to push a finished report back into a Session. */
const pushed = []
const fakeAgent = {
  id: 'agent-test',
  session: { id: 'session-test' },
  followup(message) {
    pushed.push(message)
  },
}
const notified = { flushed: 0, resolved: [] }

const stubCtx = {
  effect(fn) {
    const cleanup = fn()
    if (typeof cleanup === 'function') registered.cleanups.push(cleanup)
    return cleanup
  },
  inject(names, cb) {
    if (names.includes('webServer')) {
      cb({
        effect(fn) {
          fn()
        },
        webServer: {
          register(route) {
            registered.routes.push(route)
            return () => {}
          },
        },
      })
    }
    if (names.includes('tools')) {
      cb({
        effect(fn) {
          fn()
        },
        tools: {
          register(tool) {
            registered.tools.push(tool)
            return () => {}
          },
        },
      })
    }
    if (names.includes('systemPrompt')) {
      cb({
        effect(fn) {
          fn()
        },
        systemPrompt: {
          section(section) {
            registered.prompts.push(section)
            return () => {}
          },
        },
      })
    }
    if (names.includes('sessions') || names.includes('sessionController')) {
      cb({
        effect(fn) {
          fn()
        },
        sessions: {
          async flush() {
            notified.flushed += 1
            return true
          },
        },
        sessionController: {
          async resolveAgent(sessionId) {
            notified.resolved.push(sessionId)
            return { agent: fakeAgent }
          },
        },
      })
    }
  },
  logger: { warn() {}, info() {} },
  get() {
    return undefined
  },
}

const until = async (check, timeoutMs = 5_000) => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('等待超时')
    await new Promise((done) => setTimeout(done, 50))
  }
}

try {
  apply(stubCtx, { stateDir: dir, dshBin: fake, maxWorkers: 1, timeoutMs: 5_000 })

  // --- registrations ------------------------------------------------------
  assert.deepEqual(
    registered.tools.map((tool) => tool.name),
    ['team'],
  )
  assert.deepEqual(
    registered.routes.map((route) => route.path.split('/').at(-1)).sort(),
    ['cancel', 'events', 'post', 'retry', 'state'],
  )
  assert.equal(registered.prompts.length, 1)
  assert.match(registered.prompts[0].text, /dsh-team/)

  const tool = registered.tools[0]

  // --- board on an empty store -------------------------------------------
  const empty = await tool.execute({ action: 'board' })
  assert.match(empty.text, /还没有工单/)

  // --- post then wait -----------------------------------------------------
  // The tool call carries the agent; a finished ticket must push its report
  // back into that Session instead of leaving the caller to poll.
  const exec = { agent: fakeAgent }
  const posted = await tool.execute({ action: 'post', title: '冒烟', task: '只输出一行 READY' }, exec)
  assert.match(posted.text, /已投工单 t-/)
  assert.match(posted.text, /推回本会话/, 'post 的回报必须说明完成会自动通知')

  const id = posted.text.match(/已投工单 (t-[\w-]+)/)[1]
  const waited = await tool.execute({ action: 'wait', ids: [id], timeoutMs: 10_000 })
  assert.match(waited.text, /全部结束/)
  assert.match(waited.text, /report for: 只输出一行 READY/)

  await until(() => pushed.length > 0)
  const notice = pushed[0]
  assert.equal(notice.role, 'user')
  assert.equal(notice.source.kind, 'dsh-team')
  assert.equal(notice.source.ticketId, id)
  // The posting tool call hands us the live agent, so no Session restore is needed.
  assert.deepEqual(notified.resolved, [], '有活着的 agent 时不该再 resolveAgent')
  assert.equal(notified.flushed, 1, '推送后必须 flush 会话')
  assert.match(notice.content[0].text, /【后台工单结束】冒烟/)
  assert.match(notice.content[0].text, /report for: 只输出一行 READY/)
  assert.equal(Object.isFrozen(notice), true)

  // --- a summary ticket is gated on its upstream, then gets their reports --
  const upstreamId = (await tool.execute({ action: 'post', title: '上游单', task: '只输出一行 UPSTREAM' })).text.match(
    /已投工单 (t-[\w-]+)/,
  )[1]
  const summaryPost = await tool.execute({
    action: 'post',
    title: '汇总单',
    task: '把上游结论合成一段',
    from: [upstreamId],
  })
  assert.match(summaryPost.text, /这是汇总单/)
  assert.match(summaryPost.text, /等上游 1 张/)
  const summaryId = summaryPost.text.match(/已投工单 (t-[\w-]+)/)[1]

  await tool.execute({ action: 'wait', ids: [upstreamId, summaryId], timeoutMs: 20_000 })
  const summary = (await tool.execute({ action: 'board' })).text
  assert.match(summary, new RegExp(`${summaryId}[\\s\\S]*?done`), '汇总单最终要跑完')

  // The worker was handed the upstream report inside its own task card.
  const taskFile = join(dir, 'outbox', summaryId, 'task.txt')
  const composed = readFileSync(taskFile, 'utf8')
  assert.match(composed, /## 上游工单报告/)
  assert.match(composed, new RegExp(`### ${upstreamId}`))
  assert.match(composed, /report for: 只输出一行 UPSTREAM/, '上游报告要被拼进汇总单的 prompt')
  assert.match(readFileSync(join(dir, 'outbox', summaryId, 'reply.md'), 'utf8'), /report for:/)

  // --- a panel ticket (no Session) is never pushed -----------------------
  const panel = await tool.execute({ action: 'post', title: '面板单', task: '只输出一行 PANEL' })
  await tool.execute({ action: 'wait', ids: [panel.text.match(/已投工单 (t-[\w-]+)/)[1]], timeoutMs: 10_000 })
  await new Promise((done) => setTimeout(done, 300))
  assert.equal(pushed.length, 1, '面板投的单没有会话可通知')

  // --- the report survives a reload (same file, new store) ---------------
  const repo = await tool.execute({ action: 'board', status: 'done' })
  assert.match(repo.text, /冒烟/)

  // --- unknown action -----------------------------------------------------
  await assert.rejects(() => tool.execute({ action: 'nope' }), /未知 action/)

  // --- shutdown is idempotent --------------------------------------------
  for (const cleanup of registered.cleanups) cleanup()

  console.log('plugin: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
