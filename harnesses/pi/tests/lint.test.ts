import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, rm, writeFile, open } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readBoundedFile } from '../src/paths.ts'

// @ts-expect-error Shared lint is JavaScript.
import { check } from '../scripts/linting/check.mjs'

// @ts-expect-error Shared formatter is JavaScript.
import { addReadabilitySpacing } from '../scripts/linting/readability.mjs'

test('readability formatting is idempotent and preserves comment-like string content', () => {
  for (let seed = 0; seed < 100; seed++) {
    const source = `const value = "// seed ${seed} λ"\nif (value) {\n  log(value)\n}\nlog(value)\n`
    const formatted = addReadabilitySpacing(source, 'probe.ts') as string
    assert.equal(addReadabilitySpacing(formatted, 'probe.ts'), formatted)
    assert.match(formatted, new RegExp(`"// seed ${seed} λ"`))
    assert.match(formatted, /\n\nif/)
    assert.match(formatted, /}\n\nlog/)
  }
})

test('lint checks Python comments and JSON while skipping disk images', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-lint-'))
  const image = await open(join(root, 'disk.img'), 'w')
  await image.truncate(3_000_000_000)
  await image.close()
  await writeFile(join(root, 'bad.json'), '{ invalid }\n')
  await mkdir(join(root, '.pi/traces'), { recursive: true })
  await writeFile(join(root, '.pi/traces/generated.json'), '{ invalid trace ' + 'x'.repeat(200))
  await writeFile(
    join(root, 'probe.py'),
    'value = "# not a comment"\n# actual comment\nprint(value)\n',
  )

  try {
    await assert.rejects(readBoundedFile(join(root, 'disk.img')), /read limit/)
    const errors: string[] = await check(root)
    assert.ok(errors.some((item) => item.includes('invalid JSON')))
    assert.ok(errors.some((item) => item.includes('standalone comment block')))
    assert.ok(!errors.some((item) => item.includes('.pi/traces')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
