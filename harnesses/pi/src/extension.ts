import { realpath } from 'node:fs/promises'
import { Type } from 'typebox'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { designSchema, validateDesign } from './contracts.ts'
import { fileTools, textResult } from './file-tools.ts'
import { StateStore } from './state.ts'
import { loadRole, rolePrompt } from './roles.ts'
import { checkpointText, projectContext, taskView } from './context.ts'
import { instructions } from './project.ts'
import { registerWorkshop } from './workshop.ts'
import { registerTraces } from './traces.ts'
import { registerWorkshopContext } from './workshop-context.ts'
import { registerDocumentTools } from './document-tools.ts'
import { registerTiming } from './timing.ts'
import { registerDelegation } from './delegation-tools.ts'
import { Delegations, activeTask, delegationView } from './delegation-state.ts'
import { runtimeVersion } from './runtime-version.ts'
import { registerBranchTools } from './branch-tools.ts'
import { capabilities } from './capabilities.ts'
import { registerWorkers } from './workers-command.ts'

// A running generation keeps matching code, prompts and tool policy until a real reload.
const orchestratorPolicy = Promise.all([loadRole('orchestrator'), rolePrompt('orchestrator')])

export default function harness(pi: ExtensionAPI): void {
  registerWorkers(pi)
  const workshop = registerWorkshop(pi)
  registerWorkshopContext(pi)
  registerDocumentTools(pi)
  const runtime = runtimeVersion(pi)
  registerTiming(pi, runtime.current)
  const delegation = registerDelegation(pi)
  registerBranchTools(pi)
  const storeFor = async (cwd: string) => new StateStore(await realpath(cwd))

  pi.on('session_start', async (event, ctx) => {
    pi.setActiveTools((await orchestratorPolicy)[0].tools)
    await runtime.record(ctx, event.reason)
  })
  registerTraces(pi)

  pi.registerTool({
    name: 'harness_capabilities',
    label: 'Inspect host and worker capabilities',
    description: 'Choose host execution or delegation using actual capabilities and task context.',
    parameters: Type.Object({}),
    async execute() {
      return textResult(capabilities)
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
        await instructions(ctx.cwd, []),
        checkpoint
          ? checkpointText(checkpoint, await store.task())
          : 'No implementation checkpoint. Workshop, shell and file tools are available.',
      ].join('\n\n'),
    }
  })

  pi.on('context', async (event, ctx) => {
    const store = await storeFor(ctx.cwd)
    const checkpoint = await store.checkpoint()
    const messages = projectContext(event.messages, checkpoint)
    const compacted = ctx.sessionManager
      .getBranch()
      .findLast(
        (entry) =>
          entry.type === 'compaction' &&
          entry.details &&
          (entry.details as { piCheckpointHash?: string }).piCheckpointHash === checkpoint?.hash &&
          (entry.details as { piCheckpointVersion?: number }).piCheckpointVersion ===
            checkpoint?.version,
      )

    if (checkpoint && compacted?.type === 'compaction') {
      const details = compacted.details as { requests?: unknown[] }
      messages.unshift({
        role: 'user',
        timestamp: Date.parse(checkpoint.acceptedAt),
        content: 'Retained user requests: ' + JSON.stringify(details.requests),
      })
    }

    return { messages }
  })

  pi.on('tool_call', async (event) => {
    if (!(await orchestratorPolicy)[0].tools.includes(event.toolName)) {
      return { block: true, reason: 'This tool is not enabled in the orchestrator role.' }
    }

    return undefined
  })

  pi.on('session_before_tree', async (_event, ctx) => {
    const store = await storeFor(ctx.cwd)
    const checkpoint = await store.checkpoint()
    return checkpoint
      ? { summary: { summary: checkpointText(checkpoint, await store.task()) } }
      : undefined
  })

  pi.on('session_before_compact', async (event, ctx) => {
    const store = await storeFor(ctx.cwd)
    const checkpoint = await store.checkpoint()

    if (!checkpoint) {
      return undefined
    }

    // Keep every current-design user request verbatim. Never summarize discarded exploration.
    const users = event.branchEntries.filter(
      (entry) =>
        entry.type === 'message' &&
        entry.message.role === 'user' &&
        entry.message.timestamp >= Date.parse(checkpoint.acceptedAt),
    )
    const requests = users.map((entry) => (entry.type === 'message' ? entry.message : null))
    const text = JSON.stringify({
      checkpoint: checkpointText(checkpoint, await store.task()),
      requests,
    })

    if (text.length > 48000) {
      ctx.ui.notify(
        'Accept an updated design before compacting; current requests exceed 48 KB.',
        'warning',
      )
      return { cancel: true }
    }

    return {
      compaction: {
        summary: text,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        details: {
          piCheckpointHash: checkpoint.hash,
          piCheckpointVersion: checkpoint.version,
          requests,
        },
      },
    }
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
    name: 'propose_design',
    label: 'Propose design',
    description:
      'Prepare a settled implementation scope for /accept-design HASH. ' +
      'Use delegate_task for delegated workshop documents; small quick edits may stay local.',
    parameters: designSchema,
    async execute(_id, args, _signal, _update, ctx) {
      const hash = await (await storeFor(ctx.cwd)).draft(validateDesign(args))
      return textResult({ hash, next: `/accept-design ${hash.slice(0, 12)}`, accepted: false })
    },
  })

  pi.registerCommand('accept-design', {
    description: 'Accept the proposed design and start a clean design context',
    async handler(args, ctx) {
      if (!ctx.isIdle() || ctx.hasPendingMessages()) {
        ctx.ui.notify(
          'Finish the active turn and queued messages before accepting a design.',
          'warning',
        )
        return
      }

      const expectedHash = args.trim().toLowerCase()

      if (!/^[a-f0-9]{12,64}$/.test(expectedHash)) {
        ctx.ui.notify(
          'Use /accept-design followed by at least 12 characters of the proposal hash.',
          'warning',
        )
        return
      }

      const store = await storeFor(ctx.cwd)

      if ((await new Delegations(store).list()).some((job) => activeTask(job.state))) {
        ctx.ui.notify(
          'Finish or cancel background tasks before replacing the design context.',
          'warning',
        )
        return
      }

      const release = await store.lock()

      try {
        release.assertHeld()
        await workshop.cancel(ctx)
        const checkpoint = await store.accept(expectedHash)
        const result = await ctx.newSession({
          parentSession: ctx.sessionManager.getSessionFile(),
          setup: async (manager) => {
            manager.appendMessage({
              role: 'user',
              content: checkpointText(checkpoint, await store.task()),
              timestamp: Date.now(),
            })
          },
          withSession: async (current) => {
            current.ui.notify(
              `Accepted design ${checkpoint.hash.slice(0, 12)}. Ready to implement.`,
              'info',
            )
          },
        })

        if (result.cancelled) {
          ctx.ui.notify('Design accepted; context projection is active in this session.', 'info')
        }
      } finally {
        await release()
      }
    },
  })

  pi.registerTool({
    name: 'workflow',
    label: 'Run delegated workflow',
    description:
      'Start accepted implementation, checks and reviews in the background. ' +
      'Returns immediately; continue discussing other work while it runs.',
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      return delegation.start(ctx, {
        kind: 'implementation',
        task: 'Implement the accepted design with its required checks and specialist reviews.',
        context: '',
        writePaths: [],
      })
    },
  })

  pi.registerTool({
    name: 'harness_status',
    label: 'Harness status',
    description: 'Read accepted design, workflow state and evidence.',
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, _update, ctx) {
      const store = await storeFor(ctx.cwd)
      const checkpoint = await store.checkpoint()
      const task = await store.task()
      return textResult({
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
