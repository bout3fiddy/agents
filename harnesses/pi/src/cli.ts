import { access, realpath, mkdtemp, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { JobStore, jobView } from './job-store.ts'
import { StateStore } from './state.ts'
import { roleNames } from './contracts.ts'
import { loadRole, rolePrompt } from './roles.ts'
import { harnessRoot, loadProject } from './project.ts'
import { runSandboxed } from './sandbox.ts'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  recordTrustDecision,
  resolveExecution,
  trustRegistryPath,
  type TrustDecision,
} from './worker-execution.ts'

/** Show or record the user's execution decision for one project. Host only: the registry sits in
 * the private agent directory, which isolated worker commands can neither read nor write. */
export async function trust(root: string, decision?: string) {
  const execution =
    decision === undefined
      ? await resolveExecution(root)
      : await recordTrustDecision(root, decision as TrustDecision | 'unknown')
  return { project: root, registry: trustRegistryPath(), execution }
}

export async function doctor(agentDir = join(homedir(), '.pi', 'agent')) {
  const roles = await Promise.all(
    roleNames.map(async (name) => ({
      ...(await loadRole(name)),
      promptBytes: (await rolePrompt(name)).length,
    })),
  )
  await access(join(agentDir, 'harness-install.json'))
  const models = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: join(agentDir, 'models.json'),
    modelsStorePath: join(agentDir, 'models-store.json'),
  })
  const available = (await models.getAvailable('openai-codex')).map(
    (model) => `${model.provider}/${model.id}`,
  )
  const claudeBin = process.env.PI_HARNESS_CLAUDE_BIN ?? 'claude'
  const claudeVersion = await promisify(execFile)(claudeBin, ['--version'])
  const claudeStatus = await promisify(execFile)(claudeBin, ['auth', 'status'])
  const claudeLogin = JSON.parse(claudeStatus.stdout) as { loggedIn: boolean; authMethod: string }
  const workspace = await mkdtemp(join(tmpdir(), 'pi-doctor-'))

  try {
    const sandbox = await runSandboxed(workspace, ['node', '-e', 'console.log("sandbox ready")'])

    if (sandbox.exitCode !== 0) {
      throw new Error(`Sandbox unavailable: ${sandbox.output}`)
    }

    return {
      source: harnessRoot,
      agentDir,
      roles,
      configuredCodexModels: available,
      sandbox: 'ready',
      claude: {
        version: claudeVersion.stdout.trim(),
        loggedIn: claudeLogin.loggedIn,
        authMethod: claudeLogin.authMethod,
      },
    }
  } finally {
    await rm(workspace, { recursive: true, force: true })
    await models.settleCredentialWrites()
  }
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [command = 'status', argument] = process.argv.slice(2)
  const store = new StateStore(await realpath(process.cwd()))

  switch (command) {
    case 'doctor':
      console.log(JSON.stringify(await doctor(argument), null, 2))
      break
    case 'trust':
      if (process.argv.length > 4) {
        throw new Error('From the project root: trust [trusted-local|required-isolation|unknown]')
      }

      console.log(JSON.stringify(await trust(store.projectRoot, argument), null, 2))
      break
    case 'status': {
      const jobs = JobStore.open(store.projectRoot)
      console.log(
        JSON.stringify(
          {
            jobs: jobs.list({ limit: 30 }).map(jobView),
            project: await loadProject(store.projectRoot),
            state: jobs.directory,
          },
          null,
          2,
        ),
      )
      break
    }
    default:
      throw new Error('Commands: doctor, status, trust [trusted-local|required-isolation|unknown]')
  }
}
