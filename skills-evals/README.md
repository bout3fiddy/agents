# skills-evals

`skills-evals` contains the eval harness, eval inputs, and eval artifacts used to validate agent behavior in this repo.

## Layout

- `pi-eval/`: Pi extension that runs eval audits and eval cases.
- `run.sh`: wrapper to run `pi eval` against one or many models.
- `fixtures/`: deterministic fixture files used by eval prompts and file assertions.
- `fixtures/eval-cases.jsonl`: source-of-truth eval case registry.
- `fixtures/models.jsonl`: models matrix consumed by `run.sh` when `--model` is omitted.
- `reports/`: primary model-specific eval reports and `index.json`.
- `validate/`: TypeScript port of `agentskills validate`.

## pi-eval Extension

Location:

- `skills-evals/pi-eval/`
- Entrypoint: `skills-evals/pi-eval/index.ts`
- Config: `skills-evals/pi-eval/config/eval.config.json`

Wrapper commands (from repo root):

```bash
./skills-evals/run.sh
```

`run.sh` behavior:

- Takes no CLI args/flags.
- Always executes `/eval run` for every model listed in `skills-evals/fixtures/models.jsonl` (or `PI_EVAL_MODELS_FILE`).
- `models.jsonl` entry shape is `{"model":"provider/model","thinking":"low"}`.
- Runs models in parallel; parallelism defaults to number of models and can be capped with `PI_EVAL_MAX_PARALLEL`.
- Thinking mode is read per model from `models.jsonl`; if omitted, fallback is `PI_EVAL_THINKING` (default `low`).

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

- Process-isolated per case.
- Worker path enabled only with `PI_EVAL_WORKER=1`.
- Worker captures skill/reference read attempts/invocations and returns JSON results for scoring.

Sandbox model:

- Workspace copy under `/tmp/pi-eval-sandbox/<case-id>/<uuid>`.
- HOME under `/tmp/pi-eval-home/<case-id>/<uuid>`.
- Per-case sync bootstrap via `bin/sync.sh` (with `HOME` set to sandbox home).
- Excludes heavy/transient dirs like `.git`, `node_modules`, `.venv`, `dist`, `build`, `coverage`, `.cache`.

Scoring model:

- Checks expected/disallowed skills.
- Checks expected references.
- Runs text assertions and file assertions.
- Enforces optional token budgets.

## Cases And Reports

Cases source of truth:

- `skills-evals/fixtures/eval-cases.jsonl`

Primary reports:

- `skills-evals/reports/<provider>-<model>.md`
- `skills-evals/reports/index.json`

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
