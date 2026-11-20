import { realpath, stat } from 'node:fs/promises'
import { Type } from 'typebox'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { textResult } from './file-tools.ts'
import { digest, safePath } from './paths.ts'
import { discoverSources, memoryRepository, sourceExcerpt, worktrees } from './memory-repository.ts'
import { briefName, portableLine, readBrief, repositoryStore, syncBrief } from './memory-files.ts'
import type { MemoryStore, MemoryFact } from './memory-store.ts'
import { ownerBrief } from './memory-owners.ts'
import type { Delegation } from './delegation-state.ts'

const factSchema = Type.Object({
  key: Type.String({ pattern: '^[a-z][a-z0-9-]{0,63}$' }),
  revision: Type.Integer({ minimum: 0 }),
  kind: Type.Union(
    ['decision', 'observation', 'inference', 'tentative', 'resolved'].map((v) => Type.Literal(v)),
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
  'resume_task',
  'merge_branches',
])

export function registerProjectMemory(
  pi: ExtensionAPI,
  currentJobs?: () => Delegation[] | undefined,
) {
  let state: { db: MemoryStore; root: string; cwd: string; home: string } | undefined
  let lastPlan = ''
  let lastBrief = ''
  let lastFacts = ''
  let lastOwners = ''
  const close = () => {
    state?.db.close()
    state = undefined
    lastPlan = ''
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
    const facts = await Promise.all(
      db.facts().map(async (fact) => {
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
    return { facts, owners, projectBrief: readBrief(s.home), briefConflicts: conflicts }
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
      lastPlan = digest(JSON.stringify(data))
      lastFacts = JSON.stringify(s.db.facts())
      lastOwners = JSON.stringify(data.owners)
      lastBrief = data.projectBrief
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
            JSON.stringify({ ...data, sourcePaths: sources, bootstrap: excerpts }),
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
    async execute(_id, { key }, _signal, _update, ctx) {
      return textResult((await load(ctx.cwd))?.db.history(key) ?? [])
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
        if (value.source === 'recorded') {
          const old = s.db.facts().find((f) => f.key === value.key)

          if (
            !old ||
            old.revision !== value.revision ||
            old.text !== value.text ||
            old.kind !== value.kind ||
            old.quote !== value.quote
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

        const evidence = await evidenceFor(ctx, s.root, s.db, value.source, value.quote)

        if (
          value.source.startsWith('task:') &&
          !['observation', 'inference'].includes(value.kind)
        ) {
          throw new Error('Worker evidence supports observations and inferences only')
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
          lastPlan = digest(JSON.stringify(current))
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
    const revision = digest(JSON.stringify(current))

    if (lastPlan && revision !== lastPlan) {
      lastPlan = revision
      lastBrief = current.projectBrief
      return {
        block: true,
        reason: 'Project evidence changed. Reconcile before dispatch: ' + JSON.stringify(current),
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
