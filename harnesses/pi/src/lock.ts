import { spawn } from 'node:child_process'

export type ReleaseLock = (() => Promise<void>) & { assertHeld: () => void }

const helper = `
import fcntl, json, os, sys
fd = os.open(sys.argv[1], os.O_CREAT | os.O_RDWR, 0o600)
try:
    fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.exit(2)
os.ftruncate(fd, 0)
os.write(fd, json.dumps({"version": 1, "supervisor": int(sys.argv[2]),
                         "helper": os.getpid()}).encode())
os.fsync(fd)
print("READY", flush=True)
sys.stdin.buffer.read()
os.close(fd)
`

export async function acquireLock(path: string): Promise<ReleaseLock> {
  const child = spawn('python3', ['-I', '-u', '-c', helper, path, String(process.pid)], {
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let acquired = false
  let released = false
  let diagnostics = ''
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()))
  child.stdin.on('error', () => {})
  child.stderr.on('data', (chunk: Buffer) => {
    diagnostics = (diagnostics + chunk.toString()).slice(-1000)
  })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Project lock helper did not start within 5 seconds'))
    }, 5000)
    child.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.stdout.once('data', (chunk: Buffer) => {
      clearTimeout(timer)
      acquired = chunk.toString().trim() === 'READY'

      if (acquired) {
        resolve()
      } else {
        child.stdin.end()
        reject(new Error('Invalid project lock response'))
      }
    })
    child.once('close', (code) => {
      clearTimeout(timer)

      if (!acquired) {
        reject(
          new Error(
            code === 2
              ? 'A workflow is already running for this project'
              : `Project lock failed: ${diagnostics}`,
          ),
        )
      }
    })
  })
  const release = async () => {
    released = true
    child.stdin.end()
    await closed
  }
  release.assertHeld = () => {
    if (released || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('Project lock was lost; stop this workflow')
    }
  }
  return release
}
