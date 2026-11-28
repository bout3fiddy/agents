import { spawn } from 'node:child_process'
import { dirname, isAbsolute, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { HandoffStore } from './handoff-store.ts'
import { handleRequest, type HandleRequest } from './handoff-session.ts'
import { jobStore } from './job-tools.ts'
import { capturePiHost } from './pi-host.ts'

export function installedReceiver(agentDir: string, wrapper = capturePiHost().wrapper) {
  return (cwd: string, token: string) => {
    if (!wrapper || !isAbsolute(wrapper)) {
      throw new Error('No installed pih launcher')
    }

    const child = spawn(wrapper, ['project-receive', token], {
      cwd,
      detached: true,
      stdio: 'ignore',
      env: {
        HOME: join(agentDir, 'handoffs-v1'),
        PATH: [
          dirname(process.execPath),
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/bin',
          '/bin',
          '/usr/sbin',
          '/sbin',
        ].join(':'),
        PI_HARNESS_ISOLATION: 'required',
      },
    })

    // An exec failure is reported asynchronously as well as by the missing PID on POSIX.
    child.once('error', () => {})
    child.unref()

    if (!child.pid) {
      throw new Error('Destination failed to spawn')
    }

    return child.pid
  }
}

/** A tick never waits on a model. A foreground conversation can be busy while mail is served. */
export class Receiver {
  private handling?: Promise<void>
  private readonly controller = new AbortController()
  constructor(
    readonly mail: HandoffStore,
    readonly root: string,
    readonly name: string,
    readonly token: string,
    private handle: HandleRequest = handleRequest,
  ) {}

  tick(cold: boolean) {
    if (!this.mail.heartbeat(this.root, this.token, cold, this.name)) {
      return false
    }

    const jobs = this.mail.jobs(this.name)

    if (jobs.length) {
      const store = jobStore(this.root)
      store.reconcile()

      for (const item of jobs) {
        const job = store.find(item.job)

        if (!job || job.session !== item.id) {
          this.mail.finish(item.id, 'failed', 'Destination job record is missing; inspect locally.')
        } else if (job.status !== 'running' && job.status !== 'queued') {
          this.mail.finish(
            item.id,
            job.status === 'done' ? 'done' : 'failed',
            `${job.status}: ${job.summary || job.error || 'Inspect the destination job.'}`,
          )
        } else if (job.status === 'queued' && Date.now() - Date.parse(job.createdAt) > 60_000) {
          store.failUnclaimed(job.id)
        }
      }

      return true
    }

    if (this.handling) {
      return true
    }

    const request = this.mail.claim(this.name, this.token)

    if (request) {
      this.handling = this.handle(this.mail, this.root, request, this.controller.signal)
        .catch(() => {
          this.mail.failHandling(
            request.id,
            'Destination could not complete its turn. Check model ' +
              'settings, authentication and project instructions there. Do not blindly resend.',
          )
        })
        .finally(() => {
          this.handling = undefined
        })
    }

    return true
  }

  idleExit() {
    return !this.handling && this.mail.release(this.name, this.token, true)
  }

  async close() {
    this.controller.abort()

    try {
      this.mail.release(this.name, this.token, false)
    } finally {
      try {
        await this.handling
      } finally {
        this.mail.close()
      }
    }
  }
}

export async function serve(root: string, token: string) {
  const mail = HandoffStore.open()
  const project = mail?.local(root)

  if (!mail || !project) {
    mail?.close()
    throw new Error('No enrolled destination here')
  }

  const receiver = new Receiver(mail, root, project.name, token)

  try {

    // A detached host serves until its generation loses ownership or drains all admitted work.
    while (receiver.tick(true) && !receiver.idleExit()) {
      await delay(500)
    }
  } finally {
    await receiver.close()
  }
}
