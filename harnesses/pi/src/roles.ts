import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { harnessRoot } from './project.ts'
import { Check } from 'typebox/value'
import {
  roleNames,
  thinkingSchema,
  specialistThinkingSchema,
  type ImplementerModel,
  type Role,
  type RoleName,
} from './contracts.ts'
import { validateScope } from './paths.ts'

export async function loadRole(
  name: string,
  thinking?: Role['thinking'],
  implementerModel?: ImplementerModel,
): Promise<Role> {
  if (!roleNames.some((active) => active === name)) {
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
    'maxTurns' in role ||
    'timeoutMs' in role
  ) {
    throw new Error(`Invalid role definition: ${name}`)
  }

  if (implementerModel !== undefined) {
    if (name !== 'implementer' || !['opus', 'fable'].includes(implementerModel)) {
      throw new Error('Claude implementation selection requires the implementer role')
    }

    role.backend = 'claude-cli'
    role.tools = role.tools.filter((tool) => tool !== 'codemode')
    role.model = implementerModel === 'opus' ? 'claude-opus-5-5' : 'claude-fable-5-2'
  }

  validateScope(role.writes)
  const levels = role.backend === 'claude-cli' ? specialistThinkingSchema : thinkingSchema
  const selected = thinking === undefined ? role.thinking : thinking

  if (!Check(levels, role.thinking) || !Check(levels, selected)) {
    throw new Error(
      `Unsupported thinking for ${name}; allowed: ${levels.anyOf.map((x) => x.const).join(', ')}`,
    )
  }

  return { ...role, thinking: selected }
}

export async function rolePrompt(name: RoleName): Promise<string> {
  const role = await loadRole(name)
  const parts = await Promise.all([readFile(join(harnessRoot, 'prompts', 'shared.md'), 'utf8')])

  if (role.backend === 'claude-cli') {
    parts.push(await readFile(join(harnessRoot, 'prompts', 'web-research.md'), 'utf8'))
  }

  for (const skill of role.skills) {
    if (!['performance-engineering', 'housekeeping', 'zig'].includes(skill)) {
      throw new Error('Unapproved skill in role')
    }

    parts.push(await readFile(join(harnessRoot, '..', '..', 'skills', skill, 'SKILL.md'), 'utf8'))
  }

  parts.push(await readFile(join(harnessRoot, 'prompts', role.prompt), 'utf8'))
  return parts.join('\n\n')
}
