import { Type } from 'typebox'
import type { ExecutionMode } from './worker-execution.ts'

export const hostCapability = Type.Union([
  Type.Literal('dependencies'),
  Type.Literal('git'),
  Type.Literal('network'),
  Type.Literal('project-policy'),
])

const workers = {
  writes: 'Scoped file tools: project_edit for focused edits; project_write for new/full files.',
  dependencies:
    'Existing dependencies are readable. Installation and lockfile generation need host.',
  git: 'No Git metadata or publication. The host commits and publishes verified results.',
  failure:
    'Report unavailable host capabilities immediately; repeating workers cannot supply them.',
}

const trustedShell =
  'Normal local commands in disposable project copies: installed dependencies, loopback and ' +
  'network behave as in the trusted checkout. Shell writes are discarded with the copy.'
const isolatedShell =
  'Disposable project copies. No network, host-home access or retained shell writes.'

/** What a worker is told about its shell under the execution decision frozen at dispatch. */
export function workerCapabilities(mode: ExecutionMode) {
  return { ...workers, shell: mode === 'trusted-local' ? trustedShell : isolatedShell }
}
