import { capabilitySchema, harnessStatusSchema } from './inspection-schema.ts'
import { registerInspectionMode } from './inspection-mode.ts'
import { inspectionTools, nestedInspectionTools } from './inspection.ts'
import { furnishTigerStyle } from './tiger-style.ts'
import { realpath } from 'node:fs/promises'
import { Type } from 'typebox'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  designSchema,
  implementerModelSchema,
  thinkingSchema,
  workflowSpecialistsSchema,
} from './contracts.ts'
import { fileTools, structuredResult } from './file-tools.ts'
import { StateStore } from './state.ts'
import { loadRole, rolePrompt } from './roles.ts'
import { checkpointText, taskView } from './context.ts'
import { instructions } from './project.ts'
import { registerWorkshop } from './workshop.ts'
import { registerTraces } from './traces.ts'
import { registerWorkshopContext } from './workshop-context.ts'
import { registerDocumentTools } from './document-tools.ts'
import { registerTiming } from './timing.ts'
import { registerDelegation } from './delegation-tools.ts'
import { Delegations, delegationView } from './delegation-state.ts'
import { registerMainSync } from './main-sync.ts'
import { registerCleanup } from './cleanup.ts'
import { registerAutoReload } from './auto-reload.ts'
import { runtimeVersion } from './runtime-version.ts'
import { registerLocalTools } from './local-tools.ts'
import { registerBranchTools } from './branch-tools.ts'
import { capabilities } from './capabilities.ts'
import { registerRecurring } from './recurring-tools.ts'
import { registerHostWork } from './host-work.ts'
import { registerShellActivity } from './shell-render.ts'
import { registerGitHubRunWatch } from './github-run-watch.ts'
import { registerWhiteboard } from './whiteboard.ts'
import { registerWorkers } from './workers-command.ts'

// A running generation keeps matching code, prompts and tool policy until a real reload.
const orchestratorPolicy = Promise.all([loadRole('orchestrator'), rolePrompt('orchestrator')])

export default function harness(pi: ExtensionAPI): void {
  registerInspectionMode(pi, nestedInspectionTools)
  inspectionTools(pi)
  const workerWindow = { open: false }
  registerWorkers(pi, workerWindow)
  registerRecurring(pi)
  registerGitHubRunWatch(pi)
  registerWhiteboard(pi)
  const { consultations } = registerWorkshop(pi)
  registerWorkshopContext(pi)
  registerDocumentTools(pi)
  const runtime = runtimeVersion(pi)
  registerTiming(pi, runtime.current)
  const afterMerge = registerMainSync(pi)
  registerCleanup(pi)
  const delegation = registerDelegation(pi, undefined, afterMerge)
  registerHostWork(pi)
  registerShellActivity(pi)
  registerBranchTools(pi)
  registerLocalTools(pi)
  const storeFor = async (cwd: string) => new StateStore(await realpath(cwd))

  pi.on('session_start', async (event, ctx) => {
    await furnishTigerStyle(ctx.cwd)
    const [role] = await orchestratorPolicy
    pi.setActiveTools(role.tools)
    await runtime.record(ctx, event.reason, role.tools)
  })
  registerAutoReload(pi, runtime.current, () => workerWindow.open || consultations.busy)
  registerTraces(pi)

  pi.registerTool({
    name: 'harness_capabilities',
    outputSchema: capabilitySchema,
    label: 'Inspect host and worker capabilities',
    description: 'Choose host execution or delegation using actual capabilities and task context.',
    parameters: Type.Object({}),
    async execute() {
      return structuredResult(capabilities)
    },
  })

  pi.registerCommand('harness-version', {
    description: 'Show the loaded harness build and reload receipt',
    async handler(_args, ctx) {
      ctx.ui.notify(JSON.stringify(runtime.current(), null, 2), 'info')
    },
  })

  pi.on('before_agent_start', async (_event, ctx) => {
    const store = await storeFor(ctx.cwd)
    const checkpoint = await store.checkpoint()
    const [role, prompt] = await orchestratorPolicy
    pi.setActiveTools(role.tools)
    return {
      systemPrompt: [
        prompt,
        await furnishTigerStyle(ctx.cwd),
        runtime.current()?.toolWarning,
        await instructions(ctx.cwd, []),
        checkpoint
          ? checkpointText(checkpoint, await store.task())
          : 'No implementation checkpoint. Workshop, shell and file tools are available.',
      ].join('\n\n'),
    }
  })

  pi.on('tool_call', async (event) => {
    if (!(await orchestratorPolicy)[0].tools.includes(event.toolName)) {
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

  pi.registerTool({
    name: 'workflow',
    label: 'Run delegated workflow',
    description:
      'Start user-requested implementation and verification in the background. ' +
      'Supply the settled design for new work; omit it only to resume the recorded scope. ' +
      'Returns immediately and preserves this conversation.',
    parameters: Type.Object({
      design: Type.Optional(designSchema),
      thinking: Type.Optional(thinkingSchema),
      implementerModel: Type.Optional(implementerModelSchema),
      specialistThinking: Type.Optional(workflowSpecialistsSchema),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      return delegation.start(ctx, {
        kind: 'implementation',
        task: 'Implement the settled design and verify it with the required checks.',
        implementerModel: args.implementerModel,
        ...(args.design ? { design: args.design } : {}),
        ...(args.thinking ? { thinking: args.thinking } : {}),
        ...(args.specialistThinking ? { specialistThinking: args.specialistThinking } : {}),
        context: '',
        writePaths: [],
      })
    },
  })

  pi.registerTool({
    name: 'harness_status',
    outputSchema: harnessStatusSchema,
    label: 'Harness status',
    description: 'Read recorded implementation scope, workflow state and evidence.',
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      const store = await storeFor(ctx.cwd)
      const checkpoint = await store.checkpoint()
      const task = await store.task()
      return structuredResult({
        runtime: runtime.current(),
        capabilities,
        delegations: (await new Delegations(store).list()).map(delegationView),
        checkpoint,
        task:
          task?.designHash === checkpoint?.hash &&
          (task?.designVersion === undefined || task.designVersion === checkpoint?.version)
            ? task && taskView(task)
            : undefined,
        artifacts: store.directory,
      })
    },
  })
}
