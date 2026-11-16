import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { safePath, sensitive } from '../src/paths.ts'

test(
  'filesystem Unicode aliases preserve private-path boundaries',
  { timeout: 60000 },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), 'pi-unicode-oracle-'))
    const protectedPaths = [
      '.ssh/id',
      '.harness/state',
      'node_modules/pkg',
      'reports/file',
      'secrets.json',
      'credentials.json',
      'server.key',
      '.ruff_cache/file',
      '.git/config',
      '.env',
    ]
    let checked = 0
    let aliases = 0

    try {
      for (const name of [
        ...'abcdefghijklmnopqrstuvwxyz',
        'ss',
        'ff',
        'ffi',
        'ffl',
        'fi',
        'fl',
        'st',
      ]) {
        await writeFile(join(root, name), 'oracle')
      }

      for (let codepoint = 0x80; codepoint <= 0x10ffff; codepoint++) {
        const character = String.fromCodePoint(codepoint)

        if (!/[\p{Letter}\p{Default_Ignorable_Code_Point}]/u.test(character)) {
          continue
        }

        context.signal.throwIfAborted()
        checked++
        let actual: string

        try {
          actual = basename(await realpath(join(root, character)))
        } catch (error) {
          assert.equal((error as NodeJS.ErrnoException).code, 'ENOENT')
          continue
        }

        aliases++
        await assert.rejects(safePath(root, character), /spelling aliases/)

        for (const path of protectedPaths.filter((name) => name.includes(actual))) {
          const alias = path.replaceAll(actual, character)
          assert.ok(sensitive(alias), `Unprotected U+${codepoint.toString(16)} alias: ${alias}`)
        }
      }

      context.diagnostic(`Checked ${checked} code points and ${aliases} filesystem aliases`)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
)
