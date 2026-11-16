import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { harnessRoot } from './project.ts'
import { roleNames, type Role, type RoleName } from './contracts.ts'
import { validateScope } from './paths.ts'

export async function loadRole(name: RoleName): Promise<Role> {
  if (!roleNames.includes(name)) {
    throw new Error('Unknown role')
  }

  const role = JSON.parse(
    await readFile(join(harnessRoot, 'roles', `${name}.json`), 'utf8'),
  ) as Role

  if (
    !['pi', 'claude-cli'].includes(role.backend) ||
    role.name !== name ||
    role.prompt !== `${name}.md` ||
    role.mayDelegate !== (name === 'orchestrator') ||
    !Array.isArray(role.tools) ||
    !Array.isArray(role.skills) ||
    !Array.isArray(role.writes) ||
    !Number.isSafeInteger(role.maxTurns) ||
    role.maxTurns < 1 ||
    role.maxTurns > 100 ||
    !Number.isSafeInteger(role.timeoutMs) ||
    role.timeoutMs < 1000 ||
    role.timeoutMs > 1800000
  ) {
    throw new Error(`Invalid role definition: ${name}`)
  }

  validateScope(role.writes)
  return role
}

export async function rolePrompt(name: RoleName): Promise<string> {
  const role = await loadRole(name)
  const parts = await Promise.all([readFile(join(harnessRoot, 'prompts', 'shared.md'), 'utf8')])

  for (const skill of role.skills) {
    if (!['performance-engineering', 'housekeeping', 'zig'].includes(skill)) {
      throw new Error('Unapproved skill in role')
    }

    parts.push(await readFile(join(harnessRoot, '..', '..', 'skills', skill, 'SKILL.md'), 'utf8'))
  }

  parts.push(await readFile(join(harnessRoot, 'prompts', role.prompt), 'utf8'))
  return parts.join('\n\n')
}
