import { format, getFileInfo } from 'prettier'
import type { WorkerEvidence } from './contracts.ts'
import { harnessFormatOptions } from './document-tools.ts'
import { digest, fileHashes, safePath, writable } from './paths.ts'

// @ts-expect-error Shared formatting code is JavaScript.
import { addReadabilitySpacing } from '../scripts/linting/readability.mjs'

export async function formatSource(source: string, path: string): Promise<string> {
  const formatted = await format(source, { ...harnessFormatOptions, filepath: path })
  return addReadabilitySpacing(formatted, path)
}

// Bind an explicitly formatting-only verdict to the bytes the pinned formatter would produce.
// Workers never supply the proof. Older or ambiguous verdicts go through ordinary review.
export async function bindFormatterProof(
  review: WorkerEvidence,
  files: Map<string, Buffer>,
  workspace: string,
  scope: string[],
): Promise<void> {
  const result = review.result

  if (result.verdict !== 'changes') {
    return
  }

  const required = result.findings.filter((finding) => finding.severity === 'required')

  if (
    !required.length ||
    required.some(
      ({ formatterPath, location }) =>
        !formatterPath || (location !== formatterPath && !location.startsWith(formatterPath + ':')),
    )
  ) {
    return
  }

  const proof: NonNullable<WorkerEvidence['formatterProof']> = []

  try {
    const ignorePath = await safePath(workspace, '.prettierignore')

    for (const path of new Set(required.map((finding) => finding.formatterPath!))) {
      const bytes = files.get(path)

      if (!bytes || !writable(path, scope)) {
        return
      }

      const absolute = await safePath(workspace, path)
      const info = await getFileInfo(absolute, { ignorePath, resolveConfig: false })

      if (info.ignored || !info.inferredParser) {
        return
      }

      const source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
      const formatted = await formatSource(source, path)

      if (formatted === source || (await formatSource(formatted, path)) !== formatted) {
        return
      }

      proof.push({ path, before: digest(bytes), after: digest(formatted) })
    }
  } catch {

    // Unavailable formatter, unsupported syntax or inaccessible paths require a fresh reviewer.
    return
  }

  review.formatterProof = proof
}

export function formatterClosures(
  history: WorkerEvidence[],
  candidate: Map<string, Buffer>,
): WorkerEvidence[] {
  const reviews = ['reviewer', 'database-reviewer']
    .map((role) => history.findLast((review) => review.role === role))
    .filter((review): review is WorkerEvidence => Boolean(review))
  const source = reviews.find((review) => review.formatterProof?.length)

  if (!source) {
    return []
  }

  const sameSnapshot = reviews.filter((review) => review.snapshot === source.snapshot)
  const proof = sameSnapshot.flatMap((review) => review.formatterProof ?? [])
  const hashes = fileHashes(candidate)

  if (
    !proof.every((file) => Object.hasOwn(hashes, file.path) && hashes[file.path] === file.after)
  ) {
    return []
  }

  const snapshot = digest(JSON.stringify(hashes))

  for (const file of proof) {
    hashes[file.path] = file.before
  }

  if (digest(JSON.stringify(hashes)) !== source.snapshot) {
    return []
  }

  const paths = [...new Set(proof.map((file) => file.path))]
  return sameSnapshot
    .filter((review) => review.formatterProof?.length || review.result.verdict === 'pass')
    .map((review) => ({
      role: review.role,
      model: 'harness/formatter',
      turns: 0,
      snapshot,
      closedReview: { snapshot: source.snapshot, model: review.model, paths },
      result: {
        ...review.result,
        verdict: 'pass',
        summary:
          'Verified the complete candidate differs from the reviewed snapshot only by ' +
          'the pinned formatter output on the listed files.',
        findings: review.result.findings.filter((finding) => finding.severity !== 'required'),
      },
      commands: [],
    }))
}
