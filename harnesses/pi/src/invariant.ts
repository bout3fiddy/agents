/** Internal invariants fail loudly in production. Invalid external input uses ordinary errors. */
export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`Invariant violated: ${message}`)
  }
}
