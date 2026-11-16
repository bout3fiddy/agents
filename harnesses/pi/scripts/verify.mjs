import { execFileSync } from 'node:child_process'

const commands = process.argv.includes('--lint')
  ? [
      ['exec', '--', 'oxlint', '.'],
      ['exec', '--', 'node', 'scripts/linting/check.mjs', '.'],
    ]
  : [['run', 'format:check'], ['run', 'lint'], ['run', 'typecheck'], ['test']]

for (const args of commands) {
  execFileSync('npm', args, { stdio: 'inherit' })
}
