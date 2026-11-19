import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import { Check } from 'typebox/value'
import { Type } from 'typebox'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { fanoutSchema, type FanoutInput } from './branch-contracts.ts'
import { gitCommand, resolveRemote } from './git-branches.ts'
import { digest, readBoundedFile, relativePath, safePath, validateWriteScope } from './paths.ts'
import { validateDesign } from './contracts.ts'
import { StateStore } from './state.ts'
import { Delegations, delegationView, scopesOverlap } from './delegation-state.ts'
import { launchDelegation } from './delegation-process.ts'
import { textResult } from './file-tools.ts'
import { loadProject } from './project.ts'
import { pinnedDesignInstruction, requireBranchChecks } from './branch-contracts.ts'

export async function startBranchBatch(
  ctx: ExtensionContext,
  input: FanoutInput,
  signal?: AbortSignal,
  launch = launchDelegation,
) {
  if (!Check(fanoutSchema, input) || !ctx.model) {
    throw new Error('Provide a design document, scoped branch tasks and a selected model')
  }

  relativePath(input.designPath)

  if (!['.md', '.txt', '.rst'].includes(extname(input.designPath))) {
    throw new Error('The branch design must be a committed Markdown or text document')
  }

  for (const [index, task] of input.tasks.entries()) {
    validateWriteScope(task.writePaths)

    if (
      input.tasks.slice(0, index).some((prior) => scopesOverlap(prior.writePaths, task.writePaths))
    ) {
      throw new Error('Independent branch tasks require disjoint write scopes')
    }
  }

  const store = new StateStore(ctx.cwd)
  const repository = await resolveRemote(
    store.projectRoot,
    { remote: input.remote ?? 'origin', target: 'main' },
    signal,
  )
  const documentEntry = await gitCommand(
    store.projectRoot,
    ['ls-tree', repository.base, '--', input.designPath],
    signal,
  )

  if (!/^100(?:644|755) blob [a-f0-9]+\t/.test(documentEntry)) {
    throw new Error('Commit and push the settled design document to main before branch fanout')
  }

  const document = await gitCommand(
    store.projectRoot,
    ['show', `${repository.base}:${input.designPath}`],
    signal,
  )
  const local = (await readBoundedFile(await safePath(store.projectRoot, input.designPath)))
    .toString('utf8')
    .trimEnd()

  if (!document.trim() || document !== local) {
    throw new Error('Use a settled design that matches the document on remote main')
  }

  const project = await loadProject(store.projectRoot, async <T>(path: string) => {
    const entry = await gitCommand(
      store.projectRoot,
      ['ls-tree', repository.base, '--', path],
      signal,
    )

    if (!entry) {
      return undefined
    }

    if (!/^100(?:644|755) blob [a-f0-9]+\t/.test(entry)) {
      throw new Error(`Check configuration must be a committed regular file: ${path}`)
    }

    const raw = await gitCommand(store.projectRoot, ['show', `${repository.base}:${path}`], signal)
    return JSON.parse(raw) as T
  })

  for (const task of input.tasks) {
    requireBranchChecks(project, task)
  }

  const designHash = digest(document)
  const design =
    document.length <= 16000 ? document : pinnedDesignInstruction(input.designPath, designHash)
  const batch = randomUUID()
  const tasks = input.tasks.map(({ task, thinking, implementerModel, ...scope }) => ({
    task,
    thinking,
    implementerModel,
    context: `Execute the authorized design in ${input.designPath} autonomously.\n${design}`,
    writePaths: scope.writePaths,
    branch: {
      batch,
      remote: repository.remote,
      target: 'main' as const,
      remoteUrl: repository.remoteUrl,
      base: repository.base,
      designPath: input.designPath,
      designHash,
      mergeToMain: input.mergeToMain === true,
      design: validateDesign({
        ...scope,
        objective: task,
        design,
        unresolved: [],
      }),
    },
  }))
  const jobs = await new Delegations(store).startBranches(
    tasks,
    {
      session: ctx.sessionManager.getSessionId(),
      originEntry: ctx.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === 'message' && entry.message.role === 'user')?.id,
      model: `${ctx.model.provider}/${ctx.model.id}`,
    },
    launch,
  )
  return {
    batch,
    base: repository.base,
    tasks: jobs.map(delegationView),
    next:
      'Continue discussion. Independent orchestrators handle implementation, tests, reviews, ' +
      'branch publication and any explicitly authorized merge. Outcomes arrive automatically.',
  }
}

export function registerBranchTools(pi: ExtensionAPI, launch = launchDelegation): void {
  pi.registerTool({
    name: 'delegate_branches',
    label: 'Fan out independent branch orchestrators',
    description:
      'Execute independent tasks from a settled design document on remote main. ' +
      'Each task gets an autonomous orchestrator, worktree and remote branch, with required ' +
      'reviews/tests. Set mergeToMain true only when the user explicitly requested merging. ' +
      'Otherwise publish for later merge_branches. Returns immediately; no acceptance command ' +
      'or routine human approval is needed. Supply disjoint scopes and complete design decisions.',
    parameters: fanoutSchema,
    async execute(_id, input, signal, _update, ctx) {
      return textResult(await startBranchBatch(ctx, input, signal, launch))
    },
  })
  pi.registerTool({
    name: 'merge_branches',
    label: 'Merge authorized branch tasks',
    description:
      'Use only when the user explicitly asks to merge these tasks to main. ' +
      'Triage external agent reviews for up to five rounds and refresh tests/reviews, ' +
      'and merge serially in the background. Published tasks resume in their existing worktrees.',
    parameters: Type.Object({
      ids: Type.Array(Type.String({ minLength: 36, maxLength: 36 }), { minItems: 1, maxItems: 4 }),
    }),
    async execute(_id, input, _signal, _update, ctx) {
      if (!ctx.model) {
        throw new Error('Select a model first')
      }

      const jobs = await new Delegations(new StateStore(ctx.cwd)).requestMerge(
        input.ids,
        {
          session: ctx.sessionManager.getSessionId(),
          originEntry: ctx.sessionManager
            .getBranch()
            .findLast((entry) => entry.type === 'message' && entry.message.role === 'user')?.id,
          model: `${ctx.model.provider}/${ctx.model.id}`,
        },
        launch,
      )
      return textResult({
        mergeAuthorized: true,
        tasks: jobs.map(delegationView),
        next: 'Continue discussion. Review and merge outcomes arrive automatically.',
      })
    },
  })
}
