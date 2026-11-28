import { HandoffStore } from './handoff-store.ts'
import { serve } from './handoff-receiver.ts'

const [command, argument, ...extra] = process.argv.slice(2)

if (process.env.PI_HARNESS_WORKER || !argument || extra.length) {
  throw new Error('Expected one project name or request identifier in a local user shell')
}

const root = process.cwd()

if (command === 'project-receive') {
  await serve(root, argument)
} else {
  const mail = HandoffStore.open(undefined, command === 'project-enroll')

  if (!mail) {
    throw new Error('No project enrollment')
  }

  try {
    if (command === 'project-enroll') {
      mail.enroll(root, argument)
      console.log(`Enrolled ${argument} for handoffs only. Execution trust is unchanged.`)
    } else if (command === 'project-leave') {
      mail.leave(root, argument)
      console.log('Removed handoff enrollment. Execution trust is unchanged.')
    } else if (command === 'project-forget') {
      mail.forget(root, argument)
      console.log('Removed collected request and its idempotency key.')
    } else {
      throw new Error('Unknown project command')
    }
  } finally {
    mail.close()
  }
}
