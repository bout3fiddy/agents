import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// macOS limits a Unix socket path to 104 bytes, and test suites bind sockets below TMPDIR. Keep
// harness directories one level below the system temporary directory with short names.
const processName = /^pi-(\d+)[a-z]-[A-Za-z0-9_]{6}$/

export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Disposable directories carry the creating process ID and are swept after it exits. The kind is
 * one letter: workspace copy, command scratch or lint baseline. */
export async function temporaryDirectory(kind: 'w' | 'c' | 'l'): Promise<string> {
  return mkdtemp(join(tmpdir(), `pi-${process.pid}${kind}-`))
}

/**
 * Remove the temporary directories of processes that have exited. Nothing durable lives in
 * them: a job's work is a commit, so a copy never has to outlive the process that made it.
 */
export async function sweepTemporary(dryRun = false): Promise<{ removed: string[]; kept: number }> {
  const report = { removed: [] as string[], kept: 0 }

  for (const name of await readdir(tmpdir()).catch(() => [] as string[])) {
    const pid = processName.exec(name)?.[1]

    if (!pid) {
      continue
    }

    if (Number(pid) === process.pid || processAlive(Number(pid))) {
      report.kept++
      continue
    }

    report.removed.push(join(tmpdir(), name))

    if (!dryRun) {
      await rm(join(tmpdir(), name), { recursive: true, force: true })
    }
  }

  return report
}
