import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { routeClaude } from '../src/claude-routing.ts'
import { ProviderQuotaError } from '../src/contracts.ts'
import { loadRole } from '../src/roles.ts'
import { atomicJson } from '../src/state.ts'

test('Fable quota shares cooldown and restores preference after reset', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-quota-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const role = await loadRole('reviewer')
  const reset = Date.now() + 30000
  const calls: string[] = []
  const run = () =>
    routeClaude(
      role,
      async (selected) => {
        calls.push(selected.model)
        assert.deepEqual(selected, { ...role, model: selected.model })

        if (selected.model === role.model) {
          throw new ProviderQuotaError('usage', reset)
        }

        return selected.model
      },
      directory,
    )
  assert.equal(await run(), 'opus')
  assert.equal(await run(), 'opus')
  assert.deepEqual(calls, [role.model, 'opus', 'opus'])
  await assert.rejects(
    routeClaude(
      role,
      async () => {
        throw new ProviderQuotaError('opus limit', reset + 60000)
      },
      directory,
    ),
    (error) => error instanceof ProviderQuotaError && error.retryAt === reset,
  )
  await atomicJson(join(directory, 'quota', role.model + '.json'), { retryAt: Date.now() - 100 })
  assert.equal(await routeClaude(role, async (selected) => selected.model, directory), role.model)
  const fault = new Error('login required')
  await assert.rejects(
    routeClaude(
      role,
      async (selected) => {
        assert.equal(selected.model, role.model)
        throw fault
      },
      directory,
    ),
    (error) => error === fault,
  )
})
