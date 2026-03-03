# AGENTS: `skills-evals`

Scope: applies to all files under `skills-evals/`.

## Purpose

`skills-evals` owns the eval framework assets for this repo (extension code, cases/specs, fixtures, reports).

## Coding Guardrails

- Prefer the lowest-LOC solution that preserves behavior.
- Reuse existing helpers/components/modules before adding new files or abstractions.
- Remove dead code, stale flags, and unused modes instead of preserving compatibility layers.
- Keep changes non-destructive unless explicitly requested.
- Avoid speculative generality. Add complexity only when there is a concrete requirement.
- Speculative generality rule: do not add “future-proof” modes/hooks/config unless a real current caller needs them.

## pi-eval Guardrails

- Keep command surface minimal (`audit`, `run`).
- Keep process isolation per case; do not reintroduce reuse/matrix/jobs modes unless explicitly requested.
- Worker behavior must only activate when `PI_EVAL_WORKER=1`.
- Keep split entrypoints intact: `skills-evals/pi-eval/index.ts` registers eval commands, while `skills-evals/pi-eval/worker.ts` is the sandbox worker extension entry.
- Keep report index behavior unchanged: full runs update index, partial runs do not.
- Repo-local Gondolin image contract lives under `skills-evals/gondolin/`; keep `pi-eval-image.json`, `guest-source.lock.json`, `scripts/build-image.sh`, and `image.lock.json` aligned when changing sandbox runtime/image expectations.
- Default runtime image location is `skills-evals/gondolin/image/current` unless `PI_EVAL_GONDOLIN_IMAGE_PATH` overrides it.

## Path/Structure Guardrails

When moving files or changing paths, update all affected scripts, specs, and docs in the same change.
- `skills-evals/pi-eval/src` is organized by domain folders: `cli/`, `runtime/`, `data/`, `reporting/` (each includes a local `AGENTS.md` explainer).

## Cases and Fixtures

- Source of truth for cases: `skills-evals/fixtures/eval-cases.jsonl`.
- `skills-evals/fixtures/` is referenced by eval cases; do not remove fixture files without updating all case references.
- Keep case IDs stable to preserve report history.

## Validation Checklist

Run from repo root after functional changes to eval logic:

```bash
bun test skills-evals/pi-eval/src/cli/validation.test.ts
PI_EVAL_LOG=off ./skills-evals/run.sh
```

If eval runs update report artifacts unintentionally, restore them before finishing.
