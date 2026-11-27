import { readFileSync, readdirSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { harnessRoot } from './project.ts'
import { readJson, StateStore } from './state.ts'
import {
  capturePiHost,
  installPath,
  needsRestart,
  piPackage,
  restartCommand,
  type PiInstall,
} from './pi-host.ts'

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

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  const version = pkg.version as string
  const piPin = pkg.dependencies?.[piPackage] as string | undefined
  return Object.freeze({ version, revision, sourceHash: hash.digest('hex'), source: root, piPin })
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
  piHost: ReturnType<typeof capturePiHost>
  expectedPi?: PiInstall['pi']
  install?: Pick<PiInstall, 'installedAt' | 'source' | 'wrapper'>
  launcherWarning?: string
  toolWarning?: string
  registeredTools: string[]
}

export async function readInstall() {
  const install = await readJson<PiInstall>(installPath())

  if (
    install &&
    !(
      typeof install.wrapper === 'string' &&
      isAbsolute(install.wrapper) &&
      typeof install.source === 'string' &&
      isAbsolute(install.source) &&
      typeof install.sourceHash === 'string' &&
      typeof install.installedAt === 'string' &&
      (!install.pi ||
        (typeof install.pi.version === 'string' &&
          typeof install.pi.entry === 'string' &&
          isAbsolute(install.pi.entry)))
    )
  ) {
    throw new Error('Invalid harness install receipt')
  }

  return install
}

async function launcherReceipt(ctx: ExtensionContext, reason: string) {
  const piHost = capturePiHost(undefined, reason !== 'reload')
  let install: PiInstall | undefined
  let launcherWarning: string | undefined

  try {
    install = await readInstall()
  } catch {

    // Still record the observed host if the install receipt is invalid or unreadable.
    launcherWarning = 'Cannot verify the installed launcher. Check the local install with sync-pi.'
  }

  if (!install && !launcherWarning && (piHost.version || piHost.wrapper)) {
    launcherWarning =
      'No completed harness install receipt. Run ./bin/sync-pi.sh from the ' +
      'intended checkout, then restart through its installed wrapper.'
  }

  const expectedPi = install?.pi
  const restart = install && restartCommand(install.wrapper, ctx.sessionManager)

  if (install && needsRestart(build.source, piHost, install)) {
    launcherWarning =
      `Not running the installed harness launcher/release. ` +
      `Pi ${piHost.version ?? 'unknown'} at ${piHost.entry}; ` +
      `expected Pi ${expectedPi?.version ?? 'unrecorded'} from ${install.source}. ` +
      'If the pin changed, sync the intended checkout first. Exit and run from this project: ' +
      restart
  }

  const target = install && {
    source: install.source,
    wrapper: install.wrapper,
    installedAt: install.installedAt,
  }
  return { restart, receipt: { piHost, expectedPi, install: target, launcherWarning } }
}

export function runtimeVersion(pi: ExtensionAPI) {
  let loaded: LoadedRuntime | undefined
  return {
    current: () => loaded,
    async record(ctx: ExtensionContext, reason: string, expected: string[]) {
      const activeTools = pi.getActiveTools().sort()
      const missing = expected.filter((name) => !activeTools.includes(name))
      const { restart, receipt } = await launcherReceipt(ctx, reason)
      const toolWarning = missing.length
        ? 'Missing role tools: ' +
          missing.join(', ') +
          (restart
            ? `. Exit and run: ${restart}`
            : '. Restart with the installed harness launcher.')
        : undefined
      loaded = {
        ...build,
        ...receipt,
        loadId: randomUUID(),
        loadedAt: new Date().toISOString(),
        reason,
        session: ctx.sessionManager.getSessionId(),
        pid: process.pid,
        activeTools,
        ...(toolWarning && { toolWarning }),
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

      if (loaded.launcherWarning) {
        ctx.ui.notify(loaded.launcherWarning, 'warning')
      }

      if (toolWarning) {
        ctx.ui.notify(toolWarning, 'warning')
      }

      ctx.ui.setStatus(
        'pi-harness',
        `Pi harness ${loaded.version} · ${loaded.sourceHash.slice(0, 10)} · orchestrator` +
          (loaded.launcherWarning ? ' · check launcher' : ''),
      )
      return loaded
    },
  }
}
