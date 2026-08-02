# Skill Evaluation Harness

`skills-evals` compares skill-guided agent behavior with no-skill baselines in
isolated Gondolin virtual machines. It records routing telemetry, deterministic
verification output, model traces, and an evidence-first suite verdict.

## Layout

```text
skills-evals/
├── fixtures/
│   ├── eval-cases/<CASE_ID>/case.jsonl
│   └── models.jsonl
├── gondolin/                   # image recipe, locks, and build script
├── pi-eval/
│   ├── index.ts               # /eval command entrypoint
│   ├── worker.ts              # isolated case worker entrypoint
│   ├── config/
│   ├── src/
│   └── test/
├── reports/                   # model reports and routing traces
├── run.sh                     # canonical runner
└── manage.sh                  # list/remove case artifacts
```

## Prerequisites

- `pi` on the host `PATH`
- `qemu-system-aarch64` on the host `PATH`
- `qemu-img` when the image uses copy-on-write or checkpoint disks
- a built Gondolin image at `gondolin/image/current`, or an explicit
  `PI_EVAL_GONDOLIN_IMAGE_PATH`

Build the image when its manifest is missing or stale:

```bash
./skills-evals/gondolin/scripts/build-image.sh
```

The guest image must provide `pi` on `PATH`. Mutable cases, skills, and global
instructions are staged per run rather than baked into the image.

## Run evaluations

```bash
# All cases and configured models
./skills-evals/run.sh

# One case across configured models
./skills-evals/run.sh --case ZG-001

# Bound concurrent cases/variants; the runner caps this at six
./skills-evals/run.sh --parallelism 2
```

`run.sh` reads `fixtures/models.jsonl` unless `PI_EVAL_MODELS_FILE` overrides it.
Model entries may specify separate eval and judge models and thinking levels.
Configured models run in parallel up to `PI_EVAL_MAX_PARALLEL`.

The underlying extension supports only `/eval run`:

```text
/eval run [--model provider/model] [--cases path] [--filter id-or-suite]
          [--limit n] [--parallelism n] [--thinking level]
          [--agent-dir path] [--dry-run]
```

## Isolation and lifecycle

- Selected cases execute concurrently, but each case gets a distinct sandbox
  workspace and home.
- The Gondolin engine is mandatory and fails closed when launch or guest
  preflight fails.
- Full-payload cases stage a temporary sync-source snapshot, run `bin/sync.sh`
  against the sandbox home, then scope installed skills to the case's `skillSet`.
- No-payload baselines remove global instructions, skills, and workflows and
  enforce read-deny probes before execution.
- The worker receives only fixture prompts and captures skill/reference reads,
  sanitized model steps, usage, and result state.
- Trusted `verificationCommands` run after the model and feed exit status plus
  bounded output into deterministic task checks and the judge.

The case prompt timeout defaults to 600 seconds through
`PI_EVAL_CASE_TIMEOUT_MS`. Post-run worker shutdown defaults to 30 seconds
through `PI_EVAL_CASE_SHUTDOWN_TIMEOUT_MS`. Set `PI_EVAL_RPC_TRACE_DIR` to
persist raw RPC JSONL and lifecycle diagnostics for debugging.

## Cases

Each `case.jsonl` defines the prompt, optional turns, available tools, bootstrap
profile, skill payload, expected or disallowed routing, file assertions, and
trusted verification commands. Bundled cases normally contain paired `skill`
and `noskill` variants; standalone cases can probe a skill tool or invariant.

Routing assertions include:

- `must_read_ref:<path>`
- `must_not_read_ref:<path>`
- `must_read_refs_count_at_least:<n>`
- `must_read_exact_refs:<comma-separated-paths>`

Manage cases with:

```bash
./skills-evals/manage.sh list
./skills-evals/manage.sh remove --case CASE_ID --dry-run
```

Removal target resolution is implemented in
`pi-eval/src/cli/manage-remove.ts`; the shell wrapper retains confirmation and
deletion execution.

## Reports and judging

Primary reports live at `reports/<provider>-<model>.md`; per-case routing traces
live under `reports/routing-traces/<provider>-<model>/`. Full runs update
`reports/index.json`; partial runs preserve the index.

The judge receives submitted artifacts, deterministic verification results,
routing evidence, and sanitized process traces. It separates individual task
success from skill-versus-baseline benefit and must cite observable evidence
for its conclusions.

## Tests and validation

```bash
cd skills-evals/pi-eval
bun test

cd ../..
bun run skills-evals/validate/index.ts validate skills/zig
python3 bin/build_agents_index.py
```

Run a targeted behavioral eval after changing skill routing, reference
requirements, bootstrap behavior, or judge semantics. Generated reports may be
updated by eval runs; include them only when they are intended evidence.
