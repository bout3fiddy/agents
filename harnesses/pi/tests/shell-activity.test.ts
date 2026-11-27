import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionManager } from '@earendil-works/pi-coding-agent'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { ShellActivity } from '../src/shell-activity.ts'

test('groups adjacent operations, separates repositories, preserves interleaved transcript', () => {
  const view = new ShellActivity()
  const first = view.add('inspect', 'gh pr view 23 --repo team/one')
  const fetch = view.add('fetch', 'git fetch origin refs/pull/23/head')
  assert.equal(fetch.group, first.group)
  assert.equal(view.add('fetch', 'git fetch origin refs/pull/23/head').call, fetch.call)
  assert.equal(first.group.calls.length, 2)
  const other = view.add('other', 'gh pr view 23 --repo team/two')
  assert.notEqual(other.group, first.group)
  view.observe({ role: 'user', content: 'Now inspect the other change.', timestamp: 1 })
  assert.notEqual(view.add('later', 'gh pr view 23 --repo team/two').group, other.group)
})

test('unknown commands only coalesce for exact retries', () => {
  const view = new ShellActivity()
  const first = view.add('a', 'pwd')
  assert.equal(view.add('b', 'pwd').group, first.group)
  assert.notEqual(view.add('c', 'whoami').group, first.group)
})

function assistant(content: AssistantMessage['content']): AssistantMessage {
  return {
    role: 'assistant',
    provider: 'fixture',
    api: 'openai-completions',
    model: 'fixture',
    content,
    stopReason: 'toolUse',
    timestamp: 1,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  }
}

test('replay restores observed blockers, missing receipts and active-branch boundaries', () => {
  const session = SessionManager.inMemory()
  const bash = (id: string) => ({
    type: 'toolCall' as const,
    id,
    name: 'bash',
    arguments: { command: 'git merge refs/pull/61/head' },
  })
  const before = session.appendMessage(assistant([bash('a')]))
  session.appendMessage({
    role: 'toolResult',
    toolName: 'bash',
    toolCallId: 'a',
    isError: true,
    timestamp: 2,
    content: [{ type: 'text', text: 'CONFLICT (content): Merge conflict in notes.md' }],
  })
  session.appendMessage(assistant([bash('b'), { ...bash('read'), name: 'read' }, bash('c')]))
  session.appendMessage(assistant([{ type: 'text', text: 'Separate attempt' }, bash('d')]))
  const view = new ShellActivity()
  view.replay(session.getBranch())
  assert.equal(view.find('a')?.call.outcome?.text, 'Merge conflict in notes.md')
  assert.equal(view.find('b')?.call.outcome?.text, 'No result recorded')
  assert.equal(view.find('a')?.group, view.find('b')?.group)
  assert.notEqual(view.find('b')?.group, view.find('c')?.group)
  assert.notEqual(view.find('c')?.group, view.find('d')?.group)
  view.replay(session.getBranch(before))
  assert.equal(view.find('a')?.call.outcome?.text, 'No result recorded')
  assert.equal(view.find('b'), undefined)
})
