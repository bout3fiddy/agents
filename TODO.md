# TODO: PI Eval + Gondolin Debug Status

Last updated: 2026-03-02
Scope: `skills-evals/pi-eval` sandboxed eval execution (`run.sh`) with Gondolin runtime

## Goal

Run PI eval cases fully sandboxed by default (no special flag), with outbound HTTPS access for cloud model providers, and stable per-case execution for fixtures such as `CD-015`.

## What We Completed

- Implemented Gondolin-backed sandbox runtime wiring in the PI eval flow.
- Added runtime instrumentation in `case-process` for RPC lifecycle debugging:
  - event counts
  - retry markers (`auto_retry_start`, `auto_retry_end`)
  - per-tool lifecycle signals
  - timeout diagnostics hints
- Added diagnostics persistence when `PI_EVAL_RPC_TRACE_DIR` is set:
  - `<case>.jsonl` raw RPC stream
  - `<case>.diagnostics.json` summarized lifecycle diagnostics
- Added tests for diagnostics/timeout behavior in case-process runtime tests.
- Confirmed eval invocation path through canonical wrapper (`./skills-evals/run.sh`).
- Added Gondolin image/runtime setup work (including PI image path plumbing) and verified execution reaches the model runtime inside VM.

## Current Problem

`CD-015` still fails under sandbox execution, but the dominant failure is now transport/provider instability during the model run, not simple local fixture absence.

Observed behavior in latest instrumented run:

- First attempt performs initial read operations.
- Agent terminates with provider error (`502 Bad Gateway`).
- `auto_retry_start` is emitted.
- Retry does not cleanly complete (`auto_retry_end` missing) before timeout.
- No successful write execution happens before timeout.

## Evidence Snapshot

From the latest run:

- command:
  - `PI_EVAL_MAX_PARALLEL=1 PI_EVAL_CASE_TIMEOUT_MS=90000 PI_EVAL_RPC_TRACE_DIR=/tmp/pi-eval-rpc-cd015-now GONDOLIN_DEBUG=net,exec,protocol ./skills-evals/run.sh --case CD-015`
- diagnostics show:
  - `lastAgentStopReason = error`
  - `lastAgentErrorMessage = 502 Bad Gateway`
  - `autoRetryStartCount = 1`
  - `autoRetryEndCount = 0`
- Gondolin debug output includes repeated HTTP bridge failures to codex responses endpoint (`fetch failed`).

## How Far We Got

- Sandbox runtime integration: in place.
- Instrumentation for deep runtime debugging: in place and useful.
- Root cause narrowed from "missing files" to retry/transport instability during provider calls in this execution path.
- Still not at stable pass for `CD-015` end-to-end in Gondolin sandbox mode.

## Next Steps

1. Add explicit bridge-level error capture around outbound model calls (status, response body fragment, retry attempt metadata, timing) and emit this into diagnostics artifacts.
2. Add retry watchdog logic in runtime to detect stalled retry sequences (`auto_retry_start` without follow-up terminal event) and fail fast with precise category instead of generic timeout.
3. Run targeted A/B checks:
   - same case outside Gondolin vs inside Gondolin
   - shorter vs longer timeout windows
   - confirm whether failure pattern is provider-transient or Gondolin bridge-specific.
4. If bridge-specific, patch the Gondolin integration layer (or adapter settings) for resilient reconnect/backoff semantics during response streaming.
5. Re-run `CD-015` and one control case after patch, then promote to a short smoke suite.

## Repo Hygiene Decision (Current)

To avoid repo bloat from eval artifacts, `skills-evals/reports/` (including routing traces) is now intended to remain local-only and untracked in git.
