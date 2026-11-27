import { lstat, opendir, realpath } from 'node:fs/promises'
import { relative, resolve } from 'node:path'
import type { ToolCallEvent } from '@earendil-works/pi-coding-agent'

type FileCall = Pick<ToolCallEvent, 'toolName' | 'input'>

export const workerHandoff =
  'Host file tools are for setup, private scratch and small workshop decisions. ' +
  'Send repair evidence to the running job with job_message, or start a job with the ' +
  'affected paths and acceptance check. Do not use bash to bypass routing.'

const setupFiles = new Set([
  'AGENTS.md',
  'TIGER_STYLE.md',
  '.gitignore',
  '.prettierignore',
  '.prettierrc',
  '.prettierrc.json',
])
const freshEntries = new Set([...setupFiles, '.git', '.pi', 'TIGER_STYLE_LICENSE'])
const bootstrapEntries = new Set([
  ...freshEntries,
  'README.md',
  'package.json',
  'package-lock.json',
  'node_modules',
])
const decisionBytes = 4096

async function containsOnly(root: string, allowed: ReadonlySet<string>): Promise<boolean> {

  // Directory names are unique: at most allowed.size + 1 entries before a decision.
  for await (const entry of await opendir(root)) {
    if (!allowed.has(entry.name)) {
      return false
    }
  }

  return true
}

/** Take the baseline before any setup command can create a manifest in this request. */
export async function freshBootstrapRoot(cwd: string): Promise<string | undefined> {
  return (await containsOnly(cwd, freshEntries)) ? realpath(cwd) : undefined
}

function smallDecision(event: FileCall, existingBytes: number): boolean {
  const input = event.input as {
    content?: string
    edits?: { oldText: string; newText: string }[]
  }

  if (event.toolName === 'edit') {
    let bytes = 0

    for (const edit of input.edits ?? []) {
      bytes += Buffer.byteLength(edit.oldText) + Buffer.byteLength(edit.newText)

      if (!edit.oldText || bytes > decisionBytes) {
        return false
      }
    }

    return Boolean(input.edits?.length)
  }

  return existingBytes <= decisionBytes && Buffer.byteLength(input.content ?? '') <= decisionBytes
}

/** Classify actual destinations, not extensions or claimed intent. Reservations take precedence. */
export async function hostFileAllowed(
  root: string,
  cwd: string,
  destination: string,
  event: FileCall,
  bootstrapRoot: string | undefined,
): Promise<boolean> {
  const name = relative(root, destination)
  const sessionPath = relative(cwd, destination)
  const stat = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') {
      return undefined
    }

    throw error
  })

  // realpath cannot resolve a dangling final link. A hard link can alias product data too.
  if (stat && (!stat.isFile() || stat.nlink !== 1)) {
    return false
  }

  if (sessionPath === 'design.md' || sessionPath === 'design/design.md') {
    return smallDecision(event, stat?.size ?? 0)
  }

  return (
    setupFiles.has(name) ||
    (root === bootstrapRoot &&
      (name === 'README.md' || name === 'package.json') &&
      (await containsOnly(root, bootstrapEntries))) ||
    destination === resolve(cwd, '.pi/harness.json') ||
    sessionPath.startsWith('.pi/traces/scratch/')
  )
}
