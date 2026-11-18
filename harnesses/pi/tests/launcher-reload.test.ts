import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { install } from '../scripts/install.ts'

test('installed Pi reloads new tools under the active role policy', async (t) => {
  const base = await mkdtemp(join(tmpdir(), 'pi-launcher-reload-'))
  t.after(() => rm(base, { recursive: true, force: true }))
  const root = join(base, 'project')
  await mkdir(root)
  const { wrapper } = await install(join(base, 'private'))
  const probe = join(base, 'probe.ts')
  const receipt = join(base, 'probe.json')
  const source = (generation: number) =>
    "import {writeFileSync} from 'node:fs'\nexport default function(pi) {\n" +
    "pi.registerCommand('reload-fixture',{handler: async (_a,ctx) => {await ctx.reload()}})\n" +
    (generation === 2
      ? "pi.registerTool({name:'future_probe',description:'test',label:'test'," +
        "parameters:{type:'object',properties:{}},execute:async()=>({content:[]})})\n"
      : '') +
    'pi.on("session_start", e=>writeFileSync(' +
    JSON.stringify(receipt) +
    ',JSON.stringify({reason:e.reason, registered:pi.getAllTools().map(x=>x.name),' +
    'active:pi.getActiveTools()})))}'
  await writeFile(probe, source(1))
  const child = spawn(wrapper, ['--mode', 'rpc', '--extension', probe], {
    cwd: root,
    stdio: ['pipe', 'ignore', 'pipe'],
  })
  let diagnostics = ''
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk).slice(-1000)
  })
  const closed = once(child, 'close')
  t.after(async () => {
    child.kill()
    await closed
  })
  const load = async (reason: string) => {
    const deadline = Date.now() + 15000

    while (Date.now() < deadline && child.exitCode === null) {
      const raw = await readFile(receipt, 'utf8').catch(() => '')

      if (raw) {
        const event = JSON.parse(raw)

        if (event.reason === reason) {
          return event
        }
      }

      await delay(50)
    }

    throw new Error('Missing ' + reason + ' receipt: ' + diagnostics)
  }
  const first = await load('startup')
  assert.ok(first.active.includes('recurring_task'))
  assert.ok(!first.registered.includes('future_probe'))
  await writeFile(probe, source(2))
  child.stdin.write(JSON.stringify({ type: 'prompt', message: '/reload-fixture' }) + '\n')
  const next = await load('reload')
  assert.ok(next.registered.includes('future_probe'))
  assert.ok(next.active.includes('recurring_task'))
  assert.ok(!next.active.includes('future_probe'))
})
