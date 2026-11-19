import { mkdir, writeFile, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Type, type Static } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { instructions } from './project.ts'
import { digest, inventory, maxFileBytes, safePath, writable, readBoundedFile } from './paths.ts'

export function textResult(value: unknown) {
  return {
    content: [
      { type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) },
    ],
    details: {},
  }
}

const replacement = Type.Object({
  oldText: Type.String({ minLength: 1, maxLength: 200000 }),
  newText: Type.String({ maxLength: 200000 }),
})

const editParameters = Type.Object({
  path: Type.String(),
  ...replacement.properties,
  additionalEdits: Type.Optional(Type.Array(replacement, { maxItems: 15 })),
})

const readParameters = Type.Object({
  path: Type.String(),
  startLine: Type.Optional(Type.Integer({ minimum: 1 })),
  startColumn: Type.Optional(Type.Integer({ minimum: 1 })),
  lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 300 })),
  reuseInstructions: Type.Optional(Type.Boolean()),
})

function readWindow(source: string, args: Static<typeof readParameters>) {
  const rows = source.split('\n')
  const start = (args.startLine ?? 1) - 1
  const end = Math.min(rows.length, start + (args.lines ?? 160))
  const parts: string[] = []
  let available = 24_000
  let index = start
  let column = (args.startColumn ?? 1) - 1

  for (; index < end; index++) {
    const prefix = `${index + 1}: `
    const row = rows[index]!.slice(column)
    const length = prefix.length + row.length

    if (length > available) {
      if (!parts.length) {
        let count = available - prefix.length

        // Keep a Unicode surrogate pair together across pages.
        if (/[\uD800-\uDBFF]/.test(row.charAt(count - 1))) {
          count--
        }

        parts.push(prefix + row.slice(0, count))
        column += count
      }

      break
    }

    parts.push(prefix + row)
    available -= length + 1
    column = 0
  }

  return {
    content: parts.join('\n'),
    totalLines: rows.length,
    ...(index < rows.length ? { nextStartLine: index + 1 } : {}),
    ...(index < rows.length && column ? { nextStartColumn: column + 1 } : {}),
  }
}

export function fileTools(
  root: string,
  scopes?: string[],
  roleScopes?: string[],
  documentsOnly = false,
  resolveFile = safePath,
): ToolDefinition[] {
  let deliveredInstructions = ''

  function folderRules(text: string, reuse: boolean) {
    if (reuse && text && text === deliveredInstructions) {
      return { instructionsUnchanged: true }
    }

    deliveredInstructions = text
    return { instructions: text }
  }

  const read: ToolDefinition = {
    name: 'project_read',
    label: 'Read project file',
    description:
      'Read numbered lines and folder rules. Continue at nextStartLine and nextStartColumn. ' +
      'fileSha256 covers the complete file. Set reuseInstructions to reuse identical folder rules.',
    parameters: readParameters,
    async execute(id, raw) {
      const args = raw as Static<typeof readParameters>
      const source = await readBoundedFile(await resolveFile(root, args.path))
      const rules = await instructions(root, [args.path])
      return textResult({
        ...readWindow(source.toString('utf8'), args),
        fileSha256: digest(source),
        ...folderRules(rules, args.reuseInstructions === true),
        call: id,
      })
    },
  }
  const search: ToolDefinition = {
    name: 'project_search',
    label: 'Search project',
    description:
      'List files or find literal text in authored files. Filter by pathPrefix. For listings, ' +
      'pass nextAfterPath as afterPath to continue.',
    parameters: Type.Object({
      query: Type.Optional(Type.String({ maxLength: 300 })),
      pathPrefix: Type.Optional(Type.String()),
      afterPath: Type.Optional(Type.String()),
    }),
    async execute(id, raw) {
      const {
        query,
        pathPrefix = '',
        afterPath,
      } = raw as {
        query?: string
        pathPrefix?: string
        afterPath?: string
      }
      const files = await inventory(root)

      if (!query) {
        const names = [...files.keys()].filter((path) => path.startsWith(pathPrefix))
        const start = afterPath === undefined ? 0 : names.indexOf(afterPath) + 1

        if (afterPath !== undefined && !start) {
          throw new Error('Listing cursor is unavailable; restart the listing with the same prefix')
        }

        const matches = names.slice(start, start + 100)
        const nextAfterPath = start + matches.length < names.length ? matches.at(-1) : undefined
        return textResult({ matches, limit: 100, nextAfterPath, call: id })
      }

      if (afterPath !== undefined) {
        throw new Error('afterPath applies only to file listings')
      }

      const matches: string[] = []

      for (const [path, bytes] of files) {
        if (path.startsWith(pathPrefix) && !bytes.includes(0)) {
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
      name: 'project_edit',
      executionMode: 'sequential',
      label: 'Edit assigned text',
      description:
        'Edit unique, exact text in one assigned file. Group known same-file replacements ' +
        'in additionalEdits. Apply in order and write once after every match succeeds.',
      parameters: editParameters,
      async execute(id, raw) {
        const {
          path,
          oldText,
          newText,
          additionalEdits = [],
        } = raw as Static<typeof editParameters>

        if (!writable(path, scopes, documentsOnly) || !writable(path, roleScopes)) {
          throw new Error('Path is outside this worker assignment')
        }

        const target = await resolveFile(root, path)
        let content = (await readBoundedFile(target)).toString('utf8')

        for (const [index, edit] of [{ oldText, newText }, ...additionalEdits].entries()) {
          const offset = content.indexOf(edit.oldText)

          if (!edit.oldText || offset < 0 || content.indexOf(edit.oldText, offset + 1) >= 0) {
            const reason = offset < 0 || !edit.oldText ? 'missing' : 'ambiguous'
            throw new Error(`Edit ${index + 1} is ${reason}; oldText must match exactly once`)
          }

          content =
            content.slice(0, offset) + edit.newText + content.slice(offset + edit.oldText.length)
        }

        if (Buffer.byteLength(content) > maxFileBytes) {
          throw new Error('Edited file exceeds the snapshot size limit')
        }

        await writeFile(target, content)
        const rules = await instructions(root, [path])
        return textResult({
          edited: path,
          ...folderRules(rules, true),
          call: id,
        })
      },
    })
    tools.push({
      name: 'project_write',
      executionMode: 'sequential',
      label: 'Write assigned file',
      description: 'Replace an assigned file. Read its instructions and contents first.',
      parameters: Type.Object({ path: Type.String(), content: Type.String({ maxLength: 200000 }) }),
      async execute(id, raw) {
        const { path, content } = raw as { path: string; content: string }

        if (!writable(path, scopes, documentsOnly) || !writable(path, roleScopes)) {
          throw new Error('Path is outside this worker assignment')
        }

        const target = await resolveFile(root, path)
        const rules = await instructions(root, [path])
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, content)
        return textResult({ written: path, ...folderRules(rules, true), call: id })
      },
    })
    tools.push({
      name: 'project_delete',
      executionMode: 'sequential',
      label: 'Delete assigned file',
      description: 'Delete one assigned file after reading it. Directories cannot be deleted.',
      parameters: Type.Object({ path: Type.String() }),
      async execute(id, raw) {
        const { path } = raw as { path: string }

        if (!writable(path, scopes, documentsOnly) || !writable(path, roleScopes)) {
          throw new Error('Path is outside this worker assignment')
        }

        await unlink(await resolveFile(root, path))
        return textResult({ deleted: path, call: id })
      },
    })
  }

  return tools
}
