/**
 * Runner regression — a fake `dsh` on disk, no model, no Harness.
 *
 *   node test/runner.mjs
 *
 * The fake reads its task from stdin, echoes it back, and can be told to exit
 * non-zero or to hang, so the timeout path is covered too.
 */
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRunner, credentialsEnv, preamble } from '../runner.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-team-runner-'))
const fake = join(dir, 'fake-dsh')
writeFileSync(
  fake,
  `#!/bin/sh
task=$(cat)
case "$task" in
  *hang*) sleep 30 ;;
  *fail*) echo "partial" ; echo "boom happened" >&2 ; exit 3 ;;
esac
printf 'worker saw: %s\\n' "$(printf '%s' "$task" | tail -n 1)"
[ -n "$SOUTHCHIP_API_KEY" ] && printf 'key: %s\\n' "$SOUTHCHIP_API_KEY"
`,
)
chmodSync(fake, 0o755)

try {
  // --- provider keys are lifted out of the credentials file ---------------
  writeFileSync(
    join(dir, '.credentials.yaml'),
    ['refs:', '  SOUTHCHIP_API_KEY: sk-test-123', '  lower_case: ignored', 'models:', '  x: y'].join('\n'),
  )
  assert.deepEqual(credentialsEnv(dir), { SOUTHCHIP_API_KEY: 'sk-test-123' })
  assert.deepEqual(credentialsEnv(join(dir, 'missing')), {})

  const runner = createRunner({ stateDir: dir, dshBin: fake, timeoutMs: 2_000, dshHome: dir })
  const ticket = { id: 't-1', task: '列一下门禁' }

  // --- success ------------------------------------------------------------
  const ok = await runner.run(ticket)
  assert.equal(ok.exitCode, 0)
  assert.match(ok.report, /列一下门禁/)
  assert.match(ok.report, /key: sk-test-123/, '凭据必须传进子进程')
  assert.equal(existsSync(join(ok.workspace, '..')) && existsSync(ok.workspace), true)
  assert.match(readFileSync(join(ok.outDir, 'task.txt'), 'utf8'), /Working directory/)
  assert.equal(readFileSync(join(ok.outDir, 'reply.md'), 'utf8'), ok.report)
  assert.equal(readFileSync(join(ok.outDir, 'exit'), 'utf8').trim(), '0')

  // --- the preamble names both directories -------------------------------
  const text = preamble('/w/t-1', '/o/t-1')
  assert.match(text, /\/w\/t-1/)
  assert.match(text, /\/o\/t-1/)
  assert.ok(text.endsWith('Task:\n\n') || text.endsWith('Task:\n'), '任务正文必须原样接在后面')

  // --- non-zero exit keeps stdout + stderr -------------------------------
  const bad = await runner.run({ id: 't-2', task: 'please fail' })
  assert.equal(bad.exitCode, 3)
  assert.match(bad.report, /partial/)
  assert.match(bad.log, /boom happened/)

  // --- timeout kills the child -------------------------------------------
  const slow = await runner.run({ id: 't-3', task: 'please hang' })
  assert.equal(slow.exitCode, 124)
  assert.match(slow.error ?? '', /超时/)

  // --- a missing binary rejects instead of pretending to fail a ticket ---
  const broken = createRunner({ stateDir: dir, dshBin: join(dir, 'nope') })
  await assert.rejects(() => broken.run({ id: 't-4', task: 'x' }), /无法启动 worker/)

  console.log('runner: ok')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
