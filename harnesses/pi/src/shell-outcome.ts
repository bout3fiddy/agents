import { stripVTControlCharacters } from 'node:util'

export type ShellOperation = { key: string; title: string; repository?: string }
export type ShellOutcome = { text: string; kind: 'success' | 'error' | 'notice'; key?: string }

const excerptSize = 8192

function excerpt(text: string): string {
  if (text.length <= excerptSize * 2) {
    return text
  }

  return text.slice(0, excerptSize) + '\n…\n' + text.slice(-excerptSize)
}

function plain(text: string): string {
  return stripVTControlCharacters(excerpt(text))
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .replace(/[\p{Cc}\p{Cf}]/gu, (char) => (char === '\n' ? char : ' '))
}

function pullRequest(command: string): ShellOperation | undefined {
  const ids = new Set<string>()
  const repos = new Set<string>()
  const refs = [
    /\bgh\s+pr\s+(?:view|merge|diff|checks|checkout|edit|ready|close|reopen)\s+['"]?(\d{1,10})\b/gi,
    /\brefs\/pull\/(\d{1,10})\/(?:head|merge)\b/g,
    /\/(?:pulls|pull)\/(\d{1,10})\b/g,
    /(?:^|[\s/_-])pr[-_]?(\d{1,10})[-_](?:active[-_])?worktree\b/gi,
  ]

  for (const ref of refs) {
    for (const match of command.matchAll(ref)) {
      ids.add(match[1]!)
    }
  }

  for (const match of command.matchAll(
    /(?:github\.com\/|\brepos\/|\s(?:--repo[=\s]+|-R\s+))([\w.-]+\/[\w.-]+)/g,
  )) {
    repos.add(match[1]!.toLowerCase())
  }

  if (ids.size !== 1 || repos.size > 1) {
    return undefined
  }

  const id = [...ids][0]!
  return { key: 'pr:' + id, title: 'PR #' + id, repository: [...repos][0] }
}

// These labels describe an intended operation; only observed tool results can describe its outcome.
const purposes: [RegExp, string][] = [
  [/\bgh\s+pr\s+merge\b/, 'Merge pull request'],
  [/\bgit\s+merge-tree\b/, 'Check mergeability'],
  [/\bgit\s+commit\b/, 'Commit changes'],
  [/\bgit\s+push\b/, 'Push branch'],
  [/\bgit\s+worktree\s+add\b/, 'Prepare worktree'],
  [/\bgit\s+merge\b/, 'Merge changes'],
  [/\bgh\s+pr\s+checks\b/, 'Inspect pull request checks'],
  [/\bgh\s+pr\s+view\b/, 'Inspect pull request'],
  [/\bgit\s+fetch\b/, 'Fetch refs'],
  [/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:check|verify|lint)\b/, 'Run project checks'],
  [/(?:\s--test|\bpytest|\bcargo\s+test|\bgo\s+test|\bnpm\s+(?:run\s+)?test)\b/, 'Run tests'],
  [/\bgit\s+(?:diff|status|log|show|rev-parse)\b/, 'Inspect Git state'],
  [/^pwd(?:\s|$)/, 'Inspect working directory'],
  [/(?:^|[;|&\n])\s*(?:rg|grep|find)\s/, 'Search files'],
  [/(?:^|[;|&\n])\s*(?:cat|head|tail|sed)\s/, 'Inspect files'],
]

function localOperation(command: string): ShellOperation | undefined {

  // A directory switch or compound command can cross repository and operation boundaries.
  if (/[;&|`$<>\n]/.test(command)) {
    return undefined
  }

  if (/^git\s+(?:status|diff)\b/.test(command)) {
    return { key: 'git:inspect', title: 'Inspect changes' }
  }

  const script = /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(check|verify|test|lint)(?=\s|$)/.exec(
    command,
  )

  if (script) {
    return { key: 'gate:' + script[1], title: 'Project ' + script[1] }
  }

  if (/^(?:node\s+--test|pytest|cargo\s+test|go\s+test)(?=\s|$)/.test(command)) {
    return { key: 'gate:tests', title: 'Project tests' }
  }

  return undefined
}

export function describeShell(command: string): { purpose: string; operation?: ShellOperation } {
  const text = plain(command)
  const purpose = /(?:^|\s)--dry-run\b/.test(text)
    ? 'Preview changes'
    : (purposes.find(([pattern]) => pattern.test(text))?.[1] ?? 'Run shell command')
  return { purpose, operation: pullRequest(text) ?? localOperation(text.trim()) }
}

function gitHubState(command: string, output: string): string | undefined {
  const terminalRead =
    /(?:^|;|&&|\n)\s*gh\s+(?:pr\s+view\b|api\b[^;&|<>\n]*?\/pulls\/\d+\b)[^;&|<>\n]*$/

  if (!terminalRead.test(command.trim().replace(/;$/, '')) || !output.endsWith('}')) {
    return undefined
  }

  let value

  try {
    value = JSON.parse(output.slice(output.lastIndexOf('\n{') + 1))
  } catch {

    // Display-only parse; an unrecognized command keeps its raw form.
    return undefined
  }

  if (value?.state === 'MERGED' || value?.merged === true) {
    return 'PR merged'
  }

  if (value?.state === 'OPEN' || value?.state === 'open') {
    return 'PR open'
  }

  return undefined
}

const diagnostics: [RegExp, string][] = [
  [/^fatal: not a git repository\b/im, 'Outside a Git repository'],
  [
    /(?:^fatal: Authentication failed|auth(?:entication|orization) required|HTTP 401\b)/im,
    'Authentication required',
  ],
  [/(?:non-fast-forward|\[rejected\][^\n]*\(fetch first\))/, 'Remote branch has newer commits'],
  [
    /(?:required status check|review is required|protected branch hook declined)/i,
    'Branch protection blocked the update',
  ],
  [/permission denied/i, 'Permission denied'],
  [/command not found/i, 'Command unavailable'],
  [/no such file or directory/i, 'File or directory missing'],
  [/could not resolve host|temporary failure in name resolution/i, 'Host name lookup failed'],
  [/no space left on device/i, 'Disk space exhausted'],
]

function testSummary(command: string, lines: string, isError: boolean): ShellOutcome | undefined {
  const runner = /\b(?:node|tsx|npm|pnpm|bun|yarn|make|pytest|vitest|cargo|go)\b/

  if (!runner.test(command)) {
    return undefined
  }

  const passed = /^(?:#|ℹ) pass (\d{1,9})\s*$/m.exec(lines)
  const failed = /^(?:#|ℹ) fail (\d{1,9})\s*$/m.exec(lines)
  const skipped = /^(?:#|ℹ) skipped (\d{1,9})\s*$/m.exec(lines)

  if (passed && failed && (!isError || failed[1] !== '0')) {
    const counts = [passed[1] + ' tests passed']

    if (failed[1] !== '0') {
      counts.push(failed[1] + ' failed')
    }

    if (skipped && skipped[1] !== '0') {
      counts.push(skipped[1] + ' skipped')
    }

    return {
      text: counts.join(' · '),
      kind: isError ? 'error' : failed[1] === '0' ? 'success' : 'notice',
      key: 'tests',
    }
  }

  if (isError) {

    // Rust, pytest and Vitest give a count. Avoid echoing failing test names and assertion data.
    const count = /^(?:[= ]*(\d{1,9}) failed\b|\s*Tests\s+(\d{1,9}) failed\b)/m.exec(lines)
    const rust = /^test result: FAILED\. \d+ passed; (\d{1,9}) failed;/m.exec(lines)
    const number = count?.[1] ?? count?.[2] ?? rust?.[1]

    if (number) {
      return {
        text: number + (number === '1' ? ' test failed' : ' tests failed'),
        kind: 'error',
        key: 'tests',
      }
    }

    if (/^(?:not ok \d+|--- FAIL: |FAIL\s+\S)/m.test(lines)) {
      return { text: 'Test failure reported', kind: 'error', key: 'tests' }
    }
  }

  return undefined
}

function inspectionResult(command: string, raw: string, full: boolean): ShellOutcome | undefined {
  if (/[;&|`$<>\n]/.test(command)) {
    return undefined
  }

  if (/^pwd(?:\s+-[LP])*\s*$/.test(command) && /^\/[^\n]*$/.test(raw.trimEnd())) {
    return { text: 'Working directory reported', kind: 'success', key: 'pwd' }
  }

  if (/^(?:rg|grep)\s/.test(command) && raw.trim()) {
    const count = raw.trimEnd().split('\n').length
    const text = full
      ? count + (count === 1 ? ' line of search output' : ' lines of search output')
      : 'Search returned output'
    return { text, kind: 'success', key: 'search' }
  }

  if (/^git\s+status\b/.test(command)) {
    const porcelain = /\s(?:--short|--porcelain(?:=v1)?|-s)(?=\s|$)/.test(command)
    let text

    if (porcelain && !raw.trim()) {
      text = 'No changes reported'
    } else if (/(?:^|\n)nothing to commit, working tree clean$/.test(raw.trimEnd())) {
      text = 'Working tree clean'
    } else if (porcelain && full && !/\s(?:-z|--null)\b/.test(command)) {
      const entries = raw
        .trimEnd()
        .split('\n')
        .filter((line) => !line.startsWith('## '))

      if (entries.length && entries.every((line) => /^[ MADRCUT?!]{2} ./.test(line))) {
        text = entries.length + (entries.length === 1 ? ' status entry' : ' status entries')
      }
    }

    if (text) {
      return { text, kind: 'success', key: 'git-status' }
    }
  }

  return undefined
}

export function shellOutcome(command: string, output: string, isError: boolean): ShellOutcome {
  const source = plain(command)
  const raw = plain(output)
  const lines = raw.trim()
  const last = lines.slice(lines.lastIndexOf('\n') + 1).trim()
  const exit = /^Command exited with code (\d+)\.?$/.exec(last)
  const conflict = /^CONFLICT \([^)\n]+\): Merge conflict in (.{1,200})$/m.exec(lines)

  if (conflict && /\bgit\s+(?:merge(?:-tree)?|rebase|cherry-pick)\b/.test(source)) {
    const name = conflict[1]!
    const file = /^[\p{L}\p{N}_. /-]{1,90}$/u.test(name) ? ' in ' + name : ''
    return {
      kind: isError ? 'error' : 'notice',
      text: 'Merge conflict' + file,
      key: 'conflict:' + file,
    }
  }

  const tests = testSummary(source, lines, isError)

  if (isError) {
    const timeout = /(?:^|\n)Command timed out after (\d+) seconds\b/.exec(lines)
    let text = 'Command failed'

    if (timeout) {
      text = 'Command timed out after ' + timeout[1] + 's'
    } else if (last === 'Command aborted') {
      text = 'Command cancelled'
    } else if (tests) {
      return tests
    } else if (
      /^(?:rg|grep)\s/.test(source) &&
      !/[;&|`$<>\n]/.test(source) &&
      /^Command exited with code 1\.?$/.test(lines)
    ) {
      return { kind: 'notice', text: 'Search returned no matches', key: 'search' }
    } else {
      text =
        diagnostics.find(([pattern]) => pattern.test(lines))?.[1] ??
        (/\bgh\s+pr\s+merge\b/.test(source) ? 'PR merge unconfirmed' : 'Command failed')
    }

    if (exit) {
      text += ' · exit ' + exit[1]
    }

    return { kind: 'error', text, key: 'failure:' + text }
  }

  const inspected = inspectionResult(source.trim(), raw, output.length <= excerptSize * 2)

  if (inspected) {
    return inspected
  }

  const pr = gitHubState(source, lines)

  if (pr) {
    return { text: pr, kind: 'success', key: 'pr-state' }
  }

  const selection =
    /^check:\s*(\d+) changed file(?:s|\(s\))? since [^\n]+?\s*→\s*no tests\s*$/im.exec(lines)

  if (selection && /(?:^|\s)--dry-run\b/.test(source)) {
    return {
      text: 'Dry run · ' + selection[1] + ' changed files · no tests selected',
      kind: 'notice',
      key: 'dry-run',
    }
  }

  if (tests) {
    return tests
  }

  const commit = /^\[(?:detached HEAD|[\w./-]+) ([a-f0-9]{7,64})\] /m.exec(lines)

  if (commit && /\bgit\s+commit\b/.test(source)) {
    return { text: 'Created commit ' + commit[1]!.slice(0, 12), kind: 'success', key: 'commit' }
  }

  return { text: 'Command completed', kind: 'success' }
}
