import { sourceFiles } from './files.mjs'
import { addReadabilitySpacing } from './readability.mjs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

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

    for (const [index, line] of file.source.split(/\r?\n/).entries()) {
      if (file.name.endsWith('.md') && /^\s*(?:\[[^\]]+\]:\s*)?https?:\/\/\S+$/.test(line)) {
        continue
      }

      if ([...line].length > 100) {
        failures.push(`${file.name}:${index + 1}: line exceeds 100 columns`)
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
  const failures = await check(resolve(process.argv[2] || '.'))

  if (failures.length) {
    console.error(failures.join('\n'))
    process.exitCode = 1
  } else {
    console.log('Readability, JSON and 100-column checks passed')
  }
}
