# Runtime Scripts

- `runner.ts`: registers `/eval` and orchestrates a run.
- `worker.ts`: worker-mode runtime that captures reads and writes results.
- `case-process.ts`: low-level worker process/RPC lifecycle.
- `case-lifecycle.ts`: sandbox/home lifecycle and per-case execution flow.
- `case-execution.ts`: parallel case execution entrypoint.
- `sandbox.ts`: sandbox filesystem and home setup/cleanup.
- `scoring.ts`: evaluates case outputs against expectations.
- `capture.ts`: tracks skill/reference read attempts/invocations.
- `worker-contract.ts`: shared runner↔worker env/runtime contract.
- `model-registry.ts`: model selection/auth helpers.
- `parallel.ts`: generic parallel work executor.
- Harness policy: `case-process.ts` must execute only fixture-provided prompts (no runtime routing prompt injection).
- Sandbox policy: `worker.ts` enforces sandbox boundary checks for `read`, `edit`, and `write`, and emits `FORBIDDEN_WORKSPACE_VIOLATION` on boundary breaches.
- Boundary helpers live in `sandbox-boundary.ts` so unit tests can validate sandbox business logic without loading `pi-coding-agent` runtime dependencies.
- Cases with `persistArtifacts: true` copy files listed in `fileAssertions[].path` from sandbox workspace back to the host repo before sandbox cleanup (used by CD-015 visual diff workflow).
