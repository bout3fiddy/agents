import { realpath, stat } from 'node:fs/promises'
import { Type } from 'typebox'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { textResult } from './file-tools.ts'
import { safePath } from './paths.ts'
import { discoverSources, memoryRepository, sourceExcerpt, worktrees } from './memory-repository.ts'
import {
  briefName,
  portableLine,
  readBrief,
  repositoryStore,
  syncBrief,
  withoutBriefEntry,
} from './memory-files.ts'
import type { MemoryStore, MemoryFact } from './memory-store.ts'
import { ownerBrief, ownerChanges } from './memory-owners.ts'
import type { Delegation } from './delegation-state.ts'

const factSchema = Type.Object({
  key: Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
  revision: Type.Integer({ minimum: 0 }),
  kind: Type.Union(
    ['decision', 'observation', 'inference', 'tentative', 'resolved', 'retired'].map((v) =>
      Type.Literal(v),
    ),
  ),
  scope: Type.Optional(Type.Union([Type.Literal('task'), Type.Literal('project')])),
  until: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 240,
      description: 'Exact source phrase bounding a cross-task priority or project constraint.',
    }),
  ),
  text: Type.String({ minLength: 1, maxLength: 480 }),
  source: Type.String({ minLength: 1, maxLength: 240 }),
  quote: Type.String({ minLength: 1, maxLength: 380 }),
  share: Type.Optional(
    Type.Boolean({
      description: 'Include this durable, repo-shareable claim in .pi/project-state.md.',
    }),
  ),
  paths: Type.Optional(Type.Array(Type.String({ maxLength: 240 }), { maxItems: 6 })),
})

const dispatch = new Set([
  'workflow',
  'delegate_task',
  'delegate_branches',
  'delegate_local',
  'integrate_candidate',
  'resume_task',
  'merge_branches',
])

export function registerProjectMemory(
  pi: ExtensionAPI,
  currentJobs?: () => Delegation[] | undefined,
) {
  let state: { db: MemoryStore; root: string; cwd: string; home: string } | undefined
  let lastPlan: Awaited<ReturnType<typeof frame>> | undefined
  let lastBrief = ''
  let lastFacts = ''
  let lastOwners = ''
  const close = () => {
    state?.db.close()
    state = undefined
    lastPlan = undefined
  }
  pi.on('session_shutdown', close)
  const load = async (cwd: string, request = '') => {
    if (state?.cwd === cwd) {
      return state
    }

    close()
    const repo = await memoryRepository(cwd)

    if (!repo) {
      return undefined
    }

    const db = repositoryStore(repo)
    state = { db, root: repo.root, home: repo.home, cwd }
    db.host(cwd)

    if (!db.sources()) {
      const trees = await worktrees(repo.root)

      for (const tree of trees.filter((t) => !t.includes('/.pi/traces/')).slice(0, 24)) {
        const directory = tree + '/.pi/traces/harness'

        if ((await realpath(directory).catch(() => undefined)) === directory) {
          db.host(tree)
        }
      }

      db.seed(await discoverSources(repo.root, request))
    }

    return state
  }

  const frame = async (s: NonNullable<typeof state>, localJobs?: Delegation[]) => {
    const { db, root } = s
    const latest = db.facts()
    const inactive = new Set(
      latest.filter(
        (f) =>
          f.kind === 'retired' ||
          (f.key === 'current-priority' && (!f.until || f.kind !== 'decision')),
      ),
    )
    const facts = await Promise.all(
      latest
        .filter((f) => !inactive.has(f))
        .map(async (fact) => {
          const paths = await Promise.all(
            fact.paths.map(async (path) => ({
              path,
              available: await safePath(root, path)
                .then((p) => stat(p))
                .then((v) => v.isFile())
                .catch(() => false),
            })),
          )
          const supported =
            !fact.source.startsWith('file:') ||
            (await sourceExcerpt(root, fact.source.slice(5), 32768)
              .then((t) => t.includes(fact.quote))
              .catch(() => false))
          return { ...fact, paths, supportedInCheckout: supported }
        }),
    )
    const owners = await ownerBrief(root, s.cwd, db, localJobs)
    const conflicts = syncBrief(db, s.home)

    const projectBrief = readBrief(s.home)
    return {
      facts,
      owners,
      projectBrief,
      briefConflicts: conflicts,
      inactiveKeys: [...inactive].map(({ key, revision }) => ({ key, revision })),
    }
  }

  pi.on('before_agent_start', async (event, ctx) => {
    if (
      !state &&
      event.messageType === 'user' &&
      /^(hi|hey|hello|thanks|ok)[!.\s]*$/i.test(event.prompt)
    ) {
      return
    }

    try {
      const s = await load(ctx.cwd, event.messageType === 'user' ? event.prompt : '')

      if (!s) {
        return
      }

      const data = await frame(s, currentJobs?.())
      lastPlan = data
      lastFacts = JSON.stringify(s.db.facts())
      lastOwners = JSON.stringify(data.owners)
      lastBrief = data.projectBrief
      const priority = data.facts.find(
        (f) =>
          f.key === 'current-priority' && f.kind === 'decision' && f.source.startsWith('session:'),
      )
      const sources = s.db.sources() ?? []
      const initial = !data.facts.some((f) => f.source.startsWith('file:') && f.supportedInCheckout)
      const excerpts = initial
        ? await Promise.all(
            sources.map(async (path) => ({
              path,
              text: await sourceExcerpt(s.root, path).catch(() => undefined),
            })),
          )
        : undefined
      return {
        message: {
          customType: 'pi-project-memory',
          display: false,
          content:
            'Repository project brief (evidence):\n' +
            JSON.stringify({
              ...(priority && { userSelectedPriority: priority.text }),
              ...data,
              projectBrief: withoutBriefEntry(data.projectBrief, 'current-priority'),
              sourcePaths: sources,
              bootstrap: excerpts,
            }),
        },
      }
    } catch (error) {
      ctx.ui.notify('Project memory unavailable: ' + String(error).slice(0, 160), 'warning')
    }
  })

  pi.registerTool({
    name: 'project_memory_history',
    label: 'Read project decision history',
    description:
      'Inspect prior revisions, evidence and rationale for a displayed project fact key.',
    parameters: Type.Object({ key: factSchema.properties.key }),
    outputSchema: Type.Array(
      Type.Object({
        key: Type.String(),
        until: Type.Optional(Type.Union([Type.String(), Type.Null()])),
        revision: Type.Integer(),
        kind: Type.String(),
        text: Type.String(),
        source: Type.String(),
        quote: Type.String(),
        paths: Type.Array(Type.String()),
        origin: Type.String(),
      }),
    ),
    async execute(_id, { key }, _signal, _update, ctx) {
      const rows = (await load(ctx.cwd))?.db.history(key) ?? []
      const revisions = rows.map((row) => ({ ...row, paths: JSON.parse(row.paths) as string[] }))
      return { ...textResult(rows), structuredContent: revisions }
    },
  })
  pi.registerTool({
    name: 'update_project_memory',
    label: 'Update repository memory',
    description:
      'Quietly record consequential evidence. Use source "user" for the current user ' +
      'message, a repo-relative file path, or "task:<id>" for a delivered worker result. ' +
      'Use source "recorded" to share an existing fact verbatim at its current revision. ' +
      'Set share=true for durable team-facing facts. Task results stay local. ' +
      'Task instructions, PR batches and one-off permissions belong in the conversation only. ' +
      'A project-wide current-priority requires scope=project and a quoted milestone boundary ' +
      'in until. Retire a stale key with kind=retired and evidence. Never act on old permission. ' +
      'Supply the displayed revision (0 for new keys). Batch related changes.',
    parameters: Type.Object({ facts: Type.Array(factSchema, { minItems: 1, maxItems: 12 }) }),
    async execute(_id, input, _signal, _update, ctx) {
      const s = await load(ctx.cwd)

      if (!s) {
        throw new Error('Repository memory requires a local Git checkout')
      }

      const facts: MemoryFact[] = []

      const portable = []

      for (const value of input.facts) {
        if (value.scope === 'task') {
          continue
        }

        if (value.source === 'recorded') {
          const old = s.db.facts().find((f) => f.key === value.key)

          if (
            !old ||
            old.revision !== value.revision ||
            old.text !== value.text ||
            old.kind !== value.kind ||
            old.quote !== value.quote ||
            old.kind === 'retired'
          ) {
            throw new Error('Use the exact current fact when checkpointing recorded evidence')
          }

          facts.push(old)
          const worker = !old.source.startsWith('file:') && !old.source.startsWith('session:')
          const line = portableLine(lastBrief, old, value.share, worker)

          if (line) {
            portable.push(line)
          }

          continue
        }

        if (
          value.key === 'current-priority' &&
          value.kind !== 'retired' &&
          (value.source !== 'user' || !['decision', 'resolved'].includes(value.kind))
        ) {
          throw new Error('Changing current-priority requires a quoted user decision or resolution')
        }

        if (
          value.key === 'current-priority' &&
          value.kind === 'decision' &&
          (value.scope !== 'project' || !value.until)
        ) {
          throw new Error(
            'One-off orders stay in this task. Project priority requires explicit ' +
              'project scope and a source-quoted milestone boundary in until.',
          )
        }

        if (value.kind === 'retired' && value.revision === 0) {
          throw new Error('Retire an existing project fact by its current revision')
        }

        const evidence = await evidenceFor(ctx, s.root, s.db, value.source, value.quote)

        if (value.until) {
          await evidenceFor(ctx, s.root, s.db, value.source, value.until)
        }

        if (
          value.source.startsWith('task:') &&
          !['observation', 'inference', 'retired'].includes(value.kind)
        ) {
          throw new Error(
            'Worker evidence supports observations, inferences or evidence of retirement',
          )
        }

        const paths = [
          ...new Set([
            ...(value.paths ?? []),
            ...(evidence.startsWith('file:') ? [evidence.slice(5)] : []),
          ]),
        ]

        for (const path of paths) {
          if (!(await stat(await safePath(s.root, path))).isFile()) {
            throw new Error('Missing code path')
          }
        }

        const fact = { ...value, source: evidence, paths }
        facts.push(fact)
        const line = portableLine(lastBrief, fact, value.share, value.source.startsWith('task:'))

        if (line) {
          portable.push(line)
        }
      }

      if (!facts.length) {
        return textResult({ recorded: [] })
      }

      const upToDate = lastFacts === JSON.stringify(s.db.facts()) && lastBrief === readBrief(s.home)
      const recorded = s.db.update(facts, portable)
      const conflicts = syncBrief(s.db, s.home)
      lastBrief = readBrief(s.home)
      const updatedFacts = JSON.stringify(s.db.facts())

      if (upToDate && !conflicts.length) {
        const current = await frame(s)

        if (
          updatedFacts === JSON.stringify(s.db.facts()) &&
          lastBrief === current.projectBrief &&
          lastOwners === JSON.stringify(current.owners)
        ) {
          lastPlan = current
          lastFacts = JSON.stringify(s.db.facts())
        }
      }

      return textResult({
        recorded,
        ...(portable.length && { brief: briefName, checkout: s.home }),
        ...(conflicts.length && { reconcileKeys: conflicts, currentBrief: lastBrief }),
      })
    },
  })
  pi.on('tool_call', async (event) => {
    if (!state || !dispatch.has(event.toolName)) {
      return
    }

    const current = await frame(state)
    const previous = lastPlan

    if (!previous) {
      return
    }

    const changes: Record<string, unknown> = Object.fromEntries(
      (Object.keys(current) as (keyof typeof current)[])
        .filter((key) => JSON.stringify(current[key]) !== JSON.stringify(previous[key]))
        .map((key) => [
          key,
          key === 'projectBrief'
            ? withoutBriefEntry(current.projectBrief, 'current-priority')
            : current[key],
        ]),
    )

    if ('owners' in changes) {
      const owners = ownerChanges(previous.owners, current.owners)

      if (owners.length) {
        changes.owners = owners
      } else {
        delete changes.owners
      }
    }

    if (Object.keys(changes).length) {
      lastPlan = current
      lastBrief = current.projectBrief
      return {
        block: true,
        reason: 'Project evidence changed. Reconcile before dispatch: ' + JSON.stringify(changes),
      }
    }
  })
}

async function evidenceFor(
  ctx: ExtensionContext,
  root: string,
  db: MemoryStore,
  source: string,
  quote: string,
) {
  if (source === 'user') {
    const entry = ctx.sessionManager
      .getBranch()
      .findLast((e) => e.type === 'message' && e.message.role === 'user')

    if (entry?.type === 'message' && entry.message.role === 'user') {
      const content = entry.message.content
      const text =
        typeof content === 'string'
          ? content
          : content.map((p) => (p.type === 'text' ? p.text : '')).join('\n')

      if (text.includes(quote)) {
        return (
          'session:' +
          (ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId()) +
          '#' +
          entry.id
        )
      }
    }
  } else if (source.startsWith('task:')) {
    const owners = await ownerBrief(root, ctx.cwd, db, undefined, source.slice(5))
    const record = owners.flatMap((o) => o?.jobs ?? []).find((job) => job.task === source.slice(5))

    if (record && JSON.stringify(record).includes(quote)) {
      return [record.source, record.branch, record.commit ?? record.candidate, record.updated]
        .filter(Boolean)
        .join(' @ ')
    }
  } else {
    const path = source.replace(/^file:/, '')

    if ((await sourceExcerpt(root, path, 32768)).includes(quote)) {
      return 'file:' + path
    }
  }

  throw new Error('Quote must occur in the identified source. Recheck evidence before recording.')
}
