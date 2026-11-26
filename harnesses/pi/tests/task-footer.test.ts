import assert from 'node:assert/strict'
import { realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import type { ExtensionUIContext } from '@earendil-works/pi-coding-agent'
import { Delegations, delegationDirectory } from '../src/delegation-state.ts'
import { registerDelegation } from '../src/delegation-tools.ts'
import { atomicJson, StateStore } from '../src/state.ts'
import { WorkerRoots } from '../src/worker-roots.ts'
import { captureSession } from './session-support.ts'
import { fixture } from './support.ts'

const start = (store: StateStore, originRoot: string, session: string) =>
  new Delegations(store).start(
    { kind: 'research', context: '', task: 'Inspect footer', writePaths: [] },
    { originRoot, session, model: 'capture/capture' },
    async () => {},
  )

test('SDK footer includes only validated active external tasks for this session', async (t) => {
  const host = await fixture()
  const target = await fixture()
  const localStore = new StateStore(host.root)
  const remoteStore = new StateStore(target.root)
  let turns = 0
  const { session, runtime } = await captureSession(
    host.root,
    host.base,
    [
      (pi) => {
        registerDelegation(pi)
      },
    ],
    async () => {
      turns++
      return [{ type: 'text', text: 'Done' }]
    },
  )
  const previous = process.env.PI_HARNESS_AGENT_DIR
  process.env.PI_HARNESS_AGENT_DIR = join(await realpath(host.base), 'agent')
  t.after(async () => {
    await session.dispose()
    await runtime.settleCredentialWrites()

    if (previous === undefined) {
      delete process.env.PI_HARNESS_AGENT_DIR
    } else {
      process.env.PI_HARNESS_AGENT_DIR = previous
    }

    await rm(target.base, { recursive: true, force: true })
    await rm(host.base, { recursive: true, force: true })
  })
  const statuses: (string | undefined)[] = []
  const ui = {
    setStatus(key: string, value?: string) {
      if (key === 'pi-tasks') {
        statuses.push(value)
      }
    },
  } as ExtensionUIContext
  await session.bindExtensions({ mode: 'tui', uiContext: ui })
  const owner = session.sessionManager.getSessionId()
  const local = await start(localStore, host.root, 'other-session')
  const remote = await start(remoteStore, host.root, owner)
  await start(remoteStore, host.root, 'other-session')
  const roots = new WorkerRoots(localStore)
  const [entry, other] = await roots.entries()
  assert.ok(entry && other)
  await atomicJson(roots.path, [null, { ...other, session: owner }, other, entry, entry])
  const directory = delegationDirectory(remoteStore, remote.state.id)
  const statusPath = join(directory, 'status.json')
  await atomicJson(statusPath, { ...remote.state, status: 'running', progressFile: 'attempt.json' })
  await atomicJson(join(directory, 'attempt.json.progress.json'), {
    role: 'implementer',
    stage: 'child',
    child: { tool: 'project_read' },
  })
  const refresh = async (expected: string) => {
    statuses.length = 0
    const before = turns
    await session.prompt('Continue the discussion.')
    assert.ok(statuses.length, 'The SDK must publish a fresh task footer')
    assert.equal(statuses.at(-1), expected)
    assert.equal(turns, before + 1, 'A display-only task must not trigger another turn')
  }
  const localLine = `Tasks · ${local.state.id.slice(0, 6)} queued/starting`
  await refresh(`${localLine} · ${remote.state.id.slice(0, 6)} implementer/project_read`)
  await atomicJson(roots.path, { invalid: true })
  await refresh(localLine)
  await atomicJson(roots.path, [entry])
  await refresh(`${localLine} · ${remote.state.id.slice(0, 6)} implementer/project_read`)
  await atomicJson(statusPath, { ...remote.state, status: 'complete' })
  await refresh(localLine)
  assert.ok(
    !session.sessionManager
      .getEntries()
      .some((item) => item.type === 'custom_message' && item.customType === 'pi-task-result'),
  )
})
