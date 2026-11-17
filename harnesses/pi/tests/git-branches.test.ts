import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  gitCommand,
  mergeBranch,
  prepareBranch,
  publishBranch,
  resolveRemote,
  type GitBranch,
} from '../src/git-branches.ts'
import { inventory, snapshotHash } from '../src/paths.ts'

async function repository() {
  const directory = await mkdtemp(join(tmpdir(), 'pi-branch-test-'))
  const root = join(directory, 'project')
  const remote = join(directory, 'remote.git')
  await mkdir(root)
  await gitCommand(directory, ['init', '--bare', remote])
  await gitCommand(root, ['init', '-b', 'main'])
  await gitCommand(root, ['config', 'user.name', 'Pi test'])
  await gitCommand(root, ['config', 'user.email', 'pi-test@example.invalid'])
  await mkdir(join(root, '.pi'))
  await writeFile(join(root, '.pi/.gitignore'), '/traces/\n')
  await writeFile(join(root, 'one.txt'), 'one\n')
  await writeFile(join(root, 'two.txt'), 'two\n')
  await writeFile(join(root, 'shared.txt'), 'initial\n')
  await gitCommand(root, ['add', '.'])
  await gitCommand(root, ['commit', '-m', 'Initial project'])
  await gitCommand(root, ['remote', 'add', 'origin', remote])
  await gitCommand(root, ['push', 'origin', 'HEAD:main'])
  const pinned = await resolveRemote(root)
  const prepare = () => prepareBranch(root, randomUUID(), pinned)
  const snapshot = async (branch: GitBranch) => snapshotHash(await inventory(branch.workspace))
  const publish = async (branch: GitBranch, name: string, content: string) => {
    await writeFile(join(branch.workspace, name), content)
    return publishBranch(branch, {
      message: `Update ${name}`,
      writePaths: [name],
      expectedSnapshot: await snapshot(branch),
    })
  }
  return { directory, root, remote, pinned, prepare, snapshot, publish }
}

test('independent branches merge serially after current-main validation', async () => {
  const setup = await repository()

  try {
    const [first, second] = await Promise.all([setup.prepare(), setup.prepare()])
    assert.notEqual(first.workspace, second.workspace)
    assert.equal(first.base, second.base)
    await Promise.all([
      setup.publish(first, 'one.txt', 'first task\n'),
      setup.publish(second, 'two.txt', 'second task\n'),
    ])
    const bases: string[] = []
    const checked: string[] = []
    let active = 0
    const merge = (branch: GitBranch, path: string) =>
      mergeBranch(branch, {
        message: 'Integrate verified task',
        writePaths: [path],
        async validate({ baseTip, conflicts }) {
          active++
          assert.equal(active, 1)
          assert.deepEqual(conflicts, [])
          bases.push(baseTip)
          active--
          return setup.snapshot(branch)
        },
        async afterBranchPush({ commit }) {
          checked.push(commit)
          const remoteCommit = await gitCommand(setup.root, [
            'ls-remote',
            'origin',
            `refs/heads/${branch.branch}`,
          ])
          assert.equal(remoteCommit.split('\t')[0], commit)
        },
      })
    const merged = await Promise.all([merge(first, 'one.txt'), merge(second, 'two.txt')])
    const main = (await resolveRemote(setup.root)).base
    assert.equal(await gitCommand(setup.root, ['show', `${main}:one.txt`]), 'first task')
    assert.equal(await gitCommand(setup.root, ['show', `${main}:two.txt`]), 'second task')
    assert.equal(bases.length, 2)
    assert.notEqual(bases[0], bases[1])
    assert.equal(checked.length, 2)
    assert.ok(merged.some((result) => result.commit === main))
    assert.equal(await gitCommand(setup.root, ['rev-parse', 'HEAD']), setup.pinned.base)
    assert.equal(await readFile(join(setup.root, 'one.txt'), 'utf8'), 'one\n')
  } finally {
    await rm(setup.directory, { recursive: true, force: true })
  }
})

test('remote main race causes fresh validation without losing either change', async () => {
  const setup = await repository()

  try {
    const [task, outsider] = await Promise.all([setup.prepare(), setup.prepare()])
    await setup.publish(task, 'one.txt', 'task\n')
    const competing = await setup.publish(outsider, 'two.txt', 'external writer\n')
    let validations = 0
    let pushed = 0
    const result = await mergeBranch(task, {
      message: 'Merge task after current-main checks',
      writePaths: ['one.txt'],
      async validate() {
        validations++
        return setup.snapshot(task)
      },
      async afterBranchPush() {
        if (pushed++ === 0) {
          await gitCommand(setup.root, ['push', 'origin', `${competing}:main`])
        }
      },
    })
    assert.equal(result.attempts, 2)
    assert.equal(validations, 2)
    const main = (await resolveRemote(setup.root)).base
    assert.equal(main, result.commit)
    assert.equal(await gitCommand(setup.root, ['show', `${main}:one.txt`]), 'task')
    assert.equal(await gitCommand(setup.root, ['show', `${main}:two.txt`]), 'external writer')
  } finally {
    await rm(setup.directory, { recursive: true, force: true })
  }
})

test('scoped conflicts are repaired and reviewed before main advances', async () => {
  const setup = await repository()

  try {
    const [task, outsider] = await Promise.all([setup.prepare(), setup.prepare()])
    await setup.publish(task, 'shared.txt', 'task choice\n')
    const other = await setup.publish(outsider, 'shared.txt', 'main choice\n')
    await gitCommand(setup.root, ['push', 'origin', `${other}:main`])
    const result = await mergeBranch(task, {
      message: 'Reconcile scoped conflict',
      writePaths: ['shared.txt'],
      async validate({ conflicts, baseTip }) {
        assert.equal(baseTip, other)
        assert.deepEqual(conflicts, ['shared.txt'])
        await writeFile(join(task.workspace, 'shared.txt'), 'both choices reconciled\n')
        return setup.snapshot(task)
      },
    })
    assert.equal((await resolveRemote(setup.root)).base, result.commit)
    assert.equal(
      await gitCommand(setup.root, ['show', `${result.commit}:shared.txt`]),
      'both choices reconciled',
    )
  } finally {
    await rm(setup.directory, { recursive: true, force: true })
  }
})

test('failed review or exact-head CI leaves main unchanged and keeps the task branch', async () => {
  const setup = await repository()

  try {
    const task = await setup.prepare()
    const commit = await setup.publish(task, 'one.txt', 'candidate\n')
    await assert.rejects(
      mergeBranch(task, {
        message: 'Candidate',
        writePaths: ['one.txt'],
        async validate() {
          throw new Error('required reviewer finding')
        },
      }),
      /required reviewer finding/,
    )
    assert.equal((await resolveRemote(setup.root)).base, setup.pinned.base)
    await assert.rejects(
      mergeBranch(task, {
        message: 'Candidate',
        writePaths: ['one.txt'],
        validate: () => setup.snapshot(task),
        async afterBranchPush() {
          throw new Error('CI failed for exact candidate')
        },
      }),
      /CI failed for exact candidate/,
    )
    assert.equal((await resolveRemote(setup.root)).base, setup.pinned.base)
    assert.equal(
      (await gitCommand(setup.root, ['ls-remote', 'origin', `refs/heads/${task.branch}`])).split(
        '\t',
      )[0],
      commit,
    )
  } finally {
    await rm(setup.directory, { recursive: true, force: true })
  }
})

test('unchanged conflict markers cannot be published as a reviewed candidate', async () => {
  const setup = await repository()

  try {
    const [task, outsider] = await Promise.all([setup.prepare(), setup.prepare()])
    await setup.publish(task, 'shared.txt', 'task choice\n')
    const other = await setup.publish(outsider, 'shared.txt', 'main choice\n')
    await gitCommand(setup.root, ['push', 'origin', `${other}:main`])
    await assert.rejects(
      mergeBranch(task, {
        message: 'Still conflicted',
        writePaths: ['shared.txt'],
        validate: () => setup.snapshot(task),
      }),
      /Unresolved conflict markers/,
    )
    assert.equal((await resolveRemote(setup.root)).base, other)
  } finally {
    await rm(setup.directory, { recursive: true, force: true })
  }
})

test('Git clean filters cannot execute or change reviewed bytes', async () => {
  const setup = await repository()

  try {
    const task = await setup.prepare()
    await gitCommand(setup.root, ['config', 'filter.change.clean', 'sed s/reviewed/altered/g'])
    await writeFile(join(task.workspace, '.gitattributes'), 'one.txt filter=change\n')
    await writeFile(join(task.workspace, 'one.txt'), 'reviewed content\n')
    const commit = await publishBranch(task, {
      message: 'Filtered candidate',
      writePaths: ['one.txt', '.gitattributes'],
      expectedSnapshot: await setup.snapshot(task),
    })
    assert.equal((await resolveRemote(setup.root)).base, setup.pinned.base)
    assert.equal(await gitCommand(setup.root, ['show', `${commit}:one.txt`]), 'reviewed content')
  } finally {
    await rm(setup.directory, { recursive: true, force: true })
  }
})

test('Git newline conversion cannot publish unreviewed committed bytes', async () => {
  const setup = await repository()

  try {
    const task = await setup.prepare()
    await gitCommand(setup.root, ['config', 'core.autocrlf', 'true'])
    await writeFile(join(task.workspace, 'one.txt'), 'reviewed CRLF\r\n')
    await assert.rejects(
      publishBranch(task, {
        message: 'Converted candidate',
        writePaths: ['one.txt'],
        expectedSnapshot: await setup.snapshot(task),
      }),
      /Committed bytes differ/,
    )
    assert.equal((await resolveRemote(setup.root)).base, setup.pinned.base)
    assert.equal(
      await gitCommand(setup.root, ['ls-remote', 'origin', `refs/heads/${task.branch}`]),
      '',
    )
  } finally {
    await rm(setup.directory, { recursive: true, force: true })
  }
})

test('publication rejects changed evidence, out-of-scope files and changed remote', async () => {
  const setup = await repository()

  try {
    const task = await setup.prepare()
    const oldSnapshot = await setup.snapshot(task)
    await writeFile(join(task.workspace, 'one.txt'), 'change\n')
    await assert.rejects(
      publishBranch(task, {
        message: 'Stale',
        writePaths: ['one.txt'],
        expectedSnapshot: oldSnapshot,
      }),
      /changed after verification/,
    )
    await assert.rejects(
      publishBranch(task, {
        message: 'Wrong scope',
        writePaths: ['two.txt'],
        expectedSnapshot: await setup.snapshot(task),
      }),
      /outside its assignment/,
    )
    await gitCommand(setup.root, [
      'remote',
      'set-url',
      'origin',
      join(setup.directory, 'elsewhere.git'),
    ])
    await assert.rejects(
      publishBranch(task, {
        message: 'Wrong remote',
        writePaths: ['one.txt'],
        expectedSnapshot: await setup.snapshot(task),
      }),
      /remote changed/,
    )
  } finally {
    await rm(setup.directory, { recursive: true, force: true })
  }
})

test('host hooks are disabled and cancellation never publishes main', async () => {
  const setup = await repository()

  try {
    const hooks = join(setup.directory, 'hooks')
    await mkdir(hooks)
    await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 91\n')
    await chmod(join(hooks, 'pre-commit'), 0o755)
    await gitCommand(setup.root, ['config', 'core.hooksPath', hooks])
    const task = await setup.prepare()
    await setup.publish(task, 'one.txt', 'hooks cannot execute\n')
    const controller = new AbortController()
    await assert.rejects(
      mergeBranch(
        task,
        {
          message: 'Cancelled integration',
          writePaths: ['one.txt'],
          async validate() {
            controller.abort()
            return setup.snapshot(task)
          },
        },
        controller.signal,
      ),
      /abort/i,
    )
    assert.equal((await resolveRemote(setup.root)).base, setup.pinned.base)
  } finally {
    await rm(setup.directory, { recursive: true, force: true })
  }
})

test('remote rejection is retained without retrying or bypassing server policy', async () => {
  const setup = await repository()

  try {
    const hook = join(setup.remote, 'hooks', 'pre-receive')
    await writeFile(
      hook,
      '#!/bin/sh\nwhile read old new ref; do\n' +
        'if [ "$ref" = refs/heads/main ]; then exit 1; fi\ndone\n',
    )
    await chmod(hook, 0o755)
    const task = await setup.prepare()
    await setup.publish(task, 'one.txt', 'candidate\n')
    let attempts = 0
    await assert.rejects(
      mergeBranch(task, {
        message: 'Rejected integration',
        writePaths: ['one.txt'],
        async validate() {
          attempts++
          return setup.snapshot(task)
        },
      }),
      /failed/,
    )
    assert.equal(attempts, 1)
    assert.equal((await resolveRemote(setup.root)).base, setup.pinned.base)
  } finally {
    await rm(setup.directory, { recursive: true, force: true })
  }
})

test('review feedback is committed, pushed and checked again before merging main', async () => {
  const setup = await repository()

  try {
    const task = await setup.prepare()
    const first = await setup.publish(task, 'one.txt', 'initial candidate\n')
    const seen: string[] = []
    const merged = await mergeBranch(task, {
      message: 'Address independent review feedback',
      writePaths: ['one.txt'],
      validate: () => setup.snapshot(task),
      async afterBranchPush({ commit, baseTip }) {
        assert.equal(baseTip, setup.pinned.base)
        assert.equal((await resolveRemote(setup.root)).base, setup.pinned.base)
        const remote = await gitCommand(setup.root, [
          'ls-remote',
          'origin',
          `refs/heads/${task.branch}`,
        ])
        assert.equal(remote.split('\t')[0], commit)
        seen.push(commit)

        if (seen.length === 1) {
          await writeFile(join(task.workspace, 'one.txt'), 'reviewed repair\n')
          return setup.snapshot(task)
        }

        assert.equal(
          await gitCommand(task.workspace, ['show', `${commit}:one.txt`]),
          'reviewed repair',
        )
        return undefined
      },
    })
    assert.deepEqual(seen, [first, merged.commit])
    assert.notEqual(first, merged.commit)
    assert.equal((await resolveRemote(setup.root)).base, merged.commit)
    assert.equal(
      await gitCommand(setup.root, ['show', `${merged.commit}:one.txt`]),
      'reviewed repair',
    )
  } finally {
    await rm(setup.directory, { recursive: true, force: true })
  }
})

for (const kind of ['stale', 'scope', 'unchanged', 'unreported'] as const) {
  test(`review callback cannot publish ${kind} repair evidence`, async () => {
    const setup = await repository()

    try {
      const task = await setup.prepare()
      const stale = await setup.snapshot(task)
      const first = await setup.publish(task, 'one.txt', 'candidate\n')
      const expected = {
        stale: /changed after verification/,
        scope: /outside its assignment/,
        unchanged: /changed, freshly validated snapshot/,
        unreported: /without fresh validation evidence/,
      }
      await assert.rejects(
        mergeBranch(task, {
          message: 'Invalid feedback candidate',
          writePaths: ['one.txt'],
          validate: () => setup.snapshot(task),
          async afterBranchPush() {
            if (kind !== 'unchanged') {
              await writeFile(
                join(task.workspace, kind === 'scope' ? 'two.txt' : 'one.txt'),
                'unverified repair\n',
              )
            }

            return kind === 'unreported'
              ? undefined
              : kind === 'stale'
                ? stale
                : setup.snapshot(task)
          },
        }),
        expected[kind],
      )
      assert.equal((await resolveRemote(setup.root)).base, setup.pinned.base)
      const remote = await gitCommand(setup.root, [
        'ls-remote',
        'origin',
        `refs/heads/${task.branch}`,
      ])
      assert.equal(remote.split('\t')[0], first)
    } finally {
      await rm(setup.directory, { recursive: true, force: true })
    }
  })
}
