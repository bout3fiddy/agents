import { writeFile } from 'node:fs/promises'
import * as prettier from 'prettier'
import { Type } from 'typebox'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import { readBoundedFile, safePath } from './paths.ts'
import { textResult } from './file-tools.ts'

export const harnessFormatOptions = {
  printWidth: 100,
  semi: false,
  singleQuote: true,
  trailingComma: 'all',
  proseWrap: 'always',
} satisfies prettier.Options

export async function checkDocuments(root: string, paths: string[], format: boolean) {
  if (!paths.length || paths.length > 24 || new Set(paths).size !== paths.length) {
    throw new Error('Select 1–24 distinct Markdown files')
  }

  const ignorePath = await safePath(root, '.prettierignore')

  try {
    await readBoundedFile(ignorePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  // Validate every destination before formatting any file.
  const files = await Promise.all(
    paths.map(async (path) => {
      if (!path.endsWith('.md')) {
        throw new Error('document_check accepts Markdown files only')
      }

      const absolute = await safePath(root, path)
      const source = (await readBoundedFile(absolute)).toString('utf8')
      const { ignored } = await prettier.getFileInfo(absolute, {
        ignorePath,
        resolveConfig: false,
      })
      const formatted = ignored
        ? source
        : await prettier.format(source, { ...harnessFormatOptions, parser: 'markdown' })
      return { path, absolute, source, formatted, ignored }
    }),
  )
  const changed: string[] = []
  const failures: string[] = []

  for (const file of files) {
    if (format && file.formatted !== file.source) {
      await writeFile(file.absolute, file.formatted)
      changed.push(file.path)
    } else if (!format && file.formatted !== file.source) {
      failures.push(`${file.path}: formatting required`)
    }

    const text = format ? file.formatted : file.source

    for (const [index, line] of text.split('\n').entries()) {
      const url = /^\s*(?:\[[^\]]+\]:\s*)?https?:\/\/\S+$/.test(line)

      if (!url && [...line].length > 100) {
        failures.push(`${file.path}:${index + 1}: line exceeds 100 columns`)
      }
    }
  }

  return {
    status: failures.length ? 'failed' : 'passed',
    changed,
    failures,
    checked: paths,
    formattingSkipped: files.filter((file) => file.ignored).map((file) => file.path),
    scope:
      'Markdown formatting respects root .prettierignore; line width checks all selected files. ' +
      'Content and links need review.',
  }
}

export function registerDocumentTools(pi: ExtensionAPI): void {
  pi.registerTool({
    name: 'document_check',
    label: 'Check Markdown documents',
    description:
      'Check or format selected Markdown files with the pinned harness formatter. ' +
      'Respect root .prettierignore; check line width even when formatting is excluded. ' +
      'Host formatting follows file routing. Return product fixes to the worker.',
    parameters: Type.Object({
      paths: Type.Array(Type.String(), { minItems: 1, maxItems: 24 }),
      format: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, args, _signal, _update, ctx) {
      const result = await checkDocuments(ctx.cwd, args.paths, args.format ?? false)
      return { ...textResult(result), isError: result.status === 'failed' }
    },
  })
}
