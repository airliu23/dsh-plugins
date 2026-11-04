/**
 * One worker = one `dsh headless` child process.
 *
 * The child runs with its cwd at `stateDir`, because that is what the Headless
 * sandbox takes as its writable root: a worker may then write into its own
 * `worktrees/<id>/` and into `outbox/<id>/`, and nowhere else.
 *
 * The task is handed over on stdin, so no quoting or length limit applies.
 * Returns the child's final answer; the caller (dispatcher) decides the state.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const describe = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Provider keys live in `<DSH_HOME>/.credentials.yaml` (`refs:` holds
 * NAME: value pairs). The Host resolves them for its own turns; a child process
 * starts without them, so a worker would fail with MISSING_CREDENTIAL. Read the
 * plain `*_KEY` refs here and let `process.env` win over the file.
 */
export function credentialsEnv(dshHome) {
  const home = typeof dshHome === 'string' && dshHome.trim() !== '' ? dshHome.trim() : join(homedir(), '.dsh')
  const path = join(home, '.credentials.yaml')
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  const env = {}
  let inRefs = false
  for (const line of text.split('\n')) {
    if (/^refs:\s*$/.test(line)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    if (/^\S/.test(line)) break // next top-level key
    const match = /^\s+([A-Z][A-Z0-9_]*)\s*:\s*(.+?)\s*$/.exec(line)
    if (match === null) continue
    const value = match[2].replace(/^['"]|['"]$/g, '')
    if (value !== '') env[match[1]] = value
  }
  return env
}

/** Everything a worker is told before the card itself; the card stays verbatim. */
export function preamble(workspace, outDir) {
  return [
    'You are one worker in a local team.',
    `Working directory (yours alone): ${workspace}`,
    `Output directory (read by the operator): ${outDir}`,
    'Put the full report in your final answer — it is saved to reply.md.',
    'If you must write files, write them under the two directories above; anything else is read-only.',
    '',
    'Task:',
    '',
  ].join('\n')
}

/**
 * @param {{
 *   stateDir: string,
 *   dshBin?: string,
 *   patchFile?: string,
 *   timeoutMs?: number,
 *   env?: Record<string, string | undefined>,
 *   dshHome?: string,
 * }} options
 */
export function createRunner(options) {
  const stateDir = options.stateDir
  const dshBin = typeof options.dshBin === 'string' && options.dshBin.trim() !== '' ? options.dshBin.trim() : 'dsh'
  const patchFile = typeof options.patchFile === 'string' && options.patchFile.trim() !== '' ? options.patchFile.trim() : ''
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? Math.trunc(options.timeoutMs) : 3_600_000

  function paths(ticket) {
    return {
      workspace: join(stateDir, 'worktrees', ticket.id),
      outDir: join(stateDir, 'outbox', ticket.id),
    }
  }

  /**
   * Run one ticket to completion. Never rejects for a worker failure — the
   * exit code carries that — only for a failure to even start the child.
   */
  function run(ticket) {
    const { workspace, outDir } = paths(ticket)
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outDir, { recursive: true })

    const task = preamble(workspace, outDir) + ticket.task
    writeFileSync(join(outDir, 'task.txt'), task)

    const args = ['headless']
    if (patchFile !== '') args.push('--patch', patchFile)
    args.push('-')

    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(dshBin, args, {
          cwd: stateDir,
          env: { ...credentialsEnv(options.dshHome), ...process.env, ...options.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      } catch (error) {
        reject(new Error(`无法启动 worker（${dshBin}）：${describe(error)}`))
        return
      }

      let stdout = ''
      let stderr = ''
      let settled = false
      const cap = (text, chunk) => (text.length > 400_000 ? text : text + chunk)

      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        stdout = cap(stdout, chunk)
      })
      child.stderr.on('data', (chunk) => {
        stderr = cap(stderr, chunk)
      })

      const timer = setTimeout(() => {
        try {
          child.kill('SIGTERM')
          setTimeout(() => child.kill('SIGKILL'), 5_000).unref?.()
        } catch {
          /* already gone */
        }
      }, timeoutMs)
      timer.unref?.()

      const finish = (exitCode, error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        writeFileSync(join(outDir, 'reply.md'), stdout)
        writeFileSync(join(outDir, 'log.txt'), stderr)
        writeFileSync(join(outDir, 'exit'), `${exitCode}\n`)
        resolve({ exitCode, report: stdout, log: stderr, workspace, outDir, error })
      }

      child.on('error', (error) => {
        clearTimeout(timer)
        if (settled) return
        settled = true
        reject(new Error(`无法启动 worker（${dshBin}）：${describe(error)}`))
      })
      child.on('close', (code, signal) => {
        const exitCode = Number.isInteger(code) ? code : signal ? 124 : 1
        const error = exitCode === 124 ? `超时（${Math.round(timeoutMs / 1000)} s）已被终止` : ''
        finish(exitCode, error)
      })

      child.stdin.on('error', () => {
        /* the child may exit before reading stdin */
      })
      child.stdin.end(task)
    })
  }

  return { run, paths }
}
