import assert from 'node:assert/strict'
import test from 'node:test'
import { roleNames, type RoleName } from '../src/contracts.ts'
import { rolePrompt } from '../src/roles.ts'

// These tests read the rendered system prompts that workers and the host actually receive, so a
// policy dropped from shared.md or from a repair-owning role fails here rather than in a live run.
// Whitespace is normalized so that rewrapping prose does not break them.
const heading = '## Escaped bugs'
const obligations = [
  'root cause',
  'missing observable or invariant',
  'fails before the fix and passes after',
  'sibling cases',
  'bounded seeded simulation',
  'Playwright journey',
  'failing seeds and schedules',
  'fault injection or a negative control',
  'infrastructure failure',
  'correct validation rejection',
  'capability or precondition gap to the host',
  'never weaken a test',
  'existing coverage',
  'justified exception',
  'no sleeps, network or dependencies',
  'before/after result',
]
const repairRoles: RoleName[] = [
  'orchestrator',
  'task-coordinator',
  'branch-orchestrator',
  'implementer',
]

function normalized(text: string): string {
  return text.replace(/\s+/g, ' ')
}

function policySection(prompt: string): string {
  const start = prompt.indexOf(heading)
  assert.ok(start >= 0, 'the policy heading is present')
  const end = prompt.indexOf('\n## ', start + heading.length)
  return prompt.slice(start, end < 0 ? undefined : end)
}

test('every rendered role prompt carries the escaped-bug policy exactly once', async () => {
  assert.ok(roleNames.length > repairRoles.length, 'the policy also reaches review roles')

  for (const name of roleNames) {
    const prompt = await rolePrompt(name)
    assert.equal(prompt.split(heading).length, 2, `${name}: one policy section`)
    const policy = normalized(policySection(prompt))

    for (const obligation of obligations) {
      assert.ok(policy.includes(obligation), `${name}: ${obligation}`)
    }
  }
})

test('repair-owning roles apply the policy to their own repair step', async () => {
  for (const name of repairRoles) {
    const prompt = await rolePrompt(name)
    const rules = prompt
      .replace(policySection(prompt), '')
      .split('\n\n')
      .map(normalized)
      .filter((paragraph) => paragraph.includes('escaped-bug policy'))
    assert.equal(rules.length, 1, `${name}: one role-specific repair rule`)
    const [rule] = rules as [string]
    assert.match(rule, /before the fix|against the original code/, `${name}: fail-before evidence`)
    assert.match(rule, /existing test/, `${name}: adequate existing coverage is recorded`)
    assert.match(rule, /evidence/, `${name}: the outcome reaches the result or handoff`)
  }
})
