import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'

export type GitHubPullRequest = {
  number: number
  url: string
  repository: string
  branch: string
  target: string
}

export type GitHubCheck = {
  name: string
  source: 'status' | 'run' | 'suite'
  state: 'passed' | 'pending' | 'failed'
  conclusion: string
  url?: string
  details?: string
  agent?: string
}

export class GitHubChecksFailed extends Error {
  constructor(
    readonly head: string,
    readonly failures: GitHubCheck[],
    evidence: string,
  ) {
    super('GitHub checks failed: ' + JSON.stringify({ head, failures }) + '\n' + evidence)
  }
}

export type GitHubCheckReceipt = {
  status: 'passed' | 'none_reported'
  head: string
  checks: GitHubCheck[]
  reviews: { reviewer: string; state: string; commit: string; body: string }[]
  checkedAt: string
}

export type GitHubCommand = (
  args: string[],
  signal?: AbortSignal,
  input?: string,
) => Promise<string>

export type GitHubOptions = {
  run?: GitHubCommand
  timeoutMs?: number
  pollMs?: number
  registrationGraceMs?: number
  excludeAgentReviews?: boolean
  previousHead?: string
  headSyncTimeoutMs?: number
}

const reviewAgents = [
  ['codex', /\bcodex\b/i],
  ['claude', /\bclaude\b/i],
  ['coderabbit', /\bcoderabbit(?:ai)?\b/i],
  ['copilot', /\bcopilot\b/i],
  ['gemini', /\bgemini(?:-code-assist)?\b/i],
  ['greptile', /\bgreptile\b/i],
  ['qodo', /\b(?:qodo|codium|pr-agent)\b/i],
  ['cursor', /\b(?:cursor|bugbot)\b/i],
  ['sourcery', /\bsourcery(?:-ai)?\b/i],
  ['ellipsis', /\bellipsis\b/i],
] as const

export function reviewAgentIdentity(label: string): string | undefined {
  return reviewAgents.find(([, pattern]) => pattern.test(label))?.[0]
}

export function reviewBot(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }

  const user = object(value)
  const login = String(user.login ?? '')
  return user.type === 'Bot' || /\[bot\]$/i.test(login) ? reviewAgentIdentity(login) : undefined
}

export function reviewCheckAgent(
  value: unknown,
  source: GitHubCheck['source'],
): string | undefined {
  const item = object(value)
  const app = item.app ? object(item.app) : undefined
  const identity = app && reviewAgentIdentity(String(app.slug ?? app.name ?? ''))

  if (identity) {
    return identity
  }

  const label = String(source === 'status' ? item.context : (item.name ?? ''))
  const agent = reviewAgentIdentity(label)
  return agent && (/review|analysis|bugbot/i.test(label) || label.trim().toLowerCase() === agent)
    ? agent
    : undefined
}

const command: GitHubCommand = (args, signal, input) => {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const child = execFile(
      'gh',
      args,
      {
        cwd: homedir(),
        env: {
          ...process.env,
          GH_HOST: 'github.com',
          GH_PROMPT_DISABLED: '1',
          GH_PAGER: 'cat',
          NO_COLOR: '1',
        },
        encoding: 'utf8',
        timeout: 30_000,
        killSignal: 'SIGKILL',
        maxBuffer: 2_000_000,
        signal,
      },
      (error, output) => {
        if (error) {
          reject(new Error(`GitHub CLI request failed (${error.code ?? error.name})`))
        } else {
          resolve(output)
        }
      },
    )
    child.stdin?.on('error', () => {})
    child.stdin?.end(input)
  })
}

export function githubRepository(remoteUrl: string): string | undefined {
  const match = remoteUrl.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/]+\/[^/]+?)\/?$/i,
  )

  if (!match) {
    return undefined
  }

  const repository = match[1]!.replace(/\.git$/, '')

  if (!/^[a-z\d][a-z\d-]{0,38}\/[a-z\d_][a-z\d._-]{0,99}$/i.test(repository)) {
    throw new Error('Invalid GitHub repository remote')
  }

  return repository
}

async function api(
  path: string,
  signal: AbortSignal | undefined,
  options: GitHubOptions,
  body?: unknown,
  paginate = false,
): Promise<unknown> {
  const args = [
    'api',
    '--hostname',
    'github.com',
    '--method',
    body ? 'POST' : 'GET',
    '-H',
    'Accept: application/vnd.github+json',
    path,
  ]

  if (body) {
    args.push('--input', '-')
  }

  if (paginate) {
    args.push('--paginate', '--slurp')
  }

  const input = body === undefined ? undefined : JSON.stringify(body)
  return JSON.parse(await (options.run ?? command)(args, signal, input))
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid GitHub API object')
  }

  return value as Record<string, unknown>
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length > 10000) {
    throw new Error('Invalid or excessive GitHub API collection')
  }

  return value
}

function validatePull(value: unknown, expected: Omit<GitHubPullRequest, 'number' | 'url'>) {
  const item = object(value)
  const head = object(item.head)
  const base = object(item.base)

  if (
    item.state !== 'open' ||
    head.ref !== expected.branch ||
    base.ref !== expected.target ||
    String(object(head.repo).full_name).toLowerCase() !== expected.repository.toLowerCase() ||
    String(object(base.repo).full_name).toLowerCase() !== expected.repository.toLowerCase() ||
    typeof item.number !== 'number' ||
    !Number.isSafeInteger(item.number) ||
    item.number < 1
  ) {
    throw new Error('GitHub pull request does not match the task branch and target')
  }

  return { item, head }
}

export { api as githubApi, array as githubArray, object as githubObject, validatePull }

function pullReference(value: unknown, expected: Omit<GitHubPullRequest, 'number' | 'url'>) {
  const { item } = validatePull(value, expected)
  const url = `https://github.com/${expected.repository}/pull/${item.number}`

  if (String(item.html_url).toLowerCase() !== url.toLowerCase()) {
    throw new Error('Unexpected GitHub pull request URL')
  }

  return { ...expected, number: item.number as number, url }
}

export async function ensureBranchPullRequest(
  input: { remoteUrl: string; branch: string; target: string; title: string; body: string },
  signal?: AbortSignal,
  options: GitHubOptions = {},
): Promise<GitHubPullRequest | undefined> {
  const repository = githubRepository(input.remoteUrl)

  if (!repository) {
    return undefined
  }

  if (
    !input.title.trim() ||
    input.title.length > 200 ||
    input.body.length > 24000 ||
    [input.branch, input.target].some((ref) => !ref || ref.length > 200 || /\s|\0/.test(ref))
  ) {
    throw new Error('Invalid bounded GitHub pull request input')
  }

  const expected = { repository, branch: input.branch, target: input.target }
  const owner = repository.split('/')[0]
  const query = new URLSearchParams({
    state: 'open',
    head: `${owner}:${input.branch}`,
    base: input.target,
    per_page: '100',
  })
  const find = async () => {
    const pages = array(
      await api(`repos/${repository}/pulls?${query}`, signal, options, undefined, true),
    )
    const found = pages.flatMap(array)

    if (found.length > 1) {
      throw new Error('Multiple open pull requests match this task branch')
    }

    return found.length ? pullReference(found[0], expected) : undefined
  }
  const existing = await find()

  if (existing) {
    return existing
  }

  try {
    return pullReference(
      await api(`repos/${repository}/pulls`, signal, options, {
        head: input.branch,
        base: input.target,
        title: input.title,
        body: input.body,
        draft: false,
      }),
      expected,
    )
  } catch (error) {
    signal?.throwIfAborted()
    const raced = await find()

    if (raced) {
      return raced
    }

    throw error
  }
}

function check(value: unknown, source: GitHubCheck['source']): GitHubCheck {
  const item = object(value)
  const terminal = source === 'status' || item.status === 'completed'
  const conclusion = String(source === 'status' ? item.state : (item.conclusion ?? 'pending'))
  const name = String(
    source === 'status'
      ? item.context
      : source === 'run'
        ? item.name
        : (object(item.app).slug ?? item.id),
  )
  const pending = !terminal || conclusion === 'pending'
  const url = source === 'status' ? item.target_url : item.details_url
  const output = item.output ? object(item.output) : undefined
  return {
    source,
    name: name.slice(0, 300),
    state: pending ? 'pending' : conclusion === 'success' ? 'passed' : 'failed',
    conclusion,
    agent: reviewCheckAgent(value, source),
    ...(typeof url === 'string' ? { url: url.slice(0, 1000) } : {}),
    ...(output ? { details: String(output.summary ?? output.title ?? '').slice(0, 1500) } : {}),
  }
}

async function failureLogs(
  pr: GitHubPullRequest,
  failures: GitHubCheck[],
  signal: AbortSignal,
  options: GitHubOptions,
): Promise<string> {
  const ids = new Set<string>()

  for (const failure of failures) {
    let url: URL

    try {
      url = new URL(failure.url ?? '')
    } catch {
      continue
    }

    const parts = url.pathname.split('/')

    if (
      url.origin === 'https://github.com' &&
      parts.slice(1, 3).join('/').toLowerCase() === pr.repository.toLowerCase() &&
      parts[3] === 'actions' &&
      parts[4] === 'runs' &&
      /^\d+$/.test(parts[5] ?? '')
    ) {
      ids.add(parts[5]!)
    }
  }

  const excerpts: string[] = []

  for (const id of [...ids].slice(0, 3)) {
    try {
      const text = await (options.run ?? command)(
        ['run', 'view', id, '--log-failed', '--repo', pr.repository],
        signal,
      )
      excerpts.push(`GitHub Actions run ${id}:\n${text.slice(-4000)}`)
    } catch {
      signal.throwIfAborted()
      excerpts.push(`GitHub Actions run ${id}: failed log retrieval unavailable.`)
    }
  }

  return excerpts.join('\n')
}

async function checks(
  pr: GitHubPullRequest,
  head: string,
  signal: AbortSignal,
  options: GitHubOptions,
) {
  const prefix = `repos/${pr.repository}/commits/${head}`
  const queries = [
    ['status', `${prefix}/status?per_page=100`, 'statuses'],
    ['run', `${prefix}/check-runs?filter=latest&per_page=100`, 'check_runs'],
    ['suite', `${prefix}/check-suites?per_page=100`, 'check_suites'],
  ] as const
  const results = await Promise.all(
    queries.map(async ([source, path, key]) => {
      const pages = array(await api(path, signal, options, undefined, true))
      return { source, values: pages.flatMap((page) => array(object(page)[key])) }
    }),
  )
  const runs = results.find((result) => result.source === 'run')!.values.map(object)
  return results.flatMap(({ source, values }) =>
    values.flatMap((value) => {
      const item = object(value)
      const result = check(value, source)

      if (!options.excludeAgentReviews) {
        return [result]
      }

      if (result.agent) {
        return []
      }

      if (source === 'suite' && typeof item.id === 'number') {
        const members = runs.filter(
          (run) => run.check_suite && object(run.check_suite).id === item.id,
        )
        const ordinary = members.filter((run) => !reviewCheckAgent(run, 'run'))

        // Mixed suites aggregate review outcomes; their ordinary runs remain individual CI gates.
        if (
          members.length > ordinary.length &&
          ordinary.every((run) => check(run, 'run').state === 'passed')
        ) {
          return []
        }
      }

      return [result]
    }),
  )
}

async function reviews(pr: GitHubPullRequest, signal: AbortSignal, options: GitHubOptions) {
  const pages = array(
    await api(
      `repos/${pr.repository}/pulls/${pr.number}/reviews?per_page=100`,
      signal,
      options,
      undefined,
      true,
    ),
  )
  const latest = new Map<number, GitHubCheckReceipt['reviews'][number]>()

  for (const value of pages.flatMap(array)) {
    const item = object(value)

    if (!['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(String(item.state))) {
      continue
    }

    const user = object(item.user)

    if (options.excludeAgentReviews && reviewBot(user)) {
      continue
    }

    if (typeof user.id !== 'number' || !Number.isSafeInteger(user.id) || user.id < 1) {
      throw new Error('Invalid GitHub review author')
    }

    latest.set(user.id, {
      reviewer: String(user.login).slice(0, 100),
      state: String(item.state),
      commit: String(item.commit_id),
      body: String(item.body ?? '').slice(0, 2000),
    })
  }

  return [...latest.values()]
}

export async function awaitBranchChecks(
  pr: GitHubPullRequest,
  expectedHead: string,
  signal?: AbortSignal,
  options: GitHubOptions = {},
): Promise<GitHubCheckReceipt> {
  if (!/^[a-f0-9]{40,64}$/.test(expectedHead)) {
    throw new Error('GitHub checks require an exact commit SHA')
  }

  const timeoutMs = options.timeoutMs
  const pollMs = options.pollMs ?? 5000
  const graceMs = options.registrationGraceMs ?? 30000
  const headSyncMs = options.headSyncTimeoutMs ?? 30000

  if (
    (timeoutMs !== undefined &&
      (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647)) ||
    !Number.isSafeInteger(pollMs) ||
    pollMs < 1 ||
    pollMs > 60000 ||
    !Number.isSafeInteger(graceMs) ||
    graceMs < 0 ||
    (timeoutMs !== undefined && graceMs > timeoutMs) ||
    !Number.isSafeInteger(headSyncMs) ||
    headSyncMs < 1 ||
    headSyncMs > 60000 ||
    (options.previousHead !== undefined && !/^[a-f0-9]{40,64}$/.test(options.previousHead))
  ) {
    throw new Error('Invalid GitHub check wait budget')
  }

  const started = Date.now()
  const combined = AbortSignal.any([
    ...(timeoutMs === undefined ? [] : [AbortSignal.timeout(timeoutMs)]),
    ...(signal ? [signal] : []),
  ])
  const inspect = async () => {
    const result = await api(`repos/${pr.repository}/pulls/${pr.number}`, combined, options)
    const { head } = validatePull(result, pr)

    if (head.sha === expectedHead) {
      return true
    }

    if (head.sha === options.previousHead && Date.now() - started < headSyncMs) {
      return false
    }

    throw new Error('GitHub pull request head changed; fresh validation is required')
  }

  while (true) {
    combined.throwIfAborted()

    if (!(await inspect())) {
      await delay(Math.min(pollMs, headSyncMs), undefined, { signal: combined })
      continue
    }

    const reported = await checks(pr, expectedHead, combined, options)
    const reviewed = await reviews(pr, combined, options)

    if (!(await inspect())) {
      await delay(Math.min(pollMs, headSyncMs), undefined, { signal: combined })
      continue
    }

    const failures = reported.filter((item) => item.state === 'failed')

    if (failures.length) {
      throw new GitHubChecksFailed(
        expectedHead,
        failures,
        await failureLogs(pr, failures, combined, options),
      )
    }

    const objections = reviewed.filter((item) => item.state === 'CHANGES_REQUESTED')

    if (objections.length) {
      throw new Error('GitHub review changes requested: ' + JSON.stringify(objections))
    }

    const pending = reported.some((item) => item.state === 'pending')

    if (!pending && Date.now() - started >= graceMs) {
      return {
        status: reported.length ? 'passed' : 'none_reported',
        head: expectedHead,
        checks: reported,
        reviews: reviewed,
        checkedAt: new Date().toISOString(),
      }
    }

    await delay(pollMs, undefined, { signal: combined })
  }
}
