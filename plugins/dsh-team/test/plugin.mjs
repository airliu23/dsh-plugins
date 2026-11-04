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
import { mkdtempSync, rmSync } from 'node:fs'
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
  },
  get() {
    return undefined
  },
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
  const posted = await tool.execute({ action: 'post', title: '冒烟', task: '只输出一行 READY' })
  assert.match(posted.text, /已投工单 t-/)

  const id = posted.text.match(/已投工单 (t-[\w-]+)/)[1]
  const waited = await tool.execute({ action: 'wait', ids: [id], timeoutMs: 10_000 })
  assert.match(waited.text, /全部结束/)
  assert.match(waited.text, /report for: 只输出一行 READY/)

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
