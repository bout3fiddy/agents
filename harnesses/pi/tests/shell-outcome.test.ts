import assert from 'node:assert/strict'
import test from 'node:test'
import { describeShell, shellOutcome } from '../src/shell-outcome.ts'

test('PR calls use one identity across fetch, worktree, dry run and publication', () => {
  const commands = [
    'git fetch origin refs/pull/61/head; git merge-tree --write-tree base head',
    'git worktree add -q --detach "$w" head; echo "$w" >/tmp/acme-pr61-active-worktree',
    'w=$(cat /tmp/acme-pr61-active-worktree); npm run check -- --dry-run',
    'gh pr merge 61 --repo team/project --squash; gh pr view 61 --json state',
  ]
  assert.deepEqual(
    commands.map((cmd) => describeShell(cmd).operation?.key),
    Array(4).fill('pr:61'),
  )
  assert.equal(describeShell(commands[3]!).operation?.repository, 'team/project')
  assert.equal(describeShell('gh api repos/team/project/pulls/61').operation?.title, 'PR #61')
  assert.equal(describeShell('gh pr view 61; gh pr view 62').operation, undefined)
  assert.equal(describeShell('echo 61').operation, undefined)
})

test('one compound-command exit never proves later effects', () => {
  const cmd = 'set -eu; npm run check; git push; gh pr merge 61; gh pr view 61 --json state'
  assert.match(
    shellOutcome(cmd, 'lint passed\n\nCommand exited with code 1', true).text,
    /PR merge unconfirmed · exit 1/,
  )
  assert.equal(shellOutcome(cmd, 'lint passed', false).text, 'Command completed')
  assert.equal(shellOutcome(cmd, 'pushed\n{\n  "state": "MERGED"\n}', false).text, 'PR merged')
  assert.equal(
    shellOutcome(cmd + '; cat receipt', '{"state":"MERGED"}', false).text,
    'Command completed',
  )
  assert.equal(
    shellOutcome('git commit -m done; cat log', '[main abcdef0] done\n', false).text,
    'Created commit abcdef0',
  )
})

test('preserve bounded conflict and distinguish preview and actual test receipts', () => {
  const raw = 'Auto-merging README.md\nCONFLICT (content): Merge conflict in AGENTS.md'
  const error = shellOutcome(
    'git merge-tree HEAD other',
    raw + '\nCommand exited with code 1',
    true,
  )
  assert.equal(error.kind, 'error')
  assert.equal(error.text, 'Merge conflict in AGENTS.md')
  assert.equal(shellOutcome('cat old.log', raw, false).key, undefined)
  const selected = 'check: 19 changed file(s) since 630de0 → no tests'
  assert.equal(
    shellOutcome('npm run check -- --dry-run', selected, false).text,
    'Dry run · 19 changed files · no tests selected',
  )
  const result = shellOutcome('node --test', 'ℹ pass 5\nℹ fail 0\nℹ skipped 1', false)
  assert.equal(result.text, '5 tests passed · 1 skipped')
  assert.equal(shellOutcome('cat test.log', 'ℹ pass 5\nℹ fail 0', false).key, undefined)
})

test('large or hostile output stays in details; timeouts and cancellation remain distinct', () => {
  const escape = String.fromCharCode(27)
  const result = shellOutcome(
    'git merge feat',
    escape + '[31mCONFLICT (content): Merge conflict in A.md' + escape + '[0m',
    true,
  )
  assert.equal(result.text, 'Merge conflict in A.md')
  const echoed = 'secret-value-'.repeat(20000)
  const timed = shellOutcome('npm test', echoed + '\nCommand timed out after 60 seconds', true)
  assert.equal(timed.text, 'Command timed out after 60s')
  assert.equal(shellOutcome('npm test', 'Command aborted', true).text, 'Command cancelled')
  assert.equal(shellOutcome('run', echoed, true).text, 'Command failed')
  assert.equal(describeShell("printf 'secret-value'").purpose, 'Run shell command')
})

test('local inspections and check retries group conservatively', () => {
  assert.deepEqual(
    describeShell('git status --short').operation,
    describeShell('git diff').operation,
  )
  assert.equal(describeShell('git diff').operation?.key, 'git:inspect')
  assert.equal(describeShell('npm run check -- --dry-run').operation?.key, 'gate:check')
  assert.equal(describeShell('pnpm check').operation?.key, 'gate:check')
  assert.equal(describeShell('cd other; npm test').operation, undefined)
  assert.equal(describeShell('git -C other status').operation, undefined)
  assert.equal(shellOutcome('git status --porcelain', '', false).text, 'No changes reported')
  assert.equal(
    shellOutcome('gh api repos/team/project/issues/61', '{"state":"open"}', false).key,
    undefined,
  )
})

test('common blockers give specific receipts without echoing raw errors', () => {
  const footer = '\nCommand exited with code 128'
  const fatal = 'fatal: not a git repository (or any of the parent directories): .git'
  assert.equal(
    shellOutcome('git status', fatal + footer, true).text,
    'Outside a Git repository · exit 128',
  )
  const denied = "fatal: Authentication failed for 'https://user:secret@example.com/'"
  assert.equal(
    shellOutcome('git push; gh pr merge 61', denied + footer, true).text,
    'Authentication required · exit 128',
  )
  const node = 'not ok 1 - secret fixture\n# pass 4\n# fail 1\nCommand exited with code 1'
  assert.deepEqual(shellOutcome('node --test', node, true), {
    kind: 'error',
    text: '4 tests passed · 1 failed',
    key: 'tests',
  })
  const py = '=== 2 failed, 5 passed in 0.04s ===\nCommand exited with code 1'
  assert.equal(shellOutcome('pytest', py, true).text, '2 tests failed')
  assert.equal(
    shellOutcome('go test ./...', '--- FAIL: private token fixture', true).text,
    'Test failure reported',
  )
})

test('inspection outcomes distinguish paths, search output, and porcelain entries', () => {
  assert.equal(
    describeShell('git merge --no-commit refs/pull/61/head # worktree').purpose,
    'Merge changes',
  )
  assert.equal(describeShell('pwd').purpose, 'Inspect working directory')
  assert.equal(
    shellOutcome('pwd', '/private/secret/project\n', false).text,
    'Working directory reported',
  )
  assert.equal(
    shellOutcome('rg words', 'secret\nother secret\n', false).text,
    '2 lines of search output',
  )
  assert.equal(shellOutcome('rg words', 'Command exited with code 1', true).kind, 'notice')
  assert.equal(shellOutcome('rg words; false', 'Command exited with code 1', true).kind, 'error')
  assert.equal(
    shellOutcome('git status --short', ' M private.md\n?? new', false).text,
    '2 status entries',
  )
  assert.equal(shellOutcome('git status --short', '## main\n M file', false).text, '1 status entry')
  assert.equal(shellOutcome('git status --short; false', ' M test', true).text, 'Command failed')
})
