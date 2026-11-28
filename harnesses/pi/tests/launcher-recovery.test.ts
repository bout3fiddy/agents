import assert from 'node:assert/strict'
import test from 'node:test'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { registerLauncherRecovery } from '../src/launcher-recovery.ts'
import type { LoadedRuntime } from '../src/runtime-version.ts'

type Handler = (event: { reason: string }, ctx: { mode: string }) => Promise<void> | void

// Each registration models one extension load. /reload registers a fresh copy in the same process.
function load(loaded: Partial<LoadedRuntime>) {
  const handlers = new Map<string, Handler>()
  const pi = {
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    registerCommand: () => {},
  } as unknown as ExtensionAPI
  registerLauncherRecovery(
    pi,
    async () => loaded as LoadedRuntime,
    () => false,
  )
  const emit = async (name: string, reason: string) => {
    await handlers.get(name)!({ reason }, { mode: 'tui' })
  }

  return emit
}

test('an early reload keeps the wrong-launcher update notice suppressed', async (t) => {
  const original = process.env.PI_SKIP_VERSION_CHECK
  t.after(() => {
    if (original === undefined) {
      delete process.env.PI_SKIP_VERSION_CHECK
    } else {
      process.env.PI_SKIP_VERSION_CHECK = original
    }
  })
  process.env.PI_SKIP_VERSION_CHECK = ''
  const wrong = { install: {}, launcherWarning: 'Not running the installed harness launcher' }
  const first = load(wrong as Partial<LoadedRuntime>)
  await first('session_start', 'startup')
  assert.equal(process.env.PI_SKIP_VERSION_CHECK, '1')

  // Pi's startup version check can still be pending when /reload tears the session down.
  await first('session_shutdown', 'reload')
  assert.equal(process.env.PI_SKIP_VERSION_CHECK, '1')
  const reloaded = load(wrong as Partial<LoadedRuntime>)
  await reloaded('session_start', 'reload')
  assert.equal(process.env.PI_SKIP_VERSION_CHECK, '1')

  // Any other shutdown restores the user's own setting, including an empty value.
  await reloaded('session_shutdown', 'new')
  assert.equal(process.env.PI_SKIP_VERSION_CHECK, '')

  // A correct launcher after reload also restores it.
  const again = load(wrong as Partial<LoadedRuntime>)
  await again('session_start', 'startup')
  await again('session_shutdown', 'reload')
  await load({})('session_start', 'reload')
  assert.equal(process.env.PI_SKIP_VERSION_CHECK, '')
})
