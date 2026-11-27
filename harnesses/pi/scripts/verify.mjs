import { execFileSync } from 'node:child_process'

// Node scripts run with this interpreter. Under an outer `npm --prefix`, `npm exec -- node` finds
// no `node` in the moved global bin directory and requests a registry package named `node`.
const commands = process.argv.includes('--lint')
  ? [
      ['npm', ['exec', '--', 'oxlint', '.']],
      [process.execPath, ['scripts/linting/check.mjs', '.']],
    ]
  : [
      ['npm', ['run', 'format:check']],
      ['npm', ['run', 'lint']],
      ['npm', ['run', 'typecheck']],
      ['npm', ['test']],
    ]

for (const [command, args] of commands) {
  execFileSync(command, args, { stdio: 'inherit' })
}
