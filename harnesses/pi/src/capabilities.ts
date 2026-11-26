import { Type } from 'typebox'
import type { ExecutionMode } from './worker-execution.ts'

export const hostCapability = Type.Union([
  Type.Literal('dependencies'),
  Type.Literal('git'),
  Type.Literal('network'),
  Type.Literal('project-policy'),
])

export const capabilities = {
  host: {
    shell: 'Normal host shell, filesystem, network and existing authenticated CLIs.',
    tasks: [
      'Fresh repository bootstrap, including starter README, ignore files and formatting manifest',
      'Dependency installation and lockfiles',
      'Git publication',
      'Project check configuration',
      'Small workshop decision capture and private scratch',
      'Tiger Style customization, verification and authorized integration',
      'Recovery of retained candidates',
      'Pause, inspect, revise and resume independent tasks',
    ],
    localImplementation:
      'workflow and delegate_task implementation share one checkpoint and require exclusive ' +
      'local writes. Use delegate_local for local candidates on the current commit or ' +
      'delegate_branches for remote builds with a committed design ' +
      'and executable checks. Read-only research can run alongside a local implementation.',
    authority: 'Only actions authorized by the user; a worker request never grants new permission.',
  },
  workers: {
    shell:
      'Disposable project copies without retained shell writes. Sandboxed with no network or ' +
      'host-home access unless the user enrolled the project as trusted-local; then commands ' +
      "run as normal local commands with the user's authority.",
    writes: 'Scoped file tools: project_edit for focused edits; project_write for new/full files.',
    dependencies:
      'Existing dependencies are readable. Installation and lockfile generation need host.',
    git: 'No Git metadata or publication. Branch mode has a separate host-managed Git workflow.',
    failure:
      'Report unavailable host capabilities immediately; repeating workers cannot supply them.',
  },
  execution:
    'The user decides per project how worker commands run: trusted-local (normal local ' +
    'commands in disposable copies), required-isolation, or isolated when no decision is ' +
    "recorded. Enrollment is a host action with the user's authorization: run the harness CLI " +
    'trust command from the project root. trusted-local is not containment: use it only for a ' +
    'checkout the user trusts. For one task whose input is external or untrusted, set ' +
    "isolation: 'required' on workflow, delegate_task, delegate_local, delegate_branches or a " +
    'recurring_task definition; it is stored with the task and applies to its children, ' +
    'checks, benchmarks, resumption and revision. Workers, project files, prompts and tool ' +
    'arguments cannot lift isolation, and a sandbox that cannot start never falls back to the ' +
    'host.',
  routing:
    'For a direct save of a small settled workshop decision, create or edit the requested ' +
    'design.md or design/design.md on the host and verify its contents before replying. ' +
    'Never delegate that save. Use tracked workers for design reorganizations, product ' +
    'documentation, implementation, tests and repairs. ' +
    'Send defects back to the writer; dispatch a scoped follow-up for closed tasks. Do not use ' +
    'host shell to bypass file routing. Use the performance specialist on explicit request.',
}

const trustedShell =
  'Normal local commands in disposable project copies: installed dependencies, loopback and ' +
  'network behave as in the trusted checkout. Shell writes are discarded with the copy.'
const isolatedShell =
  'Disposable project copies. No network, host-home access or retained shell writes.'

/** What a worker is told about its shell under the execution decision frozen at dispatch. The
 * host-facing text above describes both modes; a worker reads only the one it runs under. */
export function workerCapabilities(mode: ExecutionMode) {
  return { ...capabilities.workers, shell: mode === 'trusted-local' ? trustedShell : isolatedShell }
}
