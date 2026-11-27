import { access, chmod, cp, mkdir, realpath, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { atomicJson, readJson } from '../src/state.ts'
import { harnessRoot } from '../src/project.ts'
import { loadRole, rolePrompt } from '../src/roles.ts'
import { captureBuild } from '../src/runtime-version.ts'
import { piPackage, shellQuote } from '../src/pi-host.ts'

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function install(agentDir = join(homedir(), '.pi', 'agent'), binDir?: string) {
  const destination = resolve(agentDir)
  const backup = join(
    dirname(destination),
    'harness-backups',
    new Date().toISOString().replaceAll(':', '-'),
  )
  await mkdir(destination, { recursive: true, mode: 0o700 })
  await mkdir(backup, { recursive: true, mode: 0o700 })

  for (const name of ['AGENTS.md', 'SYSTEM.md', 'settings.json']) {
    if (await exists(join(destination, name))) {
      await cp(join(destination, name), join(backup, name), { preserveTimestamps: true })
    }
  }

  // Old auto-discovered prompts/skills/extensions are archived, not merged into the new policy.
  for (const name of ['skills', 'extensions', 'prompts']) {
    if (await exists(join(destination, name))) {
      await rename(join(destination, name), join(backup, name))
    }
  }

  const settings =
    (await readJson<Record<string, unknown>>(join(destination, 'settings.json'))) ?? {}
  const role = await loadRole('orchestrator')
  await atomicJson(join(destination, 'settings.json'), {
    ...settings,
    defaultProvider: settings.defaultProvider ?? 'openai-codex',
    defaultModel: settings.defaultModel ?? 'gpt-6.2-astra',
    defaultThinkingLevel: settings.defaultThinkingLevel ?? 'medium',
    hideThinkingBlock: true,
    steeringMode: settings.steeringMode ?? 'all',
    defaultProjectTrust: 'never',
    enableSkillCommands: false,
    extensions: [
      join(harnessRoot, 'src', 'extension.ts'),
      '-builtin:mcp',
      '-builtin:codemode',
      '-builtin:tool-search',
      '-builtin:llama.cpp',
    ],
    packages: [],
    skills: [],
    prompts: [],
    defaultTools: role.tools,
  })
  await writeFile(join(destination, 'SYSTEM.md'), await rolePrompt('orchestrator'))
  await writeFile(
    join(destination, 'AGENTS.md'),
    [
      '# Pi harness',
      '',
      `Canonical source: ${harnessRoot}`,
      'Workshop designs with Codex and parallel Fable advice.',
      'Handle fresh repository bootstrap and direct saves of small settled decisions on the host.',
      'Delegate design reorganizations, product documentation, implementation, tests and repairs.',
      'Read applicable repository AGENTS.md files through project_read.',
      'Call workflow with a settled design when implementation is requested; ' +
        'no acceptance command.',
      '',
    ].join('\n'),
  )
  const wrapperDir = resolve(binDir ?? join(destination, 'bin'))
  await mkdir(wrapperDir, { recursive: true })
  const wrapper = join(wrapperDir, 'pi-harness')
  const cli = join(harnessRoot, 'node_modules', piPackage, 'dist', 'cli.js')
  const entry = await realpath(cli)
  const loader = pathToFileURL(join(harnessRoot, 'src/launcher-ui.ts')).href
  const command = [
    shellQuote(process.execPath),
    '--import',
    shellQuote(loader),
    shellQuote(cli),
    '--no-extensions',
    '--extension',
    shellQuote(join(harnessRoot, 'src', 'extension.ts')),
    '--no-skills',
    '--no-prompt-templates',
    '--no-context-files',
    '--no-mcp',
    '--no-approve',
    '--session-dir',
    '"$PWD/.pi/traces/sessions"',
    '"$@"',
  ].join(' ')

  // `pi update` manages a global install; the harness's own Pi updates through this subcommand.
  const update = [
    shellQuote(process.execPath),
    '--import',
    shellQuote(join(harnessRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')),
    shellQuote(join(harnessRoot, 'scripts', 'update-pi.ts')),
    '"$@"',
  ].join(' ')
  await writeFile(
    wrapper,
    `#!/bin/sh\nexport PI_CODING_AGENT_DIR=${shellQuote(destination)}\n` +
      `export PI_HARNESS_AGENT_DIR=${shellQuote(destination)}\n` +
      `if [ "$1" = update ]; then\n  shift\n  exec ${update}\nfi\n` +
      `export PI_HARNESS_LAUNCH_WRAPPER=${shellQuote(wrapper)}\n` +
      `exec ${command}\n`,
  )
  await chmod(wrapper, 0o755)
  const build = captureBuild(harnessRoot)
  await atomicJson(join(destination, 'harness-install.json'), {
    source: harnessRoot,
    installedAt: new Date().toISOString(),
    backup,
    wrapper,
    pi: { version: build.piPin, entry },
    version: build.version,
    revision: build.revision,
    sourceHash: build.sourceHash,
  })
  return { destination, backup, wrapper }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const agentDir = process.argv[2]
  console.log(JSON.stringify(await install(agentDir), null, 2))
}
