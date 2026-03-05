# Judging Scripts

- `judge.ts`: bundle-level judge orchestrator — assembles variant inputs (code, routing traces, errors, case notes), launches sandboxed `pi` judge via Gondolin, parses JSON verdicts. The judge is the **sole evaluator** — its verdict determines pass/fail for all bundled cases. Exports `applyJudgeVerdicts` to propagate verdicts to evaluation status.
- `judge-sandbox.ts`: judge sandbox lifecycle — creates workspace (judge AGENTS.md + CLAUDE.md), home (auth only), and output dirs under `/tmp/pi-eval-judge/<uuid>/`; cleans up via `assertManagedTempPath`.
- Judge directives live in `config/judge/AGENTS.md` (evaluation criteria, verdict schema, JSON-only output, no tool use).
- Judge sandbox intentionally has no `.codex` mount — full isolation from host config.
- There are no deterministic pass/fail checks — scoring.ts (`assembleEvaluation`) builds routing scorecards and defaults all cases to pass; the judge overrides status for bundled cases.
