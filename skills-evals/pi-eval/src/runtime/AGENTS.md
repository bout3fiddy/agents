# Eval Runtime Guardrails

Scope: `skills-evals/pi-eval/src/runtime/**`.

- `entry/runner.ts` owns `/eval`; `entry/worker.ts` owns the isolated worker.
  Worker behavior must activate only with `PI_EVAL_WORKER=1`.
- Every case uses the mandatory `SandboxEngine` boundary. Gondolin launch and
  guest preflight failures fail closed; never fall back to a host process.
- Execute only prompts and turns declared by the case fixture. Runtime skill
  routing must not modify the prompt.
- Enforce read-deny and write boundaries in worker tools, with shared path policy
  helpers that resolve symlinks and restrict recursive cleanup to managed temp
  roots.
- Full-payload bootstrap stages `AGENTS.md` and selected `skills/*` at canonical
  workspace paths. No-payload cases remove instruction payloads and validate a
  forbidden-read probe before execution.
- Treat an `agent_end` with `stopReason:error` and `errorMessage:terminated` as
  provisional while an automatic retry may still start. Keep retry-settlement
  behavior covered by lifecycle tests.
- `persistArtifacts` may copy only paths declared by case file assertions back
  to the host before sandbox cleanup.
- Keep deterministic verification results separate from judge comparison:
  individual task success must not be overwritten by a skill-benefit verdict.
