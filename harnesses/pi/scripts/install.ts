import { access, chmod, cp, mkdir, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { atomicJson, readJson } from '../src/state.ts'
import { harnessRoot } from '../src/project.ts'
import { loadRole, rolePrompt } from '../src/roles.ts'
import { captureBuild } from '../src/runtime-version.ts'

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

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
    defaultModel: settings.defaultModel ?? 'gpt-6.1-sol',
    defaultThinkingLevel: settings.defaultThinkingLevel ?? 'medium',
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
      'Workshop designs with Codex and parallel Fable advice; ' +
        'delegate requested or lengthy work in the background and keep quick edits local.',
      'Read applicable repository AGENTS.md files through project_read.',
      'Call workflow with a settled design when implementation is requested; ' +
        'no acceptance command.',
      '',
    ].join('\n'),
  )
  const wrapperDir = binDir ?? join(destination, 'bin')
  await mkdir(wrapperDir, { recursive: true })
  const wrapper = join(wrapperDir, 'pi-harness')
  const cli = join(
    harnessRoot,
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'dist',
    'cli.js',
  )
  await access(cli)
  const command = [
    shellQuote(process.execPath),
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
    '--tools',
    shellQuote(role.tools.join(',')),
    '"$@"',
  ].join(' ')
  await writeFile(
    wrapper,
    `#!/bin/sh\nexport PI_CODING_AGENT_DIR=${shellQuote(destination)}\n` +
      `export PI_HARNESS_AGENT_DIR=${shellQuote(destination)}\nexec ${command}\n`,
  )
  await chmod(wrapper, 0o755)
  const build = captureBuild(harnessRoot)
  await atomicJson(join(destination, 'harness-install.json'), {
    source: harnessRoot,
    installedAt: new Date().toISOString(),
    backup,
    wrapper,
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
