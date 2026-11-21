import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { format } from 'prettier'
import { StateStore } from '../src/state.ts'

// @ts-expect-error The shared formatter is plain JavaScript.
import { addReadabilitySpacing } from './linting/readability.mjs'

export async function liveFixture() {
  const root = await mkdtemp(join(tmpdir(), 'pi-live-ledger-'))
  const sources: Record<string, string> = {
    'ledger.mjs':
      "\n      import { DatabaseSync } from 'node:sqlite'\n      export fun" +
      'ction openLedger(path) {\n        const db = new DatabaseSync(path)' +
      "\n        db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = F" +
      "ULL')\n        db.exec('CREATE TABLE IF NOT EXISTS entries (id TEXT " +
      "PRIMARY KEY, amount INTEGER NOT NULL)')\n        return {\n         " +
      " apply(id, amount) {\n            db.prepare('INSERT OR REPLACE INTO" +
      " entries VALUES (?, ?)').run(id, amount)\n            return this.ba" +
      'lance()\n          },\n          balance() {\n            const row ' +
      "= db.prepare('SELECT COALESCE(SUM(amount), 0) AS value FROM entries'" +
      ').get()\n            return Number(row.value)\n          },\n       ' +
      '   close() { db.close() }\n        }\n      }\n    ',
    'tests/contract.mjs':
      "\n      import assert from 'node:assert/strict'\n      import { mkdt" +
      "empSync, rmSync } from 'node:fs'\n      import { tmpdir } from 'node" +
      ":os'\n      import { join } from 'node:path'\n      import { openLed" +
      "ger } from '../ledger.mjs'\n      const directory = mkdtempSync(join" +
      "(tmpdir(), 'ledger-contract-'))\n      const ledger = openLedger(joi" +
      "n(directory, 'data.sqlite'))\n      try {\n        let expected = 0" +
      '\n        let seed = 12345\n        for (let index = 0; index < 200;' +
      ' index++) {\n          seed = (Math.imul(seed, 1664525) + 1013904223' +
      ') >>> 0\n          const amount = (seed % 2001) - 1000\n          co' +
      "nst id = 'request-' + index\n          expected += amount\n         " +
      ' assert.equal(ledger.apply(id, amount), expected)\n          assert.' +
      'equal(ledger.apply(id, amount), expected)\n          assert.throws((' +
      ') => ledger.apply(id, amount + 1))\n          assert.equal(ledger.ba' +
      'lance(), expected)\n        }\n        for (const bad of [NaN, Infin' +
      "ity, 1.2, '1', null, 1000001, -1000001]) {\n          assert.throws(" +
      "() => ledger.apply('invalid', bad))\n        }\n        for (const i" +
      "d of ['', 'x'.repeat(129), null, 123]) {\n          assert.throws(()" +
      " => ledger.apply(id, 1))\n        }\n        console.log('200 seeded" +
      " operations: replay, conflict and invalid-input properties passed')" +
      '\n      } finally { ledger.close(); rmSync(directory, { recursive: t' +
      'rue, force: true }) }\n    ',
    'tests/recovery.mjs':
      "\n      import assert from 'node:assert/strict'\n      import { spaw" +
      "nSync } from 'node:child_process'\n      import { mkdtempSync, rmSyn" +
      "c } from 'node:fs'\n      import { tmpdir } from 'node:os'\n      im" +
      "port { join } from 'node:path'\n      import { openLedger } from '.." +
      "/ledger.mjs'\n      const directory = mkdtempSync(join(tmpdir(), 'le" +
      "dger-recovery-'))\n      const path = join(directory, 'data.sqlite')" +
      "\n      const moduleUrl = new URL('../ledger.mjs', import.meta.url)." +
      "href\n      const child = spawnSync(process.execPath, ['--input-type" +
      "=module', '-e', \n        'import { openLedger } from ' + JSON.strin" +
      "gify(moduleUrl) + ';' +\n        'const ledger = openLedger(process." +
      'argv[1]); ledger.apply("committed", 42);\' +\n        \'process.kill' +
      "(process.pid, \"SIGKILL\");', path], { encoding: 'utf8' })\n      as" +
      "sert.equal(child.signal, 'SIGKILL', child.stderr)\n      const abort" +
      "ed = spawnSync(process.execPath, ['--input-type=module', '-e',\n    " +
      "    'import { DatabaseSync } from \"node:sqlite\";' +\n        'cons" +
      "t db = new DatabaseSync(process.argv[1]);' +\n        'db.exec(\"BEG" +
      'IN IMMEDIATE");\' +\n        \'db.prepare("INSERT INTO entries VALUE' +
      'S (?, ?)").run("uncommitted", 99);\' +\n        \'process.kill(proc' +
      "ess.pid, \"SIGKILL\");', path], { encoding: 'utf8' })\n      assert." +
      "equal(aborted.signal, 'SIGKILL', aborted.stderr)\n      const ledger" +
      ' = openLedger(path)\n      try {\n        assert.equal(ledger.balanc' +
      "e(), 42)\n        assert.equal(ledger.apply('committed', 42), 42)\n " +
      "       assert.throws(() => ledger.apply('committed', 43))\n        a" +
      "ssert.equal(ledger.balance(), 42)\n        console.log('SIGKILL: ack" +
      "nowledged commit recovered; uncommitted write rolled back')\n      }" +
      ' finally { ledger.close(); rmSync(directory, { recursive: true, forc' +
      'e: true }) }\n    ',
    'benchmarks/run.mjs':
      "\n      import assert from 'node:assert/strict'\n      import { open" +
      "Ledger } from '../ledger.mjs'\n      const ledger = openLedger(':mem" +
      "ory:')\n      const start = performance.now()\n      for (let index " +
      "= 0; index < 1000; index++) { ledger.apply('request-' + index, 1) }" +
      '\n      const elapsedMs = performance.now() - start\n      assert.eq' +
      'ual(ledger.balance(), 1000)\n      ledger.close()\n      console.log' +
      '(JSON.stringify({ elapsedMs, operations: 1000, checksum: 1000 }))\n ' +
      '   ',
  }

  for (const [name, source] of Object.entries(sources)) {
    await mkdir(join(root, name, '..'), { recursive: true })
    const formatted = await format(source, {
      filepath: name,
      printWidth: 100,
      semi: false,
      singleQuote: true,
      trailingComma: 'all',
    })
    await writeFile(join(root, name), addReadabilitySpacing(formatted, name))
  }

  await mkdir(join(root, '.pi'))
  await writeFile(
    join(root, '.pi/harness.json'),
    JSON.stringify(
      {
        checks: [
          {
            id: 'contract',
            kind: 'test',
            argv: ['node', 'tests/contract.mjs'],
            required: true,
            timeoutMs: 30000,
          },
          {
            id: 'recovery',
            kind: 'database',
            argv: ['node', 'tests/recovery.mjs'],
            required: true,
            timeoutMs: 30000,
          },
          {
            id: 'benchmark',
            kind: 'benchmark',
            argv: ['node', 'benchmarks/run.mjs'],
            required: true,
            timeoutMs: 30000,
          },
        ],
      },
      null,
      2,
    ) + '\n',
  )
  const store = new StateStore(root)
  const design = {
    objective: 'Make a SQLite ledger replay-safe and measure performance.',
    design: [
      'Keep openLedger(path), apply(id, amount), balance(), close().',
      'IDs are strings of 1..128 characters; amounts are integers in [-1000000,1000000].',
      'A repeated ID with the same amount returns the current balance without another effect.',
      'A conflicting amount throws without changing data.',
      'Use atomic transactions and serialize concurrent writers.',
      'Acknowledged commits survive process crashes on this single-machine SQLite deployment.',
      'Keep WAL and FULL sync. No replication or remote disaster recovery is claimed.',
      'Measure a real file-backed database with matching durability, warmup, at least 3 samples,',
      'seed, units, checksum and environment.',
      'Fix product behavior; tests are supplied as immutable external acceptance gates.',
    ].join(' '),
    invariants: [
      'Each request ID commits at most once',
      'Conflicts and invalid input have no effect',
      'Acknowledged data survives process restart; no guarantee ' + 'against disk or machine loss',
    ],
    acceptance: [
      'Seeded contract tests pass',
      'SIGKILL recovery tests pass',
      'Benchmark reports repeated file-backed measurements with checksum',
    ],
    writePaths: ['ledger.mjs', 'benchmarks/**'],
    database: true,
    performance: true,
    performanceReview: true,
    unresolved: [],
  }
  return { root, store, design }
}
