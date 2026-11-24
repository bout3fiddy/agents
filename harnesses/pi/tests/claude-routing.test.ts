import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { quotaMaxAgeMs, routeClaude } from '../src/claude-routing.ts'
import { ProviderQuotaError } from '../src/contracts.ts'
import { loadRole } from '../src/roles.ts'
import { atomicJson } from '../src/state.ts'

test('Fable quota shares cooldown and restores preference after reset', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-quota-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const role = await loadRole('performance')
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

test('only a recent versioned confirmation authorizes a cached fallback', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-quota-reprobe-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const role = await loadRole('design-advisor')
  const path = join(directory, 'quota', role.model + '.json')
  const now = Date.UTC(2026, 10, 23)
  const retryAt = now + 86400000
  const receipt = { version: 1, confirmedAt: now, retryAt }
  const probe = () =>
    routeClaude(
      role,
      async (_, __, route) => route,
      directory,
      () => now,
    )

  for (const invalid of [
    { retryAt },
    { ...receipt, version: 2 },
    { ...receipt, confirmedAt: now - quotaMaxAgeMs },
    { ...receipt, confirmedAt: now + 1 },
    { ...receipt, retryAt: now },
    { ...receipt, retryAt: String(retryAt) },
    { ...receipt, retryAt: Number.MAX_SAFE_INTEGER },
    { ...receipt, confirmedAt: now - 0.5 },
    null,
  ]) {
    await atomicJson(path, invalid)
    assert.deepEqual(await probe(), { requestedModel: role.model, actualModel: role.model })
    await assert.rejects(readFile(path), { code: 'ENOENT' })
  }

  await writeFile(path, '{')
  assert.equal((await probe()).actualModel, role.model)
  const limit = new ProviderQuotaError('quota', retryAt)
  const confirmed = await routeClaude(
    role,
    async (selected, _, route) => {
      if (selected.model === role.model) {
        throw limit
      }

      return route
    },
    directory,
    () => now,
  )
  assert.deepEqual(confirmed, {
    requestedModel: role.model,
    actualModel: 'opus',
    fallbackReason: 'quota-confirmed',
    confirmedAt: now,
    retryAt,
  })
  assert.deepEqual(await probe(), { ...confirmed, fallbackReason: 'quota-cached' })
  const restored = await routeClaude(
    role,
    async (selected) => selected.model,
    directory,
    () => now + quotaMaxAgeMs,
  )
  assert.equal(restored, role.model)
  await assert.rejects(readFile(path), { code: 'ENOENT' })

  for (const invalidReset of [Infinity, NaN, retryAt + 0.25, now - 1]) {
    const invalid = new ProviderQuotaError('invalid reset', invalidReset)
    await assert.rejects(
      routeClaude(
        role,
        async (selected) => {
          assert.equal(selected.model, role.model)
          throw invalid
        },
        directory,
        () => now,
      ),
      (error) => error === invalid,
    )
  }
})

test('Fable writers retain effort and scope on quota fallback', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'pi-writer-quota-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const defaultRole = await loadRole('implementer')
  assert.equal(defaultRole.model, 'openai-codex/gpt-6.2-astra')

  for (const selection of ['fable', 'opus'] as const) {
    const role = await loadRole('implementer', 'high', selection)
    const model = selection === 'opus' ? 'claude-opus-5-5' : 'claude-fable-5-2'
    assert.deepEqual(role, {
      ...defaultRole,
      backend: 'claude-cli',
      model,
      thinking: 'high',
      tools: defaultRole.tools.filter((tool) => tool !== 'codemode'),
    })
    const attempts: string[] = []
    const limit = new ProviderQuotaError('quota', Date.now() + 60000)
    const run = () =>
      routeClaude(
        role,
        async (selected, retry) => {
          attempts.push(selected.model)
          assert.deepEqual(selected, { ...role, model: selected.model })

          if (selected.model === 'opus') {
            return retry
          }

          throw limit
        },
        directory,
      )

    if (selection === 'fable') {
      assert.equal(await run(), true)
      assert.equal(await run(), false)
      assert.deepEqual(attempts, [model, 'opus', 'opus'])
    } else {
      await assert.rejects(run(), (error) => error === limit)
      assert.deepEqual(attempts, [model])
    }

    await assert.rejects(loadRole('performance', 'medium', selection), /implementer role/)
    await assert.rejects(loadRole('implementer', 'low', selection), /Unsupported thinking/)
  }
})
