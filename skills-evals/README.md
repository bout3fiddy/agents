# skills-evals

`skills-evals` contains the eval harness, eval inputs, and eval artifacts used to validate agent behavior in this repo.

## Layout

- `pi-eval/`: Pi extension that runs eval audits and eval cases.
- `run.sh`: wrapper to run `pi eval` against one or many models.
- `fixtures/`: deterministic fixture files used by eval prompts and file assertions.
- `fixtures/eval-cases.jsonl`: source-of-truth eval case registry.
- `fixtures/models.jsonl`: models matrix consumed by `run.sh` when `--model` is omitted.
- `gondolin/`: repo-local custom image recipe, build scripts, and lock metadata.
- `reports/`: primary model-specific eval reports and `index.json`.
- `reports/routing-traces/`: per-case routing telemetry artifacts by model.
- `validate/`: TypeScript port of `agentskills validate`.

## pi-eval Extension

Location:

- `skills-evals/pi-eval/`
- Command entrypoint: `skills-evals/pi-eval/index.ts`
- Worker entrypoint (sandbox case process): `skills-evals/pi-eval/worker.ts`
- Config: `skills-evals/pi-eval/config/eval.config.json`

Wrapper commands (from repo root):

```bash
./skills-evals/run.sh
```

Host requirements for Gondolin sandbox runtime:

- QEMU binaries must be installed and on `PATH`.
- Required binaries:
  - `qemu-system-aarch64` (VM launch)
  - `qemu-img` (rootfs `cow` mode + checkpoint flow)
- macOS install:
  - `brew install qemu`
- Debian/Ubuntu install:
  - `sudo apt install qemu-system-arm qemu-utils`
- Docker daemon must be running to build the repo-local image via `skills-evals/gondolin/scripts/build-image.sh`.
- Quick verification:
  - `qemu-system-aarch64 --version`
  - `qemu-img --version`
  - `./skills-evals/gondolin/scripts/build-image.sh`

Custom Gondolin image expectations:

- Must include `pi` on guest `PATH` (runtime preflight hard-fails if `pi` is missing).
- Should include stable runtime dependencies required by `pi` and provider API calls.
- Should not bake mutable eval fixtures or skill payload; those are mounted/synced per run.
- Repo-local image recipe and lock metadata live under `skills-evals/gondolin/`.
- Default runtime image path is `skills-evals/gondolin/image/current`.
- Override image path only when needed via `PI_EVAL_GONDOLIN_IMAGE_PATH=/abs/path`.

`run.sh` behavior:

- Takes no CLI args/flags.
- Always executes `/eval run` for every model listed in `skills-evals/fixtures/models.jsonl` (or `PI_EVAL_MODELS_FILE`).
- `models.jsonl` entry shape is `{"model":"provider/model","thinking":"low"}`.
- Uses `PI_EVAL_GONDOLIN_IMAGE_PATH` when set, otherwise defaults to `skills-evals/gondolin/image/current`.
- Runs models in parallel; parallelism defaults to number of models and can be capped with `PI_EVAL_MAX_PARALLEL`.
- Thinking mode is read per model from `models.jsonl`; if omitted, fallback is `PI_EVAL_THINKING` (default `low`).
- Per-case prompt timeout is configurable via `PI_EVAL_CASE_TIMEOUT_MS` (default `300000`).
- Worker shutdown wait timeout is configurable via `PI_EVAL_CASE_SHUTDOWN_TIMEOUT_MS` (default `30000`).
- Within each model run, eval cases execute in a case worker pool by default with `PI_EVAL_CASE_PARALLELISM=10` (can be overridden via env).
- Shared case sandbox mode (default on):
  - Shared sandboxing is enabled by default; set `PI_EVAL_SHARED_CASE_SANDBOX=0` to disable it.
  - With it enabled, sandbox-safe cases are batched by `suite` and executed in suite-specific shared workspaces.
  - Cases inside each suite batch can run in parallel with `PI_EVAL_BATCH_CASE_PARALLELISM` (defaults to `PI_EVAL_CASE_PARALLELISM`).
  - Plan-level parallelism is auto-bounded to keep total concurrent cases near `PI_EVAL_CASE_PARALLELISM` (avoids over-subscribing sync/bootstrap work).
  - Set `PI_EVAL_SHARED_CASE_MUTABLE_PATHS` (comma-separated) to define writable case overlays (default: `skills-evals/fixtures,instructions`).
  - Any paths outside mutable overlays are read via the shared workspace, so writes there can contaminate across cases; keep overlays covering all mutable targets.
- Worker routing hint:
  - Runner passes `PI_EVAL_SKILL_PATHS` to worker mode so the worker can enforce concise, deterministic skill-onboarding hints during each case.

Direct invocation:

```bash
pi --no-session --no-extensions -e skills-evals/pi-eval/index.ts -p "/eval audit --model openai-codex/gpt-5.3-codex"
```

Supported command surface:

- `audit --model <provider/model> [--agent-dir <path>]`
- `run --cases <path> [--model <provider/model>] [--dry-run] [--thinking <level>] [--filter <id|suite>] [--limit <n>] [--agent-dir <path>]`

Hard-fail unsupported flags:

- `--reuse`, `--reuse-process`
- `--matrix`
- `--jobs`
- `--profile`, `--trace`, `--verbose`

Runtime model:

- Batches of similar cases (suite + safe tool usage) share one workspace instance each.
- In batch mode, each workspace is reused for all cases in that suite batch and torn down after the batch.
- Worker path enabled only with `PI_EVAL_WORKER=1`.
- Worker captures skill/reference read attempts/invocations and returns JSON results for scoring.

Sandbox model:

- Workspace copy under `/tmp/pi-eval-sandbox/<batch-id>/<uuid>`.
- HOME under `/tmp/pi-eval-home/<batch-id>/<uuid>`.
- Each plan/batch/singleton gets a fresh workspace and `bin/sync.sh` bootstrap via `HOME` in sandbox home.
- Excludes heavy/transient dirs like `.git`, `node_modules`, `.venv`, `dist`, `build`, `coverage`, `.cache`.

Scoring model:

- Checks expected/disallowed skills.
- Skill expectations are satisfied either by direct `SKILL.md` reads or by routed reference reads under `skills/<name>/references/` (skill inferred from path).
- Checks expected references.
- Produces routing scorecards per case: read skills, read skill files, read refs, missing refs, unexpected refs.
- Runs text assertions and file assertions.
- Enforces optional token budgets.

Routing assertions (optional per case):

- `must_read_ref:<path>`
- `must_not_read_ref:<path>`
- `must_read_refs_count_at_least:<n>`
- `must_read_exact_refs:<comma-separated-paths>`

## Cases And Reports

Cases source of truth:

- `skills-evals/fixtures/eval-cases.jsonl`

Primary reports:

- `skills-evals/reports/<provider>-<model>.md`
- `skills-evals/reports/index.json`
- Report table includes routing columns:
  - `Skills Read`
  - `Skill Files Read`
  - `Refs Read`
  - `Missing Refs`
  - `Unexpected Refs`

Routing trace artifacts:

- `skills-evals/reports/routing-traces/<provider>-<model>/<case-id>.json`
- Each artifact includes `expectedSkills`, `expectedRefs`, routing scorecard fields, and failure reasons for that case.

Mirrored reports:

- `docs/specs/pi-eval/reports/`

## validate (agentskills port)

`skills-evals/validate` is a TypeScript port of `agentskills validate`.

Usage:

```bash
bun run skills-evals/validate/index.ts validate skills/skill-creator
```

Ported behavior:

- `SKILL.md` discovery (`SKILL.md` preferred, `skill.md` accepted)
- YAML frontmatter parsing contract
- metadata allowlist and required fields
- name/description/compatibility validation limits
- Unicode-aware name validation with NFKC normalization
- CLI output contract:
  - `Valid skill: <path>`
  - `Validation failed for <path>:` with bullet error lines

## Fixtures

`fixtures/` is active test data, not dead content. Eval sandbox cases reference these files directly (including `fixtures/docs/README.md` content fixtures where required by tests/prompts).

## Maintenance Notes

- Keep case-path references aligned to `skills-evals/fixtures/eval-cases.jsonl`.
