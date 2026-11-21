import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  Delegations,
  activeTask,
  delegationDirectory,
  type Delegation,
} from './delegation-state.ts'
import type { Receipt, WorkerEvidence } from './contracts.ts'
import { acquireMergeLock, gitCommand, GitCommandError } from './git-branches.ts'
import { verifyLocalSnapshot } from './local-candidate.ts'
import type { LocalPlan } from './local-contracts.ts'
import { linkBranchDependencies } from './branch-runner.ts'
import { inventory, snapshotHash } from './paths.ts'
import { atomicJson, readJson, type StateStore } from './state.ts'

type Decision = {
  id: string
  batch: string
  targetRef: string
  sourceCommit: string
  previousTip: string
  integratedCommit: string
  status: 'pending' | 'integrated'
  checks: { check: string; status: Receipt['status']; snapshot: string }[]
}

const uuid = /^[a-f0-9]{8}-[a-f0-9-]{27}$/
const oid = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/

async function localGroup(store: StateStore, batch: string) {
  if (!uuid.test(batch)) {
    throw new Error('Invalid local candidate batch ID')
  }

  const manifest = await readJson<{ ids: string[] }>(
    join(store.directory, 'local-batches', batch + '.json'),
  )
  const ids = manifest?.ids

  if (!Array.isArray(ids) || !ids.length || ids.length > 4 || new Set(ids).size !== ids.length) {
    throw new Error('Missing or invalid sealed candidate group')
  }

  const registry = new Delegations(store)
  const jobs = await Promise.all(ids.map((id) => registry.get(id)))
  const plan = jobs[0]!.request.local

  if (!plan || plan.batch !== batch) {
    throw new Error('Sealed group does not match local task provenance')
  }

  for (const { request } of jobs) {
    const actual = request.local

    if (
      request.kind !== 'branch' ||
      !actual ||
      actual.batch !== batch ||
      actual.base !== plan.base ||
      actual.mode !== plan.mode ||
      actual.targetRef !== plan.targetRef
    ) {
      throw new Error('Local candidates must share their group, base and target')
    }

    if (
      plan.mode === 'competition' &&
      (actual.objective !== plan.objective ||
        actual.comparison?.difficulty !== plan.comparison?.difficulty ||
        actual.comparison?.criterion !== plan.comparison?.criterion ||
        JSON.stringify(actual.workloadPaths) !== JSON.stringify(plan.workloadPaths) ||
        JSON.stringify(actual.acceptance) !== JSON.stringify(plan.acceptance))
    ) {
      throw new Error('Competing candidates must use the same objective and pinned workload')
    }
  }

  return { plan, jobs }
}

function candidateEvidence({ request, state }: Delegation) {
  const plan = request.local!
  const gate = state.receipts?.find((receipt) => receipt.check === plan.acceptance.id)
  const eligible =
    state.status === 'complete' &&
    state.base === plan.base &&
    oid.test(state.commit ?? '') &&
    gate?.status === 'passed' &&
    /^[a-f0-9]{64}$/.test(gate.snapshot) &&
    JSON.stringify(gate.result.argv) === JSON.stringify(plan.acceptance.argv) &&
    state.receipts!.every((receipt) => receipt.snapshot === gate.snapshot)
  return {
    id: request.id,
    title: request.title ?? request.task,
    status: state.status,
    summary: state.error ?? state.summary,
    commit: state.commit,
    eligible: Boolean(eligible),
    snapshot: gate?.snapshot,
    checks: state.receipts?.map(({ check, status }) => ({ check, status })),
    acceptance: gate && {
      status: gate.status,
      elapsedMs: gate.result.durationMs,
      output:
        gate.result.output.length > 2000
          ? gate.result.output.slice(0, 980) + '\n…\n' + gate.result.output.slice(-980)
          : gate.result.output,
      receiptPath: `delegations/${request.id}/status.json`,
    },
  }
}

export async function compareLocalCandidates(store: StateStore, batch: string) {
  const { jobs, plan } = await localGroup(store, batch)
  const decision = await readJson<Decision>(
    join(store.directory, 'local-batches', batch + '.selection.json'),
  )
  return {
    batch,
    mode: plan.mode,
    base: plan.base,
    targetRef: plan.targetRef,
    objective: plan.mode === 'competition' ? plan.objective : undefined,
    comparison: plan.comparison,
    acceptance: plan.mode === 'competition' ? plan.acceptance : undefined,
    candidates: await Promise.all(
      jobs.map(async (job) => ({
        ...candidateEvidence(job),
        integrated:
          plan.mode === 'independent'
            ? (await readJson<Decision>(decisionPath(store, job)))?.status
            : undefined,
      })),
    ),
    selection: decision,
  }
}

async function containsCommit(root: string, ancestor: string, tip: string, signal?: AbortSignal) {
  try {
    await gitCommand(root, ['merge-base', '--is-ancestor', ancestor, tip], signal)
    return true
  } catch (error) {
    if (error instanceof GitCommandError && error.code === 1) {
      return false
    }

    throw error
  }
}

function decisionPath(store: StateStore, job: Delegation) {
  const local = job.request.local!
  const key = local.mode === 'competition' ? local.batch : job.request.id
  return join(store.directory, 'local-batches', key + '.selection.json')
}

async function integratedWorkloads(
  store: StateStore,
  siblings: Delegation[],
  tip: string,
  signal: AbortSignal,
) {
  const previous: LocalPlan[] = []

  for (const sibling of siblings) {
    const plan = sibling.request.local!

    if (plan.mode !== 'independent') {
      continue
    }

    const record = await readJson<Decision>(decisionPath(store, sibling))

    if (record && (await containsCommit(store.projectRoot, record.integratedCommit, tip, signal))) {
      previous.push(plan)
    }
  }

  return previous
}

async function validateCombined(
  store: StateStore,
  job: Delegation,
  siblings: Delegation[],
  tip: string,
  signal: AbortSignal,
) {
  const { request, state } = job
  const plan = request.local!
  const commit = state.commit!
  const root = store.projectRoot
  const baseline = join(store.directory, 'baselines')
  await mkdir(baseline, { recursive: true, mode: 0o700 })
  const worktrees: string[] = []

  async function checkout(revision: string) {
    const path = join(baseline, randomUUID())
    await gitCommand(root, ['worktree', 'add', '--detach', '--', path, revision], signal)
    worktrees.push(path)
    return path
  }

  try {
    const combined = await checkout(commit)
    const snapshot = snapshotHash(await inventory(combined))

    if (candidateEvidence(job).snapshot !== snapshot) {
      throw new Error('Verified candidate receipts do not match its committed snapshot')
    }

    const prior = await integratedWorkloads(store, siblings, tip, signal)

    if (tip === plan.base && !prior.length) {
      return { integratedCommit: commit, receipts: state.receipts! }
    }

    if (!(await containsCommit(root, plan.base, tip, signal))) {
      throw new Error('Local target diverged from pinned baseline; candidate retained')
    }

    const original = await checkout(tip)
    const policy = await checkout(plan.base)
    await gitCommand(combined, ['checkout', '--detach', tip], signal)

    try {
      await gitCommand(combined, ['merge', '--no-edit', '--no-ff', '--', commit], signal)
    } catch (error) {
      if (error instanceof GitCommandError && error.code === 1) {
        const conflicts = await gitCommand(
          combined,
          ['diff', '--name-only', '--diff-filter=U', '-z'],
          signal,
        )

        if (conflicts) {
          throw new Error(
            'Local integration conflict: ' + conflicts.split('\0').filter(Boolean).join(', '),
            { cause: error },
          )
        }
      }

      throw error
    }

    await linkBranchDependencies(root, combined, signal)
    const integratedCommit = await gitCommand(combined, ['rev-parse', 'HEAD'], signal)
    const evidence = await readJson<WorkerEvidence>(
      join(delegationDirectory(store, request.id), state.progressFile!),
    )

    if (!evidence) {
      throw new Error('Missing implementer evidence for integration revalidation')
    }

    const receipts = await verifyLocalSnapshot(
      request,
      original,
      combined,
      evidence,
      signal,
      policy,
      prior,
    )
    return { integratedCommit, receipts }
  } finally {
    for (const path of worktrees.reverse()) {
      await gitCommand(root, ['worktree', 'remove', '--force', '--', path])
    }
  }
}

async function checkDestination(root: string, targetRef: string, signal?: AbortSignal) {
  if (!targetRef || (await gitCommand(root, ['symbolic-ref', 'HEAD'], signal)) !== targetRef) {
    throw new Error('Local integration requires the original target branch to be checked out')
  }

  const uncommitted = await gitCommand(root, ['status', '--porcelain', '-uno'], signal)

  if (uncommitted) {
    throw new Error('Local target has tracked changes; verified candidates were retained')
  }

  return gitCommand(root, ['rev-parse', 'HEAD'], signal)
}

export async function integrateLocalCandidate(
  store: StateStore,
  id: string,
  signal = new AbortController().signal,
) {
  const root = store.projectRoot
  const job = await new Delegations(store).get(id)
  const plan = job.request.local

  if (!plan) {
    throw new Error('Only a verified local candidate can be integrated')
  }

  const common = await gitCommand(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  const release = await acquireMergeLock(common, signal)

  try {
    const { jobs } = await localGroup(store, plan.batch)
    const chosen = jobs.find((item) => item.request.id === id)

    if (!chosen || !candidateEvidence(chosen).eligible) {
      throw new Error('Candidate lacks passing acceptance evidence on its pinned baseline')
    }

    if (
      plan.mode === 'competition' &&
      jobs.some(({ state }) => activeTask(state) || state.status === 'paused')
    ) {
      throw new Error('Competing candidates are still active or paused; compare after they stop')
    }

    const path = decisionPath(store, chosen)
    let decision = await readJson<Decision>(path)

    if (decision && (decision.id !== id || decision.sourceCommit !== chosen.state.commit)) {
      throw new Error('A different verified candidate was already selected')
    }

    if (decision?.status === 'integrated') {
      return decision
    }

    // A previous fast-forward may already be complete, even if the user has since edited files.
    const recovered =
      decision &&
      (await containsCommit(root, decision.integratedCommit, decision.targetRef, signal))

    if (!recovered || !decision) {
      const tip = await checkDestination(root, plan.targetRef, signal)

      if (!decision || decision.previousTip !== tip) {
        const siblings = jobs.filter((item) => item.request.id !== id)
        const result = await validateCombined(store, chosen, siblings, tip, signal)
        decision = {
          id,
          batch: plan.batch,
          targetRef: plan.targetRef,
          sourceCommit: chosen.state.commit!,
          previousTip: tip,
          integratedCommit: result.integratedCommit,
          status: 'pending',
          checks: result.receipts.map(({ check, status, snapshot }) => ({
            check,
            status,
            snapshot,
          })),
        }
      }

      if ((await checkDestination(root, plan.targetRef, signal)) !== tip) {
        throw new Error('Local target moved during verification; retry to validate the new tip')
      }

      release.assertHeld()
      const keep = 'refs/pi-harness/local-integrations/' + id
      await gitCommand(root, ['update-ref', keep, decision.integratedCommit], signal)
      await atomicJson(path, decision)
      await gitCommand(
        root,
        [
          'merge',
          '--ff-only',
          '--no-overwrite-ignore',
          '--no-autostash',
          '--',
          decision.integratedCommit,
        ],
        signal,
      )
    }

    const integratedTip = await gitCommand(root, ['rev-parse', '--verify', plan.targetRef], signal)

    if (!(await containsCommit(root, decision.integratedCommit, integratedTip, signal))) {
      throw new Error('Local target does not contain the selected commit; inspect its receipt')
    }

    const complete: Decision = { ...decision, status: 'integrated' }
    await atomicJson(path, complete)
    await gitCommand(root, ['update-ref', '-d', 'refs/pi-harness/local-integrations/' + id])
    return complete
  } finally {
    await release()
  }
}
