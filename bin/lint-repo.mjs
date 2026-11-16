import { check } from '../harnesses/pi/scripts/linting/check.mjs'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const semantic = spawnSync(
  root + 'harnesses/pi/node_modules/.bin/oxlint',
  [
    '--config',
    root + 'harnesses/pi/.oxlintrc.json',
    '--ignore-pattern',
    'skills-evals/fixtures/**',
    '.',
  ],
  { cwd: root, stdio: 'inherit' },
)

if (semantic.status !== 0) {
  process.exitCode = 1
}

const errors = await check(root, {
  codeOnly: true,
  exclude: ['skills-evals/fixtures/'],
})

if (errors.length) {
  console.error(errors.join('\n'))
  process.exitCode = 1
} else {
  console.log('Repository code: readability and 100-column gates passed')
}
