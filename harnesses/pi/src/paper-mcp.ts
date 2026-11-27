import { existsSync } from 'node:fs'
import { createMcpExtension, type ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { effectiveExecution, type ExecutionPolicy } from './worker-execution.ts'

const paperCommand =
  '/Applications/Paper.app/Contents/Resources/app.asar.unpacked/dist/cli-bin/darwin-arm64/paper'

export type PaperServers = { paper?: { command: string; args: string[] } }

export async function paperServers(
  project: { root: string; execution?: ExecutionPolicy },
  installed = existsSync(paperCommand),
): Promise<PaperServers> {
  if (!installed || (await effectiveExecution(project)).mode === 'required-isolation') {
    return {}
  }

  return { paper: { command: paperCommand, args: ['mcp'] } }
}

/** Only the registered server: do not read home or project mcp.json. */
const nativeMcp = createMcpExtension({ loadConfig: () => ({ servers: [], errors: [] }) })

export default function registerHostPaper(pi: ExtensionAPI) {
  if (!existsSync(paperCommand) || process.argv.includes('--no-mcp')) {
    return
  }

  pi.on('session_start', async (_event, ctx) => {
    const servers = await paperServers({ root: ctx.cwd })

    if (servers.paper) {
      pi.registerMcpServer('paper', { ...servers.paper, exposure: 'direct' })
    } else {
      pi.unregisterMcpServer('paper')
    }
  })
  return nativeMcp(pi)
}

export function registerPaper(pi: ExtensionAPI, servers: PaperServers) {
  if (servers.paper) {
    pi.registerMcpServer('paper', { ...servers.paper, exposure: 'direct' })
    return nativeMcp(pi)
  }
}
