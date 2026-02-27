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
