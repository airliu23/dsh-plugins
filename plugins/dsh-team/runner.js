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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'

const WINDOWS = process.platform === 'win32'
/**
 * Extensions a bare command name may resolve to, in preference order. There is
 * deliberately no empty entry: npm also writes an extension-less `dsh` (a POSIX
 * shell script), and `CreateProcess` can only start `.exe`/`.com` plus the
 * interpreter-routed `.cmd`/`.bat`/`.ps1` shims — never that one.
 */
const WINDOWS_EXTENSIONS = ['.exe', '.com', '.cmd', '.bat', '.ps1']

const describe = (error) => (error instanceof Error ? error.message : String(error))

/** Find a bare command on PATH, or a path command with an implicit extension. */
function resolveWindowsCommand(command) {
  const hasExecutableExtension = /\.(exe|com|cmd|bat|ps1)$/i.test(command)
  if (hasExecutableExtension && existsSync(command)) return command
  const mayBePath = isAbsolute(command) || command.includes('\\') || command.includes('/')
  if (mayBePath) {
    for (const extension of WINDOWS_EXTENSIONS) {
      if (existsSync(command + extension)) return command + extension
    }
    return null
  }
  const pathext = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter((extension) => extension.trim() !== '')
  const extensions = [...new Set([...WINDOWS_EXTENSIONS, ...pathext.map((extension) => extension.toLowerCase())])]
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (directory.trim() === '') continue
    for (const extension of extensions) {
      const candidate = join(directory, command + extension)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

/** Quote one argument for a `cmd.exe /c` command line; only spaces need it here. */
const quoteArgument = (argument) => (/^[^\s"]*$/.test(argument) ? argument : `"${argument.replace(/"/g, '')}"`)

/**
 * How to start `command`. Windows cannot exec a `.cmd` shim directly —
 * `CreateProcess` only appends `.exe`, and the `dsh` installed by npm (and by
 * the Desktop app) is exactly such a shim — so resolve the name first and route
 * shims through the command interpreter. Returns null when nothing matches.
 */
function resolveInvocation(command, args) {
  if (!WINDOWS) return { file: command, args, verbatim: false }
  const found = resolveWindowsCommand(command)
  if (found === null) return null
  if (/\.(cmd|bat)$/i.test(found)) {
    const line = [found, ...args].map(quoteArgument).join(' ')
    return {
      file: process.env.ComSpec ?? 'cmd.exe',
      args: ['/d', '/s', '/c', `"${line}"`],
      verbatim: true,
    }
  }
  if (/\.ps1$/i.test(found)) {
    return {
      file: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', found, ...args],
      verbatim: false,
    }
  }
  return { file: found, args, verbatim: false }
}

/**
 * Stop a worker and everything it started. A Windows shim runs under
 * `cmd.exe`, so killing the child alone would leave the real worker (and the
 * stdio pipes this promise waits on) alive.
 */
function terminate(child) {
  if (WINDOWS && Number.isInteger(child.pid)) {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' })
      return
    } catch {
      /* fall through to the signal path */
    }
  }
  try {
    child.kill('SIGTERM')
    setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {
        /* already gone */
      }
    }, 5_000).unref?.()
  } catch {
    /* already gone */
  }
}

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
   *
   * `body` overrides `ticket.task` when the dispatcher has already composed the
   * prompt (a summary ticket carries its upstream reports along).
   */
  function run(ticket, body) {
    const { workspace, outDir } = paths(ticket)
    mkdirSync(workspace, { recursive: true })
    mkdirSync(outDir, { recursive: true })

    const card = typeof body === 'string' && body !== '' ? body : ticket.task
    const task = preamble(workspace, outDir) + card
    writeFileSync(join(outDir, 'task.txt'), task)

    const args = ['headless']
    if (patchFile !== '') args.push('--patch', patchFile)
    args.push('-')

    return new Promise((resolve, reject) => {
      const invocation = resolveInvocation(dshBin, args)
      if (invocation === null) {
        reject(
          new Error(
            `无法启动 worker（${dshBin}）：在 PATH 上找不到可执行文件（Windows 需要 .exe/.cmd），可在插件配置里把 dshBin 指向 dsh.cmd 的绝对路径`,
          ),
        )
        return
      }

      let child
      try {
        child = spawn(invocation.file, invocation.args, {
          cwd: stateDir,
          env: { ...credentialsEnv(options.dshHome), ...process.env, ...options.env },
          stdio: ['pipe', 'pipe', 'pipe'],
          ...(invocation.verbatim ? { windowsVerbatimArguments: true } : {}),
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

      // A timed-out worker is reported as 124 whatever the platform says about
      // how it died: Windows force-kills the tree and reports no signal.
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        terminate(child)
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
        const exitCode = timedOut ? 124 : Number.isInteger(code) ? code : signal ? 124 : 1
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
