import { setTimeout as delay } from 'node:timers/promises'
import { createHash } from 'node:crypto'
import {
  githubApi as api,
  githubArray as array,
  githubObject as object,
  reviewAgentIdentity,
  reviewBot,
  reviewCheckAgent,
  validatePull,
  type GitHubOptions,
  type GitHubPullRequest,
} from './branch-github.ts'

export type AgentReviewFeedback = {
  id: string
  actor: string
  body: string
  path?: string
  line?: number
  url: string
}

export type AgentReviewReceipt = {
  detected: boolean
  pending: boolean
  timedOut: boolean
  feedback: AgentReviewFeedback[]
  agents: string[]
  sources: string[]
  waitMs: number
}

export type AgentReviewOptions = GitHubOptions & {
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  minWaitMs?: number
  maxWaitMs?: number
  settleMs?: number
}

export type AgentReviewRound = {
  notBefore: string | number
  consumedIds?: string[]
  round: number
}

type Row = Record<string, unknown>
type Observation = {
  agents: Set<string>
  completed: Set<string>
  sources: Set<string>
  feedback: AgentReviewFeedback[]
  durations: number[]
}

const timestamp = (value: unknown) => Date.parse(String(value ?? ''))
const actor = (item: Row) => String(object(item.user).login ?? '').slice(0, 100)
const eventId = (kind: string, item: Row) =>
  `${kind}:${item.id}:${item.updated_at ?? item.submitted_at ?? item.completed_at ?? ''}:` +
  createHash('sha256')
    .update(String(item.body ?? ''))
    .digest('hex')
    .slice(0, 12)

async function list(
  path: string,
  signal: AbortSignal | undefined,
  options: AgentReviewOptions,
  key?: string,
): Promise<Row[]> {
  const pages = array(await api(path, signal, options, undefined, true))
  return pages.flatMap((page) => array(key ? object(page)[key] : page).map(object))
}

function triggered(body: string): string[] {
  if (!/\breview\b/i.test(body)) {
    return []
  }

  return [...body.matchAll(/@([\w-]+)/g)].flatMap((match) => {
    const agent = reviewAgentIdentity(match[1]!)
    return agent ? [agent] : []
  })
}

function feedback(kind: string, item: Row, fallback: string): AgentReviewFeedback {
  const body = String(item.body ?? fallback)

  if (body.length > 12000) {
    throw new Error(`Automated review exceeds the feedback limit: ${item.html_url ?? ''}`)
  }

  return {
    id: eventId(kind, item),
    actor: actor(item),
    body,
    url: String(item.html_url ?? '').slice(0, 1000),
    ...(typeof item.path === 'string' ? { path: item.path.slice(0, 500) } : {}),
    ...(typeof item.line === 'number' ? { line: item.line } : {}),
  }
}

function namedCommit(body: string, head: string): 'current' | 'other' | undefined {
  const hashes = [...body.matchAll(/(?:\/commit\/|\bcommit[:\s]+)([a-f0-9]{7,64})\b/gi)].map(
    (match) => match[1]!.toLowerCase(),
  )

  if (hashes.some((hash) => head.startsWith(hash))) {
    return 'current'
  }

  if (hashes.length) {
    return 'other'
  }

  return body.includes(head) ? 'current' : undefined
}

function observe(
  head: string,
  since: number,
  reviews: Row[],
  inline: Row[],
  comments: Row[],
  runs: Row[],
  suites: Row[],
  statuses: Row[],
): Observation {
  const result: Observation = {
    agents: new Set(),
    completed: new Set(),
    sources: new Set(),
    feedback: [],
    durations: [],
  }
  const freshReviews = new Map<unknown, Row>()
  const freshAgents = new Map<string, number>()
  const checkAgents = new Map<string, { start: number; end: number }>()
  const discover = (agent: string, source: string) => {
    result.agents.add(agent)
    result.sources.add(source)
  }

  for (const item of reviews) {
    const agent = reviewBot(item.user)

    if (!agent) {
      continue
    }

    discover(agent, `review:${item.id}`)

    if (item.commit_id === head && item.state !== 'PENDING') {
      freshReviews.set(item.id, item)
      freshAgents.set(agent, timestamp(item.submitted_at))
      result.completed.add(agent)
      result.feedback.push(feedback('review', item, `Review state: ${item.state}`))
    }
  }

  for (const item of inline) {
    const agent = reviewBot(item.user)

    if (!agent) {
      continue
    }

    discover(agent, `inline:${item.id}`)
    const parent = reviews.find((review) => review.id === item.pull_request_review_id)
    const current = parent
      ? freshReviews.has(parent.id)
      : item.commit_id === head && timestamp(item.created_at) >= since

    if (current) {
      result.completed.add(agent)
      result.feedback.push(feedback('inline', item, ''))
    }
  }

  for (const [source, items] of [
    ['run', runs],
    ['suite', suites],
    ['status', statuses],
  ] as const) {
    for (const item of items) {
      const agent = reviewCheckAgent(item, source)

      if (!agent || (item.head_sha && item.head_sha !== head)) {
        continue
      }

      discover(agent, `${source}:${item.id ?? item.context}`)
      const start = timestamp(item.started_at ?? item.created_at)
      const end = timestamp(item.completed_at ?? item.updated_at)
      const complete = source === 'status' ? item.state !== 'pending' : item.status === 'completed'

      if (Number.isFinite(start)) {
        checkAgents.set(agent, { start, end })
      }

      if (!complete) {
        continue
      }

      result.completed.add(agent)

      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        result.durations.push(end - start)
      }

      const output = item.output ? object(item.output) : undefined
      const detail = output ? String(output.summary ?? output.text ?? output.title ?? '') : ''
      const conclusion = source === 'status' ? item.state : item.conclusion
      const body = `Automated review check ${item.name ?? agent}: ${conclusion}.\n${detail}`

      if (body.trim()) {
        result.feedback.push(
          feedback(
            `check-${source}`,
            {
              ...item,
              body,
              user: { login: agent },
              html_url: item.details_url ?? item.html_url ?? item.target_url,
            },
            '',
          ),
        )
      }
    }
  }

  for (const item of comments) {
    const body = String(item.body ?? '')

    for (const agent of triggered(body)) {
      discover(agent, `trigger:${item.id}`)
      const after = reviews.find(
        (review) =>
          reviewBot(review.user) === agent &&
          timestamp(review.submitted_at) > timestamp(item.created_at),
      )

      if (after) {
        result.durations.push(timestamp(after.submitted_at) - timestamp(item.created_at))
      }
    }

    let agent = reviewBot(item.user)
    const user = item.user ? object(item.user) : {}

    if (!agent && user.login === 'github-actions[bot]' && checkAgents.size === 1) {
      agent = [...checkAgents.keys()][0]
    }

    if (!agent) {
      continue
    }

    discover(agent, `comment:${item.id}`)
    const named = namedCommit(body, head)
    const date = timestamp(item.updated_at ?? item.created_at)
    const run = checkAgents.get(agent)
    const reviewedAt = freshAgents.get(agent)
    const correlated =
      Boolean(reviewedAt && Math.abs(date - reviewedAt) <= 60000) ||
      Boolean(run && date >= run.start && (!Number.isFinite(run.end) || date <= run.end + 60000))

    if (named === 'current' || (named !== 'other' && date >= since && correlated)) {
      result.feedback.push(feedback('comment', item, ''))

      if (named === 'current' && !/review(?:ing| in progress| started| queued)/i.test(body)) {
        result.completed.add(agent)
      }
    }
  }

  return result
}

async function snapshot(
  pr: GitHubPullRequest,
  head: string,
  since: number,
  signal: AbortSignal | undefined,
  options: AgentReviewOptions,
): Promise<Observation> {
  const root = `repos/${pr.repository}`
  const inspect = async () => {
    const current = await api(`${root}/pulls/${pr.number}`, signal, options)
    const checked = validatePull(current, pr)

    if (checked.head.sha !== head) {
      throw new Error('PR head changed while awaiting automated review; restart on the new head')
    }

    return checked.item
  }
  const current = await inspect()
  const [reviews, inline, comments, runs, suites, statuses] = await Promise.all([
    list(`${root}/pulls/${pr.number}/reviews?per_page=100`, signal, options),
    list(`${root}/pulls/${pr.number}/comments?per_page=100`, signal, options),
    list(`${root}/issues/${pr.number}/comments?per_page=100`, signal, options),
    list(
      `${root}/commits/${head}/check-runs?filter=latest&per_page=100`,
      signal,
      options,
      'check_runs',
    ),
    list(`${root}/commits/${head}/check-suites?per_page=100`, signal, options, 'check_suites'),
    list(`${root}/commits/${head}/status?per_page=100`, signal, options, 'statuses'),
  ])
  await inspect()
  const state = observe(head, since, reviews, inline, comments, runs, suites, statuses)

  for (const user of array(current.requested_reviewers ?? [])) {
    const agent = reviewBot(user)

    if (agent) {
      state.agents.add(agent)
      state.sources.add(`requested-reviewer:${String(object(user).login)}`)
    }
  }

  return state
}

async function discoverHistory(
  pr: GitHubPullRequest,
  now: number,
  signal: AbortSignal | undefined,
  options: AgentReviewOptions,
): Promise<{ agents: string[]; sources: string[] }> {
  const since = new Date(now - 14 * 86400000).toISOString()
  const [comments, issueComments, workflows] = await Promise.all([
    list(
      `repos/${pr.repository}/pulls/comments?since=${since}` +
        '&sort=updated&direction=desc&per_page=100',
      signal,
      options,
    ),
    list(
      `repos/${pr.repository}/issues/comments?since=${since}` +
        '&sort=updated&direction=desc&per_page=100',
      signal,
      options,
    ),
    list(`repos/${pr.repository}/actions/workflows?per_page=100`, signal, options, 'workflows'),
  ])
  const agents = new Set<string>()
  const sources: string[] = []

  for (const item of [...comments, ...issueComments]) {
    const agent = reviewBot(item.user)

    if (agent) {
      agents.add(agent)
      sources.push(`recent-repository-review:${item.id}`)
    }
  }

  for (const item of workflows) {
    const agent = reviewCheckAgent(item, 'run')

    if (agent && item.state === 'active') {
      agents.add(agent)
      sources.push(`active-review-workflow:${item.id}`)
    }
  }

  return { agents: [...agents], sources }
}

export async function awaitAgentReview(
  pr: GitHubPullRequest,
  head: string,
  round: AgentReviewRound,
  signal?: AbortSignal,
  options: AgentReviewOptions = {},
): Promise<AgentReviewReceipt> {
  const since = typeof round.notBefore === 'number' ? round.notBefore : timestamp(round.notBefore)
  const now = options.now ?? Date.now
  const sleep = options.sleep ?? ((ms, abort) => delay(ms, undefined, { signal: abort }))
  const started = now()
  const minimum = options.minWaitMs ?? 120000
  const maximum = options.maxWaitMs ?? 600000
  const pollMs = options.pollMs ?? 15000
  const settleMs = options.settleMs ?? 10000

  if (
    !/^[a-f0-9]{40,64}$/.test(head) ||
    !Number.isFinite(since) ||
    !Number.isSafeInteger(round.round) ||
    round.round < 1 ||
    round.round > 5 ||
    !Number.isSafeInteger(minimum) ||
    minimum < 1 ||
    minimum > maximum ||
    !Number.isSafeInteger(maximum) ||
    maximum > 600000 ||
    !Number.isSafeInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 60000 ||
    !Number.isSafeInteger(settleMs) ||
    settleMs < 0 ||
    settleMs > maximum ||
    (round.consumedIds?.length ?? 0) > 1000
  ) {
    throw new Error('Invalid automated review round or polling policy')
  }

  signal?.throwIfAborted()
  const history = await discoverHistory(pr, started, signal, options)
  const agents = new Set<string>()
  const sources = new Set(history.sources)
  const consumed = new Set(round.consumedIds)
  const received = new Map<string, AgentReviewFeedback>()
  let reviewingAt: number | undefined
  let deadline = started + minimum
  let settledAt: number | undefined

  while (true) {
    signal?.throwIfAborted()
    const state = await snapshot(pr, head, since, signal, options)

    for (const name of state.agents) {
      agents.add(name)
    }

    for (const source of state.sources) {
      sources.add(source)
    }

    if (!agents.size) {
      const discoveryDeadline = started + (history.agents.length ? minimum : 0)

      if (now() >= discoveryDeadline) {
        sources.add('discovery:no-current-pr-review-trigger')
        return {
          detected: false,
          pending: false,
          timedOut: false,
          feedback: [],
          agents: [],
          sources: [...sources].slice(0, 300),
          waitMs: now() - started,
        }
      }

      await sleep(Math.min(pollMs, Math.max(1, discoveryDeadline - now())), signal)
      continue
    }

    if (reviewingAt === undefined) {
      reviewingAt = now()
      deadline = reviewingAt + Math.min(maximum, Math.max(minimum, 300000))
    }

    for (const item of state.feedback) {
      if (!consumed.has(item.id)) {
        received.set(item.id, item)
      }
    }

    if (received.size > 100 || JSON.stringify([...received.values()]).length > 50000) {
      throw new Error('Automated review feedback exceeds the 100-item/50 KB task budget')
    }

    const durations = state.durations
      .filter((value) => value > 0 && value <= maximum)
      .sort((a, b) => a - b)

    if (durations.length) {
      const p90 = durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.9))]!
      deadline = reviewingAt + Math.min(maximum, Math.max(minimum, p90 * 1.5 + 30000))
    }

    const complete = [...agents].every((name) => state.completed.has(name))

    if (complete) {
      settledAt ??= now()
    } else {
      settledAt = undefined
    }

    const timedOut = agents.size > 0 && now() >= deadline

    if (timedOut || (settledAt !== undefined && now() - settledAt >= settleMs)) {
      return {
        detected: agents.size > 0,
        pending: !complete,
        timedOut,
        feedback: [...received.values()],
        agents: [...agents],
        sources: [...sources].slice(0, 300),
        waitMs: now() - started,
      }
    }

    // Reviews commonly take minutes. Observation is host polling and never invokes a model.
    const interval = Math.min(60000, pollMs * (now() - reviewingAt > 120000 ? 2 : 1))
    await sleep(Math.min(interval, Math.max(1, deadline - now())), signal)
  }
}
