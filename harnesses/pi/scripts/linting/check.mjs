import { sourceFiles } from './files.mjs'
import { addReadabilitySpacing } from './readability.mjs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { getFileInfo } from 'prettier'

export async function check(root, options = {}) {
  const failures = []
  const python = []

  for (const file of await sourceFiles(root)) {
    if (options.codeOnly && !/\.(?:[cm]?[jt]sx?|py|sh|bash|zsh|zig|rs|go)$/.test(file.name)) {
      continue
    }

    if (options.exclude?.some((prefix) => file.name.startsWith(prefix))) {
      continue
    }

    const widthFindings = []

    for (const [index, line] of file.source.split(/\r?\n/).entries()) {
      if (file.name.endsWith('.md') && /^\s*(?:\[[^\]]+\]:\s*)?https?:\/\/\S+$/.test(line)) {
        continue
      }

      if ([...line].length > 100) {
        widthFindings.push(`${file.name}:${index + 1}: line exceeds 100 columns`)
      }
    }

    if (
      widthFindings.length &&
      options.retainedMarkdown?.has(file.name) &&
      file.name.endsWith('.md') &&
      (
        await getFileInfo(file.path, {
          ignorePath: join(root, '.prettierignore'),
          resolveConfig: false,
        })
      ).ignored
    ) {
      const count = widthFindings.length
      const label = count === 1 ? 'finding' : 'findings'
      options.inherited.push(`${file.name}: ${count} inherited line-width ${label}`)
    } else {
      for (const finding of widthFindings) {
        failures.push(finding)
      }
    }

    if (file.name.endsWith('.json')) {
      try {
        JSON.parse(file.source)
      } catch {
        failures.push(`${file.name}: invalid JSON`)
      }
    }

    if (addReadabilitySpacing(file.source, file.name) !== file.source) {
      failures.push(`${file.name}: separate logical stages and standalone comment blocks`)
    }

    if (file.name.endsWith('.py')) {
      python.push(file.path)
    }
  }

  if (python.length) {
    const script = join(dirname(fileURLToPath(import.meta.url)), 'python_readability.py')
    const result = spawnSync('python3', [script, ...python], { encoding: 'utf8' })

    if (result.status !== 0) {
      failures.push(result.stdout || result.stderr || 'Python readability checker unavailable')
    }
  }

  return failures
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(process.argv[2] || '.')
  const retainedMarkdown =
    process.argv[3] === '--retained-markdown'
      ? new Set(JSON.parse(await readFile(join(root, process.argv[4]), 'utf8')))
      : undefined
  const inherited = []
  const failures = await check(root, { retainedMarkdown, inherited })

  for (const finding of inherited) {
    console.log(finding)
  }

  if (failures.length) {
    console.error(failures.join('\n'))
    process.exitCode = 1
  } else if (inherited.length) {
    console.log('Scoped lint passed with inherited reference findings.')
  } else {
    console.log('Readability, JSON and 100-column checks passed')
  }
}
