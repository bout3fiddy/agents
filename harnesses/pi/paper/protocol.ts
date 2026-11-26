import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export const limits = Object.freeze({
  timeoutMs: 5000,
  lifetimeMs: 30 * 60 * 1000,
  calls: 128,
  errors: 8,
  wireBytes: 16 * 1024 * 1024,
  frameBytes: 2 * 1024 * 1024,
  textBytes: 64 * 1024,
  imageBytes: 1024 * 1024,
  images: 8,
  nodes: 32,
  boards: 4,
  snapshots: 8,
})

export type Failure =
  | 'denied'
  | 'invalid'
  | 'busy'
  | 'read_only'
  | 'expired'
  | 'detached'
  | 'limit'
  | 'timeout'
  | 'unavailable'
  | 'unsupported'
  | 'wrong_target'
  | 'protocol'
  | 'storage'

export class Fault extends Error {
  readonly outcome: Failure

  constructor(outcome: Failure) {
    super(outcome)
    this.outcome = outcome
  }
}

export function fail(outcome: Failure): never {
  throw new Fault(outcome)
}

export function reason(error: unknown): Failure {
  return error instanceof Fault ? error.outcome : 'unavailable'
}

export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export type Launch = () => ChildProcessWithoutNullStreams

export const desktop: Launch = () => {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    fail('unsupported')
  }

  const bundle = '/Applications/Paper.app/Contents/Resources/app.asar.unpacked'
  return spawn(`${bundle}/dist/cli-bin/darwin-arm64/paper`, ['mcp'], {
    cwd: '/',
    env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin', TMPDIR: process.env.TMPDIR },
    stdio: 'pipe',
  })
}

type Pending = { id: number; resolve: (result: unknown) => void; reject: (error: Fault) => void }

/** One outstanding request, no queue. Unknown or oversized frames terminate the link. */
export class Wire {
  private readonly child: ChildProcessWithoutNullStreams
  private readonly buffer = Buffer.alloc(limits.frameBytes)
  private length = 0
  private bytes = 0
  private sequence = 0
  private pending?: Pending
  private timer?: NodeJS.Timeout
  private stopped?: Failure
  private readonly onStop: (failure: Failure) => void
  readonly closed: Promise<void>

  constructor(launch: Launch, onStop: (failure: Failure) => void) {
    this.onStop = onStop
    this.child = launch()
    this.closed = new Promise((resolve) => this.child.once('close', () => resolve()))
    this.child.once('close', () => this.stop('unavailable'))
    this.child.on('error', () => this.stop('unavailable'))

    for (const stream of [this.child.stdin, this.child.stdout, this.child.stderr]) {
      stream.on('error', () => this.stop('unavailable'))
    }

    this.child.stdout.on('data', (chunk: Buffer) => this.receive(chunk))
    this.child.stderr.on('data', (chunk: Buffer) => this.account(chunk.length))
  }

  stop(failure: Failure) {
    if (this.stopped) {
      return
    }

    this.stopped = failure
    clearTimeout(this.timer)
    this.pending?.reject(new Fault(failure))
    this.pending = undefined
    this.child.stdin.destroy()
    this.child.stdout.destroy()
    this.child.stderr.destroy()

    try {
      this.child.kill('SIGKILL')
    } catch {
      // Some sandboxes deny signals. EOF still closes stdio; the lease waits for actual exit.
    }

    this.onStop(failure)
  }

  private account(bytes: number) {
    this.bytes += bytes

    if (this.bytes > limits.wireBytes) {
      this.stop('limit')
    }
  }

  private receive(chunk: Buffer) {
    this.account(chunk.length)

    if (this.stopped) {
      return
    }

    const newline = chunk.indexOf(10)
    const bytes = newline === -1 ? chunk.length : newline

    if (this.length + bytes > this.buffer.length) {
      return this.stop('limit')
    }

    chunk.copy(this.buffer, this.length, 0, bytes)
    this.length += bytes

    if (newline === -1) {
      return
    }

    if (newline !== chunk.length - 1 || !this.pending) {
      return this.stop('protocol')
    }

    try {
      const packet: unknown = JSON.parse(this.buffer.toString('utf8', 0, this.length))
      this.length = 0

      if (!object(packet) || packet.jsonrpc !== '2.0' || packet.id !== this.pending.id) {
        return this.stop('protocol')
      }

      if ('error' in packet || !('result' in packet)) {
        return this.stop('protocol')
      }

      clearTimeout(this.timer)
      this.pending.resolve(packet.result)
      this.pending = undefined
    } catch {

      // Malformed desktop data never becomes a diagnostic containing document text.
      this.stop('protocol')
    }
  }

  private send(packet: unknown) {
    const line = JSON.stringify(packet) + '\n'

    if (Buffer.byteLength(line) > limits.textBytes) {
      fail('limit')
    }

    this.account(Buffer.byteLength(line))

    if (this.stopped) {
      fail(this.stopped)
    }

    this.child.stdin.write(line)
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.stopped) {
      fail(this.stopped)
    }

    if (this.pending) {
      fail('busy')
    }

    const id = ++this.sequence

    if (id > limits.calls) {
      fail('limit')
    }

    return new Promise((resolve, reject) => {
      this.pending = { id, resolve, reject }
      this.timer = setTimeout(() => this.stop('timeout'), limits.timeoutMs)
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  async discover(check: () => void) {
    check()
    const protocolVersion = '2024-11-05'
    const hello = await this.request('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'pih-paper', version: '1' },
    })

    if (!object(hello) || hello.protocolVersion !== protocolVersion) {
      fail('unsupported')
    }

    if (!object(hello.serverInfo) || hello.serverInfo.name !== 'paper-desktop') {
      fail('unsupported')
    }

    const probedVersion = hello.serverInfo.version === '0.0.1'
    check()

    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    const list = await this.request('tools/list', {})

    if (!object(list) || list.nextCursor || !Array.isArray(list.tools)) {
      fail('unsupported')
    }

    if (list.tools.length > 256) {
      fail('limit')
    }

    const schemas = new Map<string, Record<string, unknown>>()

    for (const tool of list.tools) {
      if (!object(tool) || typeof tool.name !== 'string' || !object(tool.inputSchema)) {
        continue
      }

      if (schemas.has(tool.name)) {
        fail('protocol')
      }

      if (object(tool.inputSchema.properties)) {
        schemas.set(tool.name, tool.inputSchema.properties)
      }
    }

    return { schemas, probedVersion }
  }

  async invoke(name: string, args: Record<string, unknown>) {
    const result = await this.request('tools/call', { name, arguments: args })

    if (!object(result) || result.isError || !Array.isArray(result.content)) {
      fail('protocol')
    }

    if (result.content.length !== 1 || !object(result.content[0])) {
      fail('protocol')
    }

    return result.content[0]
  }
}
