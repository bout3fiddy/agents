import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitCommand, resolveRemote } from '../src/git-branches.ts'

export const branchDesign = `# Independent utility improvements

These decisions are settled. Implement both tasks autonomously, with independent engineering
review, meaningful deterministic tests and serialized integration to main. No user choices remain.
Use only the scoped source and test files. Leave this design and harness configuration unchanged.
Use dependency-free JavaScript and Node's built-in test runner. Keep implementation straightforward.

## Clamp

Export clamp(value, minimum, maximum) from src/clamp.mjs. All three arguments must be finite
JavaScript numbers; otherwise throw TypeError. If minimum exceeds maximum, throw RangeError.
For valid inputs, return the value bounded by the inclusive minimum and maximum. Never mutate
state or perform I/O. The task owns src/clamp.mjs and test/clamp.test.mjs.

Test invalid inputs and inverted bounds, equal bounds, boundary values, negative and fractional
numbers. Add deterministic property tests for boundedness, monotonicity and idempotence over
diverse inputs. Tests should exercise public behavior and catch missing validation.

## Stable unique integers

Export stableUnique(values, limit = 4096) from src/unique.mjs. Require an Array containing only
safe integers; otherwise throw TypeError. Require limit to be a safe integer between 0 and 4096
inclusive; otherwise throw RangeError. If the input array length exceeds limit, throw RangeError.
Return a new array containing each value once in first-occurrence order. Preserve the input.
Do not recurse or perform I/O. Treat positive and negative zero as the same integer and return
positive zero. The task owns src/unique.mjs and test/unique.test.mjs.

Test invalid items and limits, empty input, exact capacity and overflow, stable order, duplicates,
zero normalization and input preservation. Add deterministic property tests for uniqueness,
idempotence and first-occurrence ordering, comparing against a simple independent reference.

## Integration

Both tasks are independent and may execute in parallel. Use Astra implementers and Fable
engineering reviewers. No database or benchmark work is needed. Each branch must pass the full
required Node test suite and a passing review on its exact final candidate. After another branch
lands, update against current main and refresh tests and review before merging. Commit and push
each separate branch and merge each to main one at a time. The original checkout stays untouched.
`

const baselineFiles: Record<string, string> = {
  'src/clamp.mjs':
    'export function clamp(value, minimum, maximum) {\n' +
    '  return Math.min(maximum, Math.max(minimum, value))\n}\n',
  'src/unique.mjs': 'export function stableUnique(values) {\n  return [...new Set(values)]\n}\n',
  'test/clamp.test.mjs':
    "import assert from 'node:assert/strict'\nimport test from 'node:test'\n" +
    "import { clamp } from '../src/clamp.mjs'\n\n" +
    "test('clamp includes the bounds and preserves interior values', () => {\n" +
    '  assert.equal(clamp(-1, 0, 10), 0)\n  assert.equal(clamp(5, 0, 10), 5)\n' +
    '  assert.equal(clamp(11, 0, 10), 10)\n})\n',
  'test/unique.test.mjs':
    "import assert from 'node:assert/strict'\nimport test from 'node:test'\n" +
    "import { stableUnique } from '../src/unique.mjs'\n\n" +
    "test('stable unique integers retain their first occurrence', () => {\n" +
    '  const values = [3, 1, 3, 2, 1]\n' +
    '  assert.deepEqual(stableUnique(values), [3, 1, 2])\n' +
    '  assert.deepEqual(values, [3, 1, 3, 2, 1])\n})\n',
}

export async function branchFixture(github?: string) {
  if (github && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(github)) {
    throw new Error('Use --github OWNER/REPO for an existing empty fixture repository')
  }

  const directory = await mkdtemp(join(tmpdir(), 'pi-live-branches-'))
  const root = join(directory, 'project')
  await mkdir(root)
  const remote = github ? `https://github.com/${github}.git` : join(directory, 'remote.git')

  if (!github) {
    await gitCommand(directory, ['init', '--bare', remote])
  }

  await gitCommand(root, ['init', '-b', 'main'])
  await gitCommand(root, ['config', 'user.name', 'Pi harness validation'])
  await gitCommand(root, ['config', 'user.email', 'pi-harness@example.invalid'])
  await gitCommand(root, ['remote', 'add', 'origin', remote])

  if (await gitCommand(root, ['ls-remote', '--heads', 'origin'])) {
    throw new Error('The live GitHub fixture must be empty; existing branches are preserved')
  }

  for (const path of ['src', 'test', '.pi']) {
    await mkdir(join(root, path))
  }

  for (const [path, content] of Object.entries(baselineFiles)) {
    await writeFile(join(root, path), content)
  }

  await writeFile(join(root, 'DESIGN.md'), branchDesign)
  await writeFile(join(root, '.pi/.gitignore'), '/traces/\n')
  await writeFile(
    join(root, '.pi/harness.json'),
    JSON.stringify(
      {
        checks: [
          {
            id: 'behavior',
            kind: 'test',
            required: true,
            argv: ['node', '--test', 'test/clamp.test.mjs', 'test/unique.test.mjs'],
            timeoutMs: 30000,
          },
        ],
      },
      null,
      2,
    ) + '\n',
  )

  if (github) {
    await mkdir(join(root, '.github/workflows'), { recursive: true })
    await writeFile(
      join(root, '.github/workflows/ci.yml'),
      [
        'name: branch-tests',
        'on: [push, pull_request]',
        'permissions:',
        '  contents: read',
        'jobs:',
        '  behavior:',
        '    runs-on: ubuntu-latest',
        '    steps:',
        '      - uses: actions/checkout@v4',
        '      - uses: actions/setup-node@v4',
        '        with:',
        '          node-version: 26',
        '      - run: node --test test/clamp.test.mjs test/unique.test.mjs',
        '',
      ].join('\n'),
    )
  }

  await gitCommand(root, ['add', '.'])
  await gitCommand(root, ['commit', '-m', 'Seed independent branch workflow fixture'])
  await gitCommand(root, ['push', 'origin', 'HEAD:main'])
  const pinned = await resolveRemote(root)
  return { directory, root, remote, github, pinned, baselineFiles }
}
