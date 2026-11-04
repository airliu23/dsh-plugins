/**
 * The fake `dsh` both wiring tests start: the same program written twice,
 * because Windows cannot exec a POSIX script and cannot exec a `.cmd` shim
 * directly either — the runner resolves it through `cmd.exe`, exactly as it
 * does for npm's real `dsh.cmd`.
 */
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const WINDOWS = process.platform === 'win32'

/**
 * @param {string} dir Directory the fixture lives in.
 * @param {string} name Base name, e.g. `fake-dsh`.
 * @param {{ node: string, sh: string }} body Program bodies doing the same work:
 *   the node one reads stdin asynchronously, the sh one gets it already piped.
 * @returns {string} Path to pass as `dshBin`.
 */
export function writeFakeDsh(dir, name, body) {
  if (!WINDOWS) {
    const path = join(dir, name)
    writeFileSync(path, body.sh)
    chmodSync(path, 0o755)
    return path
  }
  const script = join(dir, `${name}.mjs`)
  writeFileSync(
    script,
    [
      'const chunks = []',
      'for await (const chunk of process.stdin) chunks.push(chunk)',
      "const task = Buffer.concat(chunks).toString('utf8')",
      'const lines = task.split(String.fromCharCode(10)).filter((line) => line.trim() !== \'\')',
      'const last = lines.at(-1) ?? \'\'',
      body.node,
      '',
    ].join('\n'),
  )
  const path = join(dir, `${name}.cmd`)
  writeFileSync(path, `@echo off\r\n"${process.execPath}" "%~dp0${name}.mjs" %*\r\n`)
  return path
}
