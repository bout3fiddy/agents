import { requireDependencies } from './dependencies.ts'
import { randomUUID } from 'node:crypto'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { Delegations, delegationView, scopesOverlap } from './delegation-state.ts'
import { launchDelegation } from './delegation-process.ts'
import { localBatchSchema, type LocalBatch, type LocalTaskInput } from './local-contracts.ts'
import { compareLocalCandidates, integrateLocalCandidate } from './local-selection.ts'
import { gitCommand } from './git-branches.ts'
import { validateWriteScope } from './paths.ts'
import { StateStore } from './state.ts'
import { loadPinnedProject } from './pinned-project.ts'
import { structuredResult, textResult } from './file-tools.ts'

export async function startLocalBatch(
  ctx: ExtensionContext,
  input: LocalBatch,
  signal?: AbortSignal,
  launch = launchDelegation,
) {
  if (!ctx.model || !Check(localBatchSchema, input)) {
    throw new Error('Provide a local objective, scoped tasks, an acceptance command and a model')
  }

  const mode = input.mode ?? 'independent'
  const competition = mode === 'competition'

  if (
    competition &&
    (input.tasks.length < 2 ||
      !input.acceptance?.workloadPaths?.length ||
      input.tasks.some((task) => task.acceptance))
  ) {
    throw new Error(
      'Competing candidates need two or more approaches and one shared pinned workload',
    )
  }

  if (competition && (!input.comparison?.difficulty.trim() || !input.comparison.criterion.trim())) {
    throw new Error(
      'Competition requires a difficult unresolved tradeoff and a selection criterion',
    )
  }

  if (!competition && input.comparison) {
    throw new Error('A comparison belongs to an explicitly selected competition')
  }

  const store = new StateStore(ctx.cwd)
  const root = store.projectRoot
  const target = await gitCommand(root, ['rev-parse', '--symbolic-full-name', 'HEAD'], signal)
  const targetRef = target === 'HEAD' ? '' : target

  if (
    (targetRef && !targetRef.startsWith('refs/heads/')) ||
    (await gitCommand(root, ['rev-parse', '--show-toplevel'], signal)) !== root
  ) {
    throw new Error('Start local candidates at the root of the intended Git checkout')
  }

  const base = await gitCommand(
    root,
    ['rev-parse', '--verify', (targetRef || 'HEAD') + '^{commit}'],
    signal,
  )
  await requireDependencies(root, base, signal)
  const project = await loadPinnedProject(root, base, signal)

  if (project.checks.some((check) => check.id === 'local-acceptance')) {
    throw new Error('The project already defines the reserved local-acceptance check ID')
  }

  const batch = randomUUID()
  const workloads = new Set<string>()
  const tasks = input.tasks.map(({ acceptance: override, ...task }): LocalTaskInput => {
    validateWriteScope(task.writePaths)
    const gate = override ?? input.acceptance

    if (!gate?.argv[0]?.trim() || gate.argv.some((arg) => arg.includes('\0'))) {
      throw new Error('Each task needs an executable acceptance command')
    }

    if (task.implementerModel && task.thinking === 'low') {
      throw new Error('Claude implementers support medium or high effort')
    }

    const workloadPaths = gate.workloadPaths ?? []
    validateWriteScope(workloadPaths)

    if (workloadPaths.includes('**') || scopesOverlap(workloadPaths, task.writePaths)) {
      throw new Error('Keep the pinned workload outside the implementation write scope')
    }

    for (const path of workloadPaths) {
      workloads.add(path)
    }

    return {
      ...task,
      context: competition
        ? 'Implement only the assigned approach in this worktree. Submit pass when its gate ' +
          'passes. The host retains candidates, compares them and integrates the winner.'
        : input.objective,
      local: {
        batch,
        mode,
        comparison: input.comparison,
        base,
        targetRef,
        objective: input.objective,
        workloadPaths,
        acceptance: {
          id: 'local-acceptance',
          kind: 'test',
          required: true,
          argv: gate.argv,
          timeoutMs: gate.timeoutMs ?? 120000,
        },
      },
    }
  })

  for (const path of workloads) {
    const tree = path.endsWith('/**')
    const name = tree ? path.slice(0, -3) : path
    const entry = await gitCommand(
      root,
      ['--literal-pathspecs', 'ls-tree', base, '--', name],
      signal,
    )

    if (!(tree ? /^040000 tree / : /^100(?:644|755) blob /).test(entry)) {
      throw new Error('Workload must exist on the pinned commit: ' + path)
    }
  }

  const jobs = await new Delegations(store).startBranches(
    tasks,
    {
      model: ctx.model.provider + '/' + ctx.model.id,
      originRoot: ctx.sessionManager.getHeader?.()?.cwd ?? ctx.cwd,
      session: ctx.sessionManager.getSessionId(),
      originEntry: ctx.sessionManager
        .getBranch()
        .findLast((entry) => entry.type === 'message' && entry.message.role === 'user')?.id,
    },
    launch,
  )
  return {
    batch,
    base,
    targetRef,
    tasks: jobs.map(delegationView),
    next: 'Continue discussion. Verified candidates stay local until selected for integration.',
  }
}

export function registerLocalTools(pi: ExtensionAPI, launch = launchDelegation): void {
  pi.registerTool({
    name: 'delegate_local',
    label: 'Start local implementers',
    description:
      'Run local implementers directly on a shared pinned HEAD in isolated worktrees. ' +
      'Default to one worker per scope. For a difficult tradeoff, competition requires a ' +
      'rationale, selection criterion, and one shared acceptance argv with ' +
      'workloadPaths for its drivers, inputs and fixtures. Each task describes its approach. ' +
      'Returns immediately. Uncommitted edits are excluded.',
    parameters: localBatchSchema,
    async execute(_id, input, signal, _update, ctx) {
      return textResult(await startLocalBatch(ctx, input, signal, launch))
    },
  })
  pi.registerTool({
    name: 'compare_candidates',
    label: 'Compare local candidates',
    description: 'Inspect the complete batch, acceptance evidence and selection status.',
    parameters: Type.Object({ batch: Type.String({ minLength: 36, maxLength: 36 }) }),
    outputSchema: Type.Object(
      {
        batch: Type.String(),
        mode: Type.String(),
        base: Type.String(),
        targetRef: Type.String(),
        candidates: Type.Array(
          Type.Object(
            {
              id: Type.String(),
              title: Type.String(),
              eligible: Type.Boolean(),
              status: Type.String(),
            },
            { additionalProperties: true },
          ),
        ),
      },
      { additionalProperties: true },
    ),
    async execute(_id, input, _signal, _update, ctx) {
      return structuredResult(await compareLocalCandidates(new StateStore(ctx.cwd), input.batch))
    },
  })
  pi.registerTool({
    name: 'integrate_candidate',
    executionMode: 'sequential',
    label: 'Integrate a verified local candidate',
    description:
      'Apply a verified independent task or one winning competing candidate to the ' +
      'originating local branch when integration is in scope. No remote publication.',
    parameters: Type.Object({ id: Type.String({ minLength: 36, maxLength: 36 }) }),
    async execute(_id, input, signal, _update, ctx) {
      return textResult(await integrateLocalCandidate(new StateStore(ctx.cwd), input.id, signal))
    },
  })
}
