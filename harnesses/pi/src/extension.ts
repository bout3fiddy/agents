import { realpath } from 'node:fs/promises'
import { Type } from 'typebox'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { designSchema, validateDesign } from './contracts.ts'
import { fileTools, textResult } from './file-tools.ts'
import { StateStore } from './state.ts'
import { runWorkflow } from './workflow.ts'
import { loadRole, rolePrompt } from './roles.ts'
import { checkpointText, projectContext, taskView } from './context.ts'
import { instructions } from './project.ts'
import { registerWorkshop } from './workshop.ts'
import { registerTraces } from './traces.ts'
import { registerWorkshopContext } from './workshop-context.ts'
import { registerDocumentTools } from './document-tools.ts'
import { registerTiming } from './timing.ts'

export default function harness(pi: ExtensionAPI): void {
  registerTraces(pi)
  const workshop = registerWorkshop(pi)
  registerWorkshopContext(pi)
  registerDocumentTools(pi)
  registerTiming(pi)
  const storeFor = async (cwd: string) => new StateStore(await realpath(cwd))

  pi.on('session_start', async (_event, ctx) => {
    pi.setActiveTools((await loadRole('orchestrator')).tools)
    ctx.ui.setStatus('pi-harness', 'Pi harness · orchestrator')
  })

  pi.on('before_agent_start', async (_event, ctx) => {
    const store = await storeFor(ctx.cwd)
    const checkpoint = await store.checkpoint()
    pi.setActiveTools((await loadRole('orchestrator')).tools)
    return {
      systemPrompt: [
        await rolePrompt('orchestrator'),
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
    if (!(await loadRole('orchestrator')).tools.includes(event.toolName)) {
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
      'Use normal file tools for workshop documents and routine edits.',
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
    description: 'Delegate implementation, checks and reviews. Allow several minutes.',
    parameters: Type.Object({}),
    async execute(_id, _args, signal, _update, ctx) {
      if (!ctx.model) {
        throw new Error('Select a model first')
      }

      const store = await storeFor(ctx.cwd)
      const task = await runWorkflow(store, `${ctx.model.provider}/${ctx.model.id}`, signal)
      return textResult({
        ...taskView(task),
        artifacts: store.directory,
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
