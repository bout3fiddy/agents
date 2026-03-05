# Runtime Scripts

Organized by subdomain. Each subfolder groups related modules.

## `entry/` — Entrypoints

- `runner.ts`: registers `/eval` and orchestrates a run.
- `worker.ts`: worker-mode orchestrator — registers tools, event handlers, and persist logic. Delegates tool creation to `worker/worker-tools.ts` and accumulation to `worker/worker-accumulator.ts`.

## `case/` — Case Lifecycle

- `case-execution.ts`: parallel case execution entrypoint.
- `case-lifecycle.ts`: sandbox/home lifecycle and per-case execution flow orchestrator. Delegates bootstrap to `bootstrap.ts` and policy to `policy/case-policy.ts`.
- `case-process.ts`: worker process/RPC lifecycle orchestrator. Delegates guest path mapping to `sandbox/guest-paths.ts`, RPC diagnostics to `rpc/rpc-diagnostics.ts`, and retry state to `rpc/rpc-state.ts`.
- `bootstrap.ts`: bootstrap profile resolution, home setup, auth copying, skill discovery, workspace mirroring, and preflight validation.
- `evaluation.ts`: assembles `CaseEvaluation` and routing scorecards from run results. No pass/fail logic — judge decides.

## `engine/` — Sandbox Engine

- `sandbox-engine.ts`: mandatory sandbox interface and provider allowlist policy.
- `gondolin-engine.ts`: Gondolin VM-backed implementation of worker launch. No host `.codex` config is mounted — sandbox processes run without host codex state.

## `sandbox/` — Sandbox Filesystem

- `sandbox.ts`: sandbox filesystem and home setup/cleanup.
- `sandbox-boundary.ts`: sandbox boundary checks and tool wrapping for out-of-sandbox write/edit blocking.
- `guest-paths.ts`: guest VM path constants and host-to-guest path mapping.

## `policy/` — Path & Read Policy

- `path-policy.ts`: unified path predicates (prefix checks, inside-root, symlink resolution, segment sanitization, managed temp path assertions).
- `read-policy.ts`: read deny policy creation and path assertion.
- `case-policy.ts`: read deny policy configuration, no-payload workspace hardening, and policy deny probe validation.

## `rpc/` — RPC Messaging

- `rpc-messages.ts`: shared message helpers (text collection, usage summation, terminal error extraction).
- `rpc-diagnostics.ts`: RPC event stream tracking, timeout diagnostics, and trace persistence.
- `rpc-state.ts`: RPC retry settle timer, agent_end resolution, and prompt error tracking.

## `worker/` — Worker Tools & Capture

- `worker-tools.ts`: tool creation (read/edit/write) with sandbox boundary and deny policy enforcement, read capture event hooks.
- `worker-accumulator.ts`: token usage accumulation, turn breakdown tracking, read breakdown categorization, and final `CaseRunResult` assembly.
- `worker-contract.ts`: shared runner↔worker env/runtime contract.
- `capture.ts`: tracks skill/reference read attempts/invocations during worker execution.

## `model/` — Model Registry

- `model-registry.ts`: model selection/auth helpers.

## `util/` — Utilities

- `parallel.ts`: generic parallel work executor.

## Cross-Cutting Policies

- Harness policy: `case/case-process.ts` must execute only fixture-provided prompts (no runtime routing prompt injection).
- Sandbox policy: `entry/worker.ts` enforces sandbox boundary checks for `read`, `edit`, and `write`, and emits `FORBIDDEN_WORKSPACE_VIOLATION` on boundary breaches.
- Boundary helpers live in `sandbox/sandbox-boundary.ts` so unit tests can validate sandbox business logic without loading `pi-coding-agent` runtime dependencies.
- Cases with `persistArtifacts: true` copy files listed in `fileAssertions[].path` from sandbox workspace back to the host repo before sandbox cleanup (used by CD-015 visual diff workflow).
- RPC lifecycle nuance: some providers emit an intermediate `agent_end` with `stopReason:error` and `errorMessage:terminated` before `auto_retry_start`; treat that `agent_end` as provisional until retry settlement (`auto_retry_start`/`auto_retry_end`) to avoid premature case finalization. Retry settle windows differ by scope: 3s prompt-level (entry/worker.ts) vs 1.5s case-level (case/case-process.ts) — see cross-reference comments in both files.
- Full-payload bootstrap mirrors synced home assets into workspace canonical paths (`/workspace/AGENTS.md`, `/workspace/skills/*`, `/workspace/workflows/*`) because models often resolve project instructions relative to `/workspace`.
