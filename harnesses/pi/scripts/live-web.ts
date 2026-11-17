import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StateStore, atomicJson } from '../src/state.ts'
import { harnessRoot, loadProject } from '../src/project.ts'
import { consultationInput, runDesignAdvice } from '../src/design-advice.ts'
import { dispatcher } from '../src/dispatch.ts'
import { fileHashes, inventory } from '../src/paths.ts'
import { parseClaudeTrace } from '../src/claude-worker.ts'

const root = await mkdtemp(join(tmpdir(), 'pi-live-web-'))
const store = new StateStore(root)
const reports = join(harnessRoot, 'reports', `web-${Date.now()}`)
await mkdir(reports, { recursive: true })
const question =
  'Use WebSearch to find official Node.js documentation for AbortSignal.any, then use WebFetch ' +
  'to read the official documentation page. Explain what happens if an input signal is already ' +
  'aborted, with a source URL. Actually use both tools; do not rely on memory. Keep it concise.'
await writeFile(join(root, 'requirements.md'), '# Research request\n\n' + question + '\n')
const hash = await store.draft({
  objective: 'Verify public documentation research and the scoped review bridge',
  design: 'Read requirements.md and verify the answer against official Node.js documentation.',
  invariants: ['No project changes'],
  acceptance: ['Use web search and fetch and provide the supporting official URL'],
  writePaths: ['requirements.md'],
  database: false,
  performance: false,
  unresolved: [],
})
const checkpoint = await store.accept(hash)
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 600000)
console.log(JSON.stringify({ root, reports }))

try {
  const advice = await runDesignAdvice(
    await consultationInput(store, { question, paths: ['requirements.md'] }, [question]),
    controller.signal,
    join(store.directory, 'web-advice.jsonl'),
  )
  assert.ok(advice.toolsUsed?.includes('WebSearch'))
  assert.ok(advice.toolsUsed?.includes('WebFetch'))
  assert.match(advice.text, /https:\/\/(?:nodejs\.org|nodejs\.org\/)/)
  console.log(JSON.stringify({ advisor: 'passed', tools: advice.toolsUsed }))
  const before = fileHashes(await inventory(root))
  const review = await dispatcher(store)(
    {
      role: 'reviewer',
      task:
        'Use project_read to read requirements.md, perform its requested web research, then ' +
        'use submit_result with your findings and the source URL in evidence. ' +
        'This is a read-only ' +
        'tool capability check, with no product implementation to test. Report any tool failure.',
      workspace: root,
      project: await loadProject(root),
      checkpoint,
      model: 'unused',
      baseline: before,
    },
    controller.signal,
  )
  assert.equal(review.result.verdict, 'pass')
  assert.match(JSON.stringify(review.result), /https:\/\/nodejs\.org/)
  assert.deepEqual(fileHashes(await inventory(root)), before)
  const traces = (await readdir(join(store.directory, 'attempts'))).filter((path) =>
    path.endsWith('.claude.jsonl'),
  )
  assert.equal(traces.length, 1)
  const { toolsUsed } = parseClaudeTrace(
    await readFile(join(store.directory, 'attempts', traces[0]!), 'utf8'),
  )
  assert.ok(toolsUsed.includes('WebSearch'))
  assert.ok(toolsUsed.includes('WebFetch'))
  assert.ok(toolsUsed.some((name) => name.endsWith('project_read')))
  assert.ok(toolsUsed.some((name) => name.endsWith('submit_result')))
  await atomicJson(join(reports, 'result.json'), {
    status: 'passed',
    root,
    state: store.directory,
    advice,
    review,
    reviewerTools: toolsUsed,
  })
  console.log(JSON.stringify({ status: 'passed', reviewerTools: toolsUsed, reports }))
} finally {
  clearTimeout(timer)
}
