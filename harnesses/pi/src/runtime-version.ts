import { readFileSync, readdirSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { harnessRoot } from './project.ts'
import { StateStore } from './state.ts'

export function captureBuild(root: string) {
  const files = ['package.json', 'package-lock.json']

  for (const folder of ['src', 'roles', 'prompts']) {
    for (const name of readdirSync(join(root, folder), { recursive: true, withFileTypes: true })) {
      if (name.isFile()) {
        files.push(relative(root, join(name.parentPath, name.name)))
      }
    }
  }

  const hash = createHash('sha256')

  for (const file of files.sort()) {
    hash
      .update(file)
      .update('\0')
      .update(readFileSync(join(root, file)))
      .update('\0')
  }

  let revision = 'unavailable'

  try {
    revision = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    // Installed source can exist without Git metadata; the content digest remains authoritative.
  }

  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string
  return Object.freeze({ version, revision, sourceHash: hash.digest('hex'), source: root })
}

// Capture once when the module is evaluated. A later disk update must not relabel loaded code.
const build = captureBuild(harnessRoot)
export type LoadedRuntime = typeof build & {
  loadId: string
  loadedAt: string
  reason: string
  session: string
  pid: number
  activeTools: string[]
  registeredTools: string[]
}

export function runtimeVersion(pi: ExtensionAPI) {
  let loaded: LoadedRuntime | undefined
  return {
    current: () => loaded,
    async record(ctx: ExtensionContext, reason: string) {
      loaded = {
        ...build,
        loadId: randomUUID(),
        loadedAt: new Date().toISOString(),
        reason,
        session: ctx.sessionManager.getSessionId(),
        pid: process.pid,
        activeTools: pi.getActiveTools().sort(),
        registeredTools: pi
          .getAllTools()
          .map((tool) => tool.name)
          .sort(),
      }
      const directory = join(new StateStore(ctx.cwd).directory, 'runtime')
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await appendFile(join(directory, `${loaded.session}.jsonl`), JSON.stringify(loaded) + '\n', {
        mode: 0o600,
      })
      pi.appendEntry('pi-harness-load', loaded)
      ctx.ui.setStatus(
        'pi-harness',
        `Pi harness ${loaded.version} · ${loaded.sourceHash.slice(0, 10)} · orchestrator`,
      )
      return loaded
    },
  }
}
