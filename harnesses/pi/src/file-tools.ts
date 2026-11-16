import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { instructions } from './project.ts'
import { inventory, safePath, writable, readBoundedFile } from './paths.ts'

export function textResult(value: unknown) {
  return {
    content: [
      { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) },
    ],
    details: {},
  }
}

export function fileTools(
  root: string,
  scopes?: string[],
  roleScopes?: string[],
): ToolDefinition[] {
  const read: ToolDefinition = {
    name: 'project_read',
    label: 'Read project file',
    description:
      'Read a project file and its folder instructions; private paths ' + 'are excluded.',
    parameters: Type.Object({
      path: Type.String(),
      startLine: Type.Optional(Type.Integer({ minimum: 1 })),
      lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
    }),
    async execute(id, raw) {
      const args = raw as { path: string; startLine?: number; lines?: number }
      const content = (await readBoundedFile(await safePath(root, args.path))).toString('utf8')
      const start = (args.startLine ?? 1) - 1
      const excerpt = content
        .split('\n')
        .slice(start, start + (args.lines ?? 160))
        .map((line, index) => `${start + index + 1}: ${line}`)
        .join('\n')
      return textResult({
        instructions: await instructions(root, [args.path]),
        content: excerpt.slice(0, 24000),
        call: id,
      })
    },
  }
  const search: ToolDefinition = {
    name: 'project_search',
    label: 'Search project',
    description:
      'List project files or find literal text in authored files. ' + 'Returns bounded matches.',
    parameters: Type.Object({ query: Type.Optional(Type.String({ maxLength: 300 })) }),
    async execute(id, raw) {
      const { query } = raw as { query?: string }
      const matches: string[] = []

      for (const [path, bytes] of await inventory(root)) {
        if (!query) {
          matches.push(path)
        } else if (!bytes.includes(0)) {
          for (const [index, line] of bytes.toString('utf8').split('\n').entries()) {
            if (line.includes(query)) {
              matches.push(`${path}:${index + 1}: ${line.slice(0, 400)}`)
            }

            if (matches.length >= 100) {
              break
            }
          }
        }

        if (matches.length >= 100) {
          break
        }
      }

      return textResult({ matches, limit: 100, call: id })
    },
  }
  const tools = [read, search]

  if (scopes && roleScopes) {
    tools.push({
      name: 'project_write',
      label: 'Write assigned file',
      description: 'Replace an assigned file. Read its instructions and contents first.',
      parameters: Type.Object({ path: Type.String(), content: Type.String({ maxLength: 200000 }) }),
      async execute(id, raw) {
        const { path, content } = raw as { path: string; content: string }

        if (!writable(path, scopes) || !writable(path, roleScopes)) {
          throw new Error('Path is outside this worker assignment')
        }

        const target = await safePath(root, path)
        const rules = await instructions(root, [path])
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, content)
        return textResult({ written: path, instructions: rules, call: id })
      },
    })
    tools.push({
      name: 'project_delete',
      label: 'Delete assigned file',
      description: 'Delete one assigned file after reading it. Directories cannot be deleted.',
      parameters: Type.Object({ path: Type.String() }),
      async execute(id, raw) {
        const { path } = raw as { path: string }

        if (!writable(path, scopes) || !writable(path, roleScopes)) {
          throw new Error('Path is outside this worker assignment')
        }

        await unlink(await safePath(root, path))
        return textResult({ deleted: path, call: id })
      },
    })
  }

  return tools
}
