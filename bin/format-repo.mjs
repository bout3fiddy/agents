import { writeFile } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { format } from '../harnesses/pi/node_modules/prettier/index.mjs'
import { sourceFiles } from '../harnesses/pi/scripts/linting/files.mjs'
import { addReadabilitySpacing } from '../harnesses/pi/scripts/linting/readability.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const python = []

for (const file of await sourceFiles(root)) {
  if (file.name.startsWith('skills-evals/fixtures/')) {
    continue
  }

  if (file.name.endsWith('.py')) {
    python.push(file.path)
  } else if (/\.[cm]?[jt]sx?$/.test(file.name)) {
    const evaluationStyle = file.name.startsWith('skills-evals/')
    const formatted = await format(file.source, {
      filepath: file.path,
      printWidth: 100,
      semi: evaluationStyle,
      singleQuote: !evaluationStyle,
      useTabs: evaluationStyle,
      trailingComma: 'all',
    })
    await writeFile(file.path, addReadabilitySpacing(formatted, file.name))
  }
}

if (python.length) {
  execFileSync('uvx', ['ruff@0.17.5', 'format', '--line-length', '100', ...python], {
    stdio: 'inherit',
  })
  execFileSync(
    'python3',
    [root + 'harnesses/pi/scripts/linting/python_readability.py', '--fix', ...python],
    { stdio: 'inherit' },
  )
}
