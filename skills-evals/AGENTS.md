# Skill Evaluation Guardrails

Scope: `skills-evals/**`.

- Eval cases are behavioral evidence. When a skill, reference, or instruction
  fails, improve the payload or harness; do not weaken a case solely to pass.
- Case definitions live under `fixtures/eval-cases/<CASE_ID>/case.jsonl`. Keep
  case IDs stable and update every referenced fixture when moving files.
- Skill-driven cases should declare focused `expectedRefs`; no-skill controls
  and skills without references should keep that list empty.
- Each case runs in its own Gondolin-backed workspace and home. Sandbox launch
  failure is fatal; do not add a plain host-process fallback.
- Worker behavior activates only with `PI_EVAL_WORKER=1`. Keep
  `pi-eval/index.ts` as the command entrypoint and `pi-eval/worker.ts` as the
  sandbox worker entrypoint.
- The runner must execute only fixture-provided prompts. Do not inject routing
  hints into case prompts at runtime.
- Full runs update the report index; filtered or limited runs do not.
- Keep `gondolin/pi-eval-image.json`, `gondolin/guest-source.lock.json`,
  `gondolin/image.lock.json`, and `gondolin/scripts/build-image.sh` aligned when
  image expectations change.
- Skill files use Agent Skills YAML frontmatter with `name` and `description`.

For functional harness changes, run `bun test` from `skills-evals/pi-eval/`.
Use `./skills-evals/run.sh --case <CASE_ID>` when behavior or routing changes.
