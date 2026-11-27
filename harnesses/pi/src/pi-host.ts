import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

export const piPackage = '@earendil-works/pi-coding-agent'

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function installPath(): string {
  const agent =
    process.env.PI_CODING_AGENT_DIR ??
    process.env.PI_HARNESS_AGENT_DIR ??
    join(homedir(), '.pi', 'agent')
  return join(agent, 'harness-install.json')
}

export type ExpectedPi = { version: string; entry: string }
export type PiInstall = {
  wrapper: string
  source: string
  sourceHash: string
  installedAt: string
  pi?: ExpectedPi
}

type Host = {
  executable: string
  entry: string
  version?: string
  wrapper?: string
  launcherSource?: string
}
const hostProcess = process as NodeJS.Process & { piHarnessCli?: Readonly<Host> }

function entryVersion(entry: string): string | undefined {

  // Pi's Node CLI lives in dist/ or dist/bundle/. Also recognize a package's declared bin.pi.
  let dir = dirname(entry)

  for (let depth = 0; depth < 3; depth++, dir = dirname(dir)) {
    const manifest = join(dir, 'package.json')

    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      const nameMatches = pkg.name === piPackage || pkg.name === '@mariozechner/pi-coding-agent'
      const entryMatches =
        relative(dir, entry) === 'dist/cli.js' ||
        (typeof pkg.bin?.pi === 'string' && join(dir, pkg.bin.pi) === entry)

      if (nameMatches && entryMatches && typeof pkg.version === 'string') {
        return pkg.version
      }
    }
  }

  return undefined
}

// Observe the CLI, not the extension's import resolution. An SDK embedder or a standalone
// executable need not have an identifiable Pi package. Never label either with the SDK version.
export function capturePiHost(wrapper?: string, firstLoad = true): Readonly<Host> {
  if (hostProcess.piHarnessCli) {
    return hostProcess.piHarnessCli
  }

  let entry = process.argv[1] ?? process.execPath
  let version: string | undefined

  try {
    entry = realpathSync(entry)
    version = firstLoad ? entryVersion(entry) : undefined
  } catch {
    // A missing/replaced entry or unreadable manifest is unverified, not the expected release.
  }

  // The wrapper can be repointed while the process is alive. Keep its launch source separately
  // from both the physical CLI entry (node_modules can be shared) and the latest extension load.
  const launcherSource = wrapper ? fileURLToPath(new URL('../', import.meta.url)) : undefined
  hostProcess.piHarnessCli = Object.freeze({
    executable: process.execPath,
    entry,
    version,
    wrapper,
    launcherSource,
  })
  return hostProcess.piHarnessCli
}

export function needsRestart(source: string, host: Host, install: PiInstall): boolean {
  return (
    source !== install.source ||
    host.wrapper !== install.wrapper ||
    host.launcherSource !== install.source ||
    Boolean(install.pi && (host.entry !== install.pi.entry || host.version !== install.pi.version))
  )
}
