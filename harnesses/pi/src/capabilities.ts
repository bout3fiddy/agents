import { Type } from 'typebox'

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
      'Repository setup',
      'Dependency installation and lockfiles',
      'Git publication',
      'Project check configuration',
      'Contextual document edits',
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
    shell: 'Disposable project copies. No network, host-home access or retained shell writes.',
    writes: 'Scoped file tools: project_edit for focused edits; project_write for new/full files.',
    dependencies:
      'Existing dependencies are readable. Installation and lockfile generation need host.',
    git: 'No Git metadata or publication. Branch mode has a separate host-managed Git workflow.',
    failure:
      'Report unavailable host capabilities immediately; repeating workers cannot supply them.',
  },
  routing:
    'Use context, complexity and risk. Routine setup may stay on the host with executable ' +
    'checks. Delegate substantial implementation, explicit requests, or work that disrupts the ' +
    'current discussion. Use the performance specialist on explicit request.',
}
