import type { Receipt } from './contracts.ts'

export function receiptView(receipt: Receipt) {
  const limit = receipt.status === 'passed' ? 2000 : 4000
  const { output } = receipt.result
  const tsxIpcDenied =
    receipt.status === 'failed' &&
    /^> tsx --test(?:\s|$)/m.test(output) &&
    /Error: listen EPERM:[^\n]*\/pi-command-[^/\s]+\/tsx-\d+\/\d+\.pipe\b/.test(output)
  return {
    ...(tsxIpcDenied && {
      diagnostic:
        'The tsx test launcher was denied a private IPC socket. ' +
        'The host can diagnose the declared check or configure the project to use ' +
        'node --import tsx --test with equivalent test selection and rerun the gate.',
    }),
    ...(receipt.inheritedLintPaths?.length && { inheritedLintPaths: receipt.inheritedLintPaths }),

    // Blocking lint findings exclude inherited ones; the raw output stays in the receipt.
    ...(receipt.scopedLintOutput && { scopedLintOutput: receipt.scopedLintOutput }),
    check: receipt.check,
    status: receipt.status,
    snapshot: receipt.snapshot,
    argv: receipt.result.argv,
    exitCode: receipt.result.exitCode,
    output: (receipt.scopedLintOutput ?? receipt.result.output).slice(-limit),
    outputExcerpted: (receipt.scopedLintOutput ?? receipt.result.output).length > limit,
    timedOut: receipt.result.timedOut,
    aborted: receipt.result.aborted,
    truncated: receipt.result.truncated,
  }
}
