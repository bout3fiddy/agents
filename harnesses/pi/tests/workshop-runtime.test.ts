import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Type } from 'typebox'
import type { ExtensionFactory } from '@earendil-works/pi-coding-agent'
import { registerWorkshop } from '../src/workshop.ts'
import { StateStore } from '../src/state.ts'
import type { Advice } from '../src/design-advice.ts'
import { fixture } from './support.ts'
import { captureSession } from './session-support.ts'

for (const mode of ['wait', 'cancel', 'automatic'] as const) {
  const lateWait = mode !== 'automatic'
  test(`Pi consumes completed advice once (${mode})`, async () => {
    const item = await fixture()
    let finish!: (advice: Advice) => void
    const advice = new Promise<Advice>((resolve) => {
      finish = resolve
    })
    let workshop!: ReturnType<typeof registerWorkshop>
    let id = ''
    let step = 0
    const payloads: string[] = []
    const extension: ExtensionFactory = (pi) => {
      workshop = registerWorkshop(pi, async () => advice)
      pi.registerTool({
        name: 'finish_advice',
        label: 'Finish advice',
        description: 'Fixture',
        parameters: Type.Object({}),
        async execute() {
          finish({ text: 'UNIQUE_ADVICE_MARKER', model: 'fixture' })
          await workshop.consultations.settle(id, false)
          return { content: [{ type: 'text', text: 'boundary work complete' }], details: {} }
        },
      })
    }
    const { session, runtime } = await captureSession(
      item.root,
      item.base,
      [extension],
      async (context) => {
        payloads.push(JSON.stringify(context))
        step++

        if (step === 1) {
          return [
            {
              type: 'toolCall',
              id: 'start',
              name: 'consult_design',
              arguments: { question: 'Independent advice please' },
            },
          ]
        }

        if (step === 2) {
          if (lateWait) {

            // Regression: Fable finishes during model generation, before a later wait call.
            finish({ text: 'UNIQUE_ADVICE_MARKER', model: 'fixture' })
            await workshop.consultations.settle(id, false)
            return [
              {
                type: 'toolCall',
                id: 'wait',
                name: 'design_consultation',
                arguments: { id, action: mode },
              },
            ]
          }

          return [{ type: 'toolCall', id: 'finish', name: 'finish_advice', arguments: {} }]
        }

        if (step === 3 && !lateWait) {

          // Already delivered automatically; a subsequent wait must not repeat the payload.
          return [
            {
              type: 'toolCall',
              id: 'wait',
              name: 'design_consultation',
              arguments: { id, action: 'wait' },
            },
          ]
        }

        return [{ type: 'text', text: 'Finished using the advice.' }]
      },
    )
    session.subscribe((event) => {
      if (event.type === 'tool_execution_end' && event.toolName === 'consult_design') {
        const part = event.result.content[0]

        if (part?.type === 'text') {
          id = JSON.parse(part.text).id
        }
      }
    })

    try {
      await session.prompt('Workshop a new design question')
      await session.waitForIdle()
      assert.equal(step, lateWait ? 3 : 4, 'No extra reply after completion')
      assert.equal(
        payloads[2]!.split('UNIQUE_ADVICE_MARKER').length - 1,
        mode === 'cancel' ? 0 : 1,
        'Advice must reach the next model step',
      )
      assert.equal(
        payloads.at(-1)!.split('UNIQUE_ADVICE_MARKER').length - 1,
        mode === 'cancel' ? 0 : 1,
      )
      const records = session.sessionManager
        .getBranch()
        .filter(
          (entry) => entry.type === 'custom_message' && entry.customType === 'pi-design-advice',
        )
      assert.equal(records.length, lateWait ? 0 : 1)
      const store = new StateStore(item.root)
      const saved = JSON.parse(
        await readFile(join(store.directory, 'consultations', `${id}.json`), 'utf8'),
      )
      assert.equal(
        saved.delivery.via,
        mode === 'cancel' ? 'cancelled' : lateWait ? 'tool' : 'automatic',
      )
    } finally {
      await workshop.consultations.close()
      session.dispose()
      await runtime.settleCredentialWrites()
      await rm(item.base, { recursive: true, force: true })
    }
  })
}

for (const explicitWait of [false, true]) {
  test(`newer user input suppresses obsolete advice (explicit wait ${explicitWait})`, async () => {
    const item = await fixture()
    let finish!: (advice: Advice) => void
    const advice = new Promise<Advice>((resolve) => {
      finish = resolve
    })
    let workshop!: ReturnType<typeof registerWorkshop>
    let id = ''
    let step = 0
    const extension: ExtensionFactory = (pi) => {
      workshop = registerWorkshop(pi, async () => advice)
    }
    const { session, runtime } = await captureSession(
      item.root,
      item.base,
      [extension],
      async () => {
        step++

        if (step === 1) {
          return [
            {
              type: 'toolCall',
              id: 'start',
              name: 'consult_design',
              arguments: { question: 'Should transfer and burn be separate?' },
            },
          ]
        }

        if (step === 3) {
          finish({ text: 'OBSOLETE_SEPARATE_TRANSACTIONS', model: 'fixture' })
          await workshop.consultations.settle(id, false)

          if (explicitWait) {
            return [
              {
                type: 'toolCall',
                id: 'old-wait',
                name: 'design_consultation',
                arguments: { id, action: 'wait' },
              },
            ]
          }
        }

        return [{ type: 'text', text: 'User choice recorded.' }]
      },
    )
    session.subscribe((event) => {
      if (event.type === 'tool_execution_end' && event.toolName === 'consult_design') {
        const part = event.result.content[0]

        if (part?.type === 'text') {
          id = JSON.parse(part.text).id
        }
      }
    })

    try {
      await session.prompt('Consider separate transfers')
      await session.waitForIdle()
      await session.prompt('Correction: transfer then burn atomically in one transaction')
      await session.waitForIdle()
      assert.equal(step, explicitWait ? 4 : 3)
      const store = new StateStore(item.root)
      const saved = await workshop.consultations.get(
        store,
        session.sessionManager.getSessionId(),
        id,
      )
      assert.equal(saved.delivery?.via, 'superseded')
      assert.doesNotMatch(
        JSON.stringify(session.sessionManager.buildSessionContext()),
        /OBSOLETE_SEPARATE_TRANSACTIONS/,
      )
    } finally {
      session.dispose()
      await runtime.settleCredentialWrites()
      await rm(item.base, { recursive: true, force: true })
    }
  })
}

test('one unreadable result cannot discard another ready result', async () => {
  const item = await fixture()
  let finish!: (advice: Advice) => void
  const advice = new Promise<Advice>((resolve) => {
    finish = resolve
  })
  let workshop!: ReturnType<typeof registerWorkshop>
  const ids: string[] = []
  const payloads: string[] = []
  const extension: ExtensionFactory = (pi) => {
    workshop = registerWorkshop(pi, async () => advice)
    pi.registerTool({
      name: 'finish_advice',
      label: 'Finish',
      description: 'Fixture',
      parameters: Type.Object({}),
      async execute() {
        finish({ text: 'GOOD_ADVICE_MARKER', model: 'fixture' })
        await Promise.all(ids.map((id) => workshop.consultations.settle(id, false)))
        const store = new StateStore(item.root)
        await rm(join(store.directory, 'consultations', `${ids[0]}.json`))
        return { content: [{ type: 'text', text: 'ready' }], details: {} }
      },
    })
  }
  const { session, runtime } = await captureSession(
    item.root,
    item.base,
    [extension],
    async (context) => {
      payloads.push(JSON.stringify(context))

      if (payloads.length === 1) {
        return ['first', 'second'].map((id) => ({
          type: 'toolCall' as const,
          id,
          name: 'consult_design',
          arguments: { question: id },
        }))
      }

      if (payloads.length === 2) {
        return [{ type: 'toolCall', id: 'finish', name: 'finish_advice', arguments: {} }]
      }

      return [{ type: 'text', text: 'Used the surviving advice.' }]
    },
  )
  session.subscribe((event) => {
    if (event.type === 'tool_execution_end' && event.toolName === 'consult_design') {
      const part = event.result.content[0]

      if (part?.type === 'text') {
        ids.push(JSON.parse(part.text).id)
      }
    }
  })

  try {
    await session.prompt('Two independent questions')
    await session.waitForIdle()
    assert.equal(payloads.length, 3)
    assert.equal(payloads.at(-1)!.split('GOOD_ADVICE_MARKER').length - 1, 1)
    assert.equal(workshop.consultations.available(session.sessionManager.getSessionId()).length, 0)
  } finally {
    session.dispose()
    await runtime.settleCredentialWrites()
    await rm(item.base, { recursive: true, force: true })
  }
})
