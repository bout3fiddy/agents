import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { rm } from 'node:fs/promises'
import type { Project, Receipt, WorkerEvidence, WorkerRole, WorkerThinking } from './contracts.ts'
import { StateStore, atomicJson, type TaskState } from './state.ts'
import { collectWorkerResults, dispatcher, type Dispatcher } from './dispatch.ts'
import { createWorkspace, hasSkippedTests, loadProject, verifyProject } from './project.ts'
import { changes, integrate, recoverIntegration } from './integration.ts'
import {
  documentPath,
  fileHashes,
  inventory,
  matches,
  snapshotHash,
  writable,
  rejectIgnoredAdditions,
} from './paths.ts'
import { runSandboxed } from './sandbox.ts'
import { retainedCandidate } from './resume.ts'
import { bindFormatterProof, formatterClosures } from './formatter-review.ts'
import { receiptView } from './context.ts'

// A changed adapter can alter transaction semantics below an unchanged driver import.
const databaseStatements = new RegExp(
  [
    String.raw`\b(?:create|alter|drop)\s+(?:table|index|schema)|\binsert\s+into\b|`,
    String.raw`\b(?:delete\s+from|begin\s+transaction)\b|\bupdate\s+\w+\s+set\b|`,
    String.raw`\b(?:select\s+[^;\n]{1,200}\s+from|pg_dump|pg_restore|redis-cli)\b|`,
    String.raw`\b(?:db|database|prisma)\.(?:transaction|\$transaction|query|execute)\s*\(`,
  ].join(''),
  'i',
)
const driver =
  '(?:pg|postgres(?:ql)?|psycopg[23]?|sqlite3?|redis|ioredis|prisma|drizzle-orm|' +
  'mongoose|mysql2?|mongodb|knex|sqlalchemy)'
const pythonDatabaseDependency = new RegExp(String.raw`^\s*${driver}(?:\[|\s|[<=>!~;]|$)`, 'im')
const databaseDriver = new RegExp(
  [
    String.raw`(?:\b(?:from|import|require)\s*\(?\s*['"]?(?:node:|better-|@)?${driver}\b|`,
    String.raw`\b(?:from|import|require)\s*\(?\s*['"](?:[@\w.-]+\/)+${driver}['"]|`,
    String.raw`\b${driver}(?:\+\w+)?:\/\/|`,
    String.raw`\b(?:image|engine|provider|dialect|driver)['"]?\s*[:=]\s*['"]?${driver}\b|`,
    String.raw`['"](?:better-|@)?${driver}(?:\/client)?['"]\s*:)`,
  ].join(''),
  'i',
)

export function databaseImpact(
  before: Map<string, Buffer>,
  after: Map<string, Buffer>,
  paths: string[],
): boolean {
  return changes(before, after).some((path) => {
    if (paths.some((scope) => matches(path, scope)) || /\.(?:sql|prisma)$/i.test(path)) {
      return true
    }

    if (/(?:^|\/)requirements(?:[.-][^/]*)?\.txt$/i.test(path)) {
      return [before.get(path), after.get(path)].some(
        (bytes) => bytes && pythonDatabaseDependency.test(bytes.toString('utf8')),
      )
    }

    if (documentPath(path) || /\.(?:mdx|markdown|adoc)$/i.test(path)) {
      return false
    }

    return [before.get(path), after.get(path)].some((bytes) => {
      if (!bytes || bytes.includes(0)) {
        return false
      }

      const source = bytes.toString('utf8')
      return databaseStatements.test(source) || databaseDriver.test(source)
    })
  })
}

function failed(receipts: Receipt[], project: Project): Receipt[] {
  return receipts.filter(
    (item) =>
      item.status !== 'passed' &&
      (item.check.startsWith('required-') ||
        item.check === 'harness-lint' ||
        project.checks.find((check) => check.id === item.check)?.required),
  )
}

export async function benchmarks(
  workspace: string,
  project: Project,
  signal?: AbortSignal,
): Promise<Receipt[]> {
  const snapshot = snapshotHash(await inventory(workspace))
  const receipts: Receipt[] = []

  for (const check of project.checks.filter((item) => item.kind === 'benchmark')) {
    const probe = await createWorkspace(workspace)
    const result = await runSandboxed(probe, check.argv, check.timeoutMs, signal).finally(() =>
      rm(probe, { recursive: true, force: true }),
    )
    receipts.push({
      snapshot,
      check: check.id,
      status:
        result.exitCode === 0 &&
        !result.timedOut &&
        !result.aborted &&
        !result.truncated &&
        !hasSkippedTests(result.output)
          ? 'passed'
          : 'failed',
      result,
    })
  }

  if (!project.checks.some((check) => check.kind === 'benchmark' && check.required)) {
    receipts.push({
      snapshot,
      check: 'required-benchmark',
      status: 'unavailable',
      result: {
        argv: [],
        exitCode: null,
        output: 'Declare a required benchmark check in .pi/harness.json',
        timedOut: false,
        aborted: false,
        truncated: false,
        durationMs: 0,
      },
    })
  }

  return receipts
}

type WorkflowRole = Exclude<WorkerRole, 'task-worker'>

export async function runWorkflow(
  store: StateStore,
  model: string,
  signal?: AbortSignal,
  dispatch: Dispatcher = dispatcher(store),
  thinking: Partial<Record<WorkflowRole, WorkerThinking>> = {},
): Promise<TaskState> {
  const release = await store.lock()
  let task: TaskState | undefined

  try {
    await recoverIntegration(store)
    const checkpoint = await store.checkpoint()

    if (!checkpoint) {
      throw new Error('Supply a settled design to workflow before running implementation')
    }

    if (checkpoint.unresolved.length) {
      throw new Error('Resolve design questions before implementation')
    }

    const project = await loadProject(store.projectRoot)
    const requiredKinds = [
      'test',
      ...(checkpoint.database ? ['database'] : []),
      ...(checkpoint.performance ? ['benchmark'] : []),
    ]
    const missing = requiredKinds.filter(
      (kind) => !project.checks.some((check) => check.required && check.kind === kind),
    )

    if (missing.length) {
      throw new Error(`Configure required ${missing.join(', ')} checks in .pi/harness.json`)
    }

    const before = await inventory(store.projectRoot)
    const lintBaseline = { files: before, writePaths: checkpoint.writePaths }
    const retained = await retainedCandidate(store, checkpoint, before)
    const workspace = await createWorkspace(retained?.task.candidate ?? store.projectRoot)
    const originals = await createWorkspace(store.projectRoot)
    task = {
      id: randomUUID(),
      designHash: checkpoint.hash,
      designVersion: checkpoint.version,
      status: 'running',
      phase: 'implementation',
      round: 0,
      candidate: workspace,
      resumedFrom: retained?.task.id,
      evidence: retained?.task.evidence ?? [],
      receipts: [],
    }
    await store.saveTask(task)
    await atomicJson(join(store.directory, 'tasks', `${task.id}.baseline.json`), fileHashes(before))
    const resumedRound = retained?.readyForReview ? retained.task.reviewRound : undefined
    let needsDatabase = checkpoint.database || Boolean(resumedRound?.database)
    let feedback = retained
      ? JSON.stringify({
          assignment:
            'Continue the retained candidate. Resolve prior findings and preserve valid work.',
          error: retained.task.error,
          reviews: retained.task.evidence.slice(-4).map((item) => item.result),
          checks: retained.task.receipts.map(receiptView),
        })
      : 'Implement the accepted design. Preserve unrelated work and ' + 'return concrete evidence.'
    const baseline = checkpoint.performance ? await benchmarks(originals, project, signal) : []
    await atomicJson(
      join(store.directory, 'tasks', `${task.id}.baseline-benchmarks.json`),
      baseline,
    )

    async function dispatchWorker(
      role: WorkflowRole,
      assignment: string,
      frozen?: string,
      changedFiles?: string[],
    ) {
      signal?.throwIfAborted()
      const evidence = await dispatch(
        {
          role,
          thinking: thinking[role],
          task: assignment,
          workspace,
          project,
          checkpoint: checkpoint!,
          model,
          baseline: fileHashes(before),
          changedFiles,
          originals,
        },
        signal,
      )

      signal?.throwIfAborted()

      if (
        evidence.role !== role ||
        evidence.snapshot !== (frozen ?? snapshotHash(await inventory(workspace)))
      ) {
        throw new Error(`Stale or mismatched ${role} evidence`)
      }

      return evidence
    }

    async function worker(role: WorkflowRole, assignment: string): Promise<WorkerEvidence> {
      const evidence = await dispatchWorker(role, assignment)
      task!.evidence.push(evidence)
      await store.saveTask(task!)
      return evidence
    }

    let lastFailure = ''

    for (let round = 1; ; round++) {
      signal?.throwIfAborted()

      if (feedback) {
        const failure = snapshotHash(await inventory(workspace)) + feedback

        if (failure === lastFailure) {
          throw new Error(
            'The same failure persisted without candidate changes; ' +
              'inspect retained evidence and resolve the missing prerequisite on the host',
          )
        }

        lastFailure = failure
      }

      task.round = round
      task.phase = 'implementation'
      await store.saveTask(task)

      if (!(round === 1 && retained?.readyForReview)) {
        const implementation = await worker('implementer', feedback)

        if (implementation.result.verdict === 'blocked') {
          throw new Error(`Implementation blocked: ${implementation.result.summary}`)
        }

        needsDatabase ||= implementation.result.databaseImpact

        if (checkpoint.performance) {
          task.phase = 'performance'
          await store.saveTask(task)
          const measurement = await worker(
            'performance',
            JSON.stringify({
              assignment:
                'Add or improve benchmarks and report measurements. Do not optimize p' +
                'roduct code.',
              baselineBenchmarks: baseline.map(receiptView),
              previousFeedback: feedback,
            }),
          )

          if (measurement.result.verdict !== 'pass') {
            feedback = JSON.stringify(measurement.result)
            continue
          }
        }
      }

      const candidate = await inventory(workspace)
      await rejectIgnoredAdditions(store.projectRoot, before, candidate)

      for (const path of changes(before, candidate)) {
        if (!writable(path, checkpoint.writePaths)) {
          throw new Error(`Out-of-scope edit: ${path}`)
        }
      }

      needsDatabase ||= databaseImpact(before, candidate, project.databasePaths)
      task.phase = 'verification'
      task.snapshot = snapshotHash(candidate)
      task.receipts = await verifyProject(workspace, project, needsDatabase, signal, lintBaseline)

      if (checkpoint.performance) {
        task.receipts.push(...(await benchmarks(workspace, project, signal)))
      }

      await store.saveTask(task)
      const failures = failed(task.receipts, project)

      if (failures.length) {
        if (failures.some((item) => item.status === 'unavailable')) {
          throw new Error('Configure the missing required checks in .pi/harness.json')
        }

        feedback = JSON.stringify({ requiredChecks: failures.map(receiptView) })
        continue
      }

      task.phase = 'review'
      const frozen = task.snapshot
      const reviewRound =
        round === 1 && resumedRound?.snapshot === frozen
          ? resumedRound
          : { snapshot: frozen, start: task.evidence.length, database: needsDatabase }
      task.reviewRound = reviewRound
      await store.saveTask(task)
      const reviews = task.evidence
        .slice(reviewRound.start)
        .filter(
          (item) =>
            item.snapshot === frozen &&
            (item.role === 'reviewer' || item.role === 'database-reviewer'),
        )
      const closures = formatterClosures(task.evidence, candidate)

      if (closures.length) {
        reviews.push(...closures)
        task.evidence.push(...closures)
        await store.saveTask(task)
      }

      const changedFiles = changes(before, candidate)
      const engineeringTask = JSON.stringify({
        assignment: 'Independently review the complete candidate against the accepted design.',
        receipts: task.receipts.map(receiptView),
      })
      const databaseTask = () =>
        JSON.stringify({
          assignment:
            'Review committed-data recovery, transactions, migration and failure semantics.',
          receipts: task!.receipts.map(receiptView),
        })
      const collect = (attempts: Promise<WorkerEvidence>[]) =>
        collectWorkerResults(attempts, async (finished) => {
          if (snapshotHash(await inventory(workspace)) !== frozen) {
            throw new Error('Candidate changed during review')
          }

          for (const review of finished) {
            await bindFormatterProof(review, candidate, workspace, checkpoint!.writePaths)
          }

          task!.evidence.push(...finished)
          reviews.push(...finished)
          await store.saveTask(task!)
        })
      const attempts: Promise<WorkerEvidence>[] = []

      if (!reviews.some((item) => item.role === 'reviewer')) {
        attempts.push(dispatchWorker('reviewer', engineeringTask, frozen, changedFiles))
      }

      if (needsDatabase && !reviews.some((item) => item.role === 'database-reviewer')) {
        attempts.push(dispatchWorker('database-reviewer', databaseTask(), frozen, changedFiles))
      }

      await collect(attempts)

      // Only engineering can reveal previously unknown impact after verification.
      if (!needsDatabase && reviews.some((item) => item.result.databaseImpact)) {
        needsDatabase = true
        reviewRound.database = true
        task.receipts = await verifyProject(workspace, project, true, signal, lintBaseline)

        if (checkpoint.performance) {
          task.receipts.push(...(await benchmarks(workspace, project, signal)))
        }

        await store.saveTask(task)
        await collect([dispatchWorker('database-reviewer', databaseTask(), frozen, changedFiles)])
      }

      const issues = reviews.filter((item) => item.result.verdict !== 'pass')

      if (issues.length || failed(task.receipts, project).length) {
        feedback = JSON.stringify({
          reviews: reviews.map(({ role, result }) => ({ role, ...result })),
          checks: task.receipts.map(receiptView),
        })
        continue
      }

      if (snapshotHash(await inventory(workspace)) !== task.snapshot) {
        throw new Error('Candidate changed after verification')
      }

      const currentDesign = await store.checkpoint()

      if (currentDesign?.hash !== checkpoint.hash || currentDesign.version !== checkpoint.version) {
        throw new Error('Accepted design changed during implementation')
      }

      if (snapshotHash(await inventory(store.projectRoot)) !== snapshotHash(before)) {
        throw new Error('Project changed during review; preserve both versions and rerun')
      }

      task.status = 'applying'
      task.phase = 'integration'
      await store.saveTask(task)
      release.assertHeld()
      await integrate(store, before, candidate, checkpoint.writePaths)
      task.receipts = await verifyProject(
        store.projectRoot,
        project,
        needsDatabase,
        signal,
        lintBaseline,
      )

      if (checkpoint.performance) {
        task.receipts.push(...(await benchmarks(store.projectRoot, project, signal)))
      }

      if (failed(task.receipts, project).length) {
        throw new Error('Post-integration checks failed; inspect retained receipts and candidate')
      }

      const verifiedSnapshot = task.snapshot

      if (
        snapshotHash(await inventory(store.projectRoot)) !== verifiedSnapshot ||
        task.receipts.some((receipt) => receipt.snapshot !== verifiedSnapshot)
      ) {
        throw new Error('Integrated project changed during verification')
      }

      task.status = 'complete'
      task.phase = 'complete'
      await store.saveTask(task)
      await rm(workspace, { recursive: true, force: true })
      await rm(originals, { recursive: true, force: true })
      return task
    }
  } catch (error) {
    if (!task) {
      throw error
    }

    task.status = signal?.aborted ? 'interrupted' : 'needs_attention'
    task.error = error instanceof Error ? error.message : String(error)
    await store.saveTask(task)
    return task
  } finally {
    await release()
  }
}
