# Judging Scripts

- `judge.ts`: suite-level judge orchestrator — assembles all selected bundled and standalone cases into one judge workspace, launches sandboxed `pi` judge via Gondolin, parses the evidence-first JSON verdict, structured skill feedback, and judge-authored markdown report. The judge owns comparison verdicts; per-run task status remains separate. Exports `applyJudgeVerdicts` to attach verdicts without overwriting task status.
- `judge-sandbox.ts`: judge sandbox lifecycle — creates workspace (judge AGENTS.md + CLAUDE.md), home (auth only), and output dirs under `/tmp/pi-eval-judge/<uuid>/`; cleans up via `assertManagedTempPath`.
- Judge directives live in `config/judge/AGENTS.md` (evidence-only criteria, minimum report sections, skill feedback, verdict schema, JSON-only output).
- Judge sandbox intentionally has no `.codex` mount — full isolation from host config.
- There are deterministic task checks from verification results and file assertions before judging. The judge adds taskPass evidence and comparison outcomes, but report rows must not conflate baseline task failures with skill comparison failures.
