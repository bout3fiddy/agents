import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { registerActivityCaption } from './activity-caption.ts'
import { registerAutoReload } from './auto-reload.ts'
import { registerDocumentTools } from './document-tools.ts'
import { fileTools } from './file-tools.ts'
import { registerGitHubRunWatch } from './github-run-watch.ts'
import { registerHandoffs, type HandoffOptions } from './handoff-tools.ts'
import { directOnly, registerInspectionMode } from './inspection-mode.ts'
import { inspectionTools } from './inspection.ts'
import { registerJobs, type JobOptions } from './job-tools.ts'
import { registerLauncherRecovery } from './launcher-recovery.ts'
import { instructions } from './project.ts'
import { loadRole, rolePrompt } from './roles.ts'
import { runtimeVersion } from './runtime-version.ts'
import { registerShellActivity } from './shell-render.ts'
import registerSteering from './steering.ts'
import { furnishTigerStyle } from './tiger-style.ts'
import { registerTiming } from './timing.ts'
import { registerTraces } from './traces.ts'
import { registerWhiteboard } from './whiteboard.ts'
import { registerWorkers } from './workers-command.ts'
import { registerWorkshopContext } from './workshop-context.ts'
import { registerWorkshop } from './workshop.ts'

// A running generation keeps matching code, prompts and tool policy until a real reload.
const orchestratorPolicy = Promise.all([loadRole('orchestrator'), rolePrompt('orchestrator')])

/** The harness extension. Tests supply their own job launcher; the installed one runs for real. */
type HarnessOptions = { jobs?: JobOptions; handoffs?: HandoffOptions }

export function createHarness(options: HarnessOptions = {}) {
  return (pi: ExtensionAPI) => register(pi, options)
}

export default createHarness()

function register(pi: ExtensionAPI, options: HarnessOptions): void {
  const activePaperTools = () =>
    pi.getActiveTools().filter((name) => name.startsWith('mcp__paper__'))

  // Everything the role may call is scriptable, except the shell and direct file writes. The
  // set fills when the role has loaded, which is before the first model request.
  const scriptable = new Set<string>()
  void orchestratorPolicy.then(([role]) => {
    for (const name of role.tools.filter((tool) => !directOnly.has(tool))) {
      scriptable.add(name)
    }
  })
  registerInspectionMode(pi, scriptable, 'Script over the harness tools.')
  inspectionTools(pi)
  const workerWindow = { open: false }
  registerWorkers(pi, workerWindow)
  registerGitHubRunWatch(pi)
  registerWhiteboard(pi)
  registerHandoffs(pi, options.handoffs)
  const { consultations } = registerWorkshop(pi)
  registerWorkshopContext(pi)
  registerDocumentTools(pi)
  const runtime = runtimeVersion(pi)
  registerTiming(pi, runtime.current)
  registerJobs(pi, options.jobs)
  registerShellActivity(pi)
  registerActivityCaption(pi)
  const canLeaveSession = registerSteering(pi)

  // Another extension may quit during session_start, before this receipt is recorded.
  let loading: Promise<void> = Promise.resolve()
  pi.on('session_start', (event, ctx) => {
    loading = (async () => {
      await furnishTigerStyle(ctx.cwd)
      const [role] = await orchestratorPolicy
      pi.setActiveTools([...role.tools, ...activePaperTools()])
      await runtime.record(ctx, event.reason, role.tools)
    })()
    return loading
  })
  const settled = () => loading.then(runtime.current, runtime.current)

  // The trace mirror runs after the load receipt above has been appended to the session.
  const busy = () => workerWindow.open || consultations.busy
  registerLauncherRecovery(pi, settled, () => busy() || !canLeaveSession())
  registerAutoReload(pi, runtime.current, busy)
  registerTraces(pi)

  pi.registerCommand('harness-version', {
    description: 'Show the loaded harness build and reload receipt',
    async handler(_args, ctx) {
      ctx.ui.notify(JSON.stringify(runtime.current(), null, 2), 'info')
    },
  })

  pi.on('before_agent_start', async (_event, ctx) => {
    const [role, prompt] = await orchestratorPolicy
    pi.setActiveTools([...role.tools, ...activePaperTools()])
    return {
      systemPrompt: [
        prompt,
        await furnishTigerStyle(ctx.cwd),
        runtime.current()?.toolWarning,
        await instructions(ctx.cwd, []),
      ].join('\n\n'),
    }
  })

  pi.on('tool_call', async (event) => {
    const [role] = await orchestratorPolicy

    if (!role.tools.includes(event.toolName) && !activePaperTools().includes(event.toolName)) {
      return { block: true, reason: 'This tool is not enabled in the orchestrator role.' }
    }

    return undefined
  })

  for (const name of ['project_read', 'project_search']) {
    const template = fileTools(process.cwd()).find((tool) => tool.name === name)!
    pi.registerTool({
      ...template,
      async execute(id, args, signal, update, ctx) {
        return fileTools(ctx.cwd)
          .find((tool) => tool.name === name)!
          .execute(id, args, signal, update, ctx)
      },
    })
  }
}
