# Judging Scripts

- `judge.ts`: bundle-level judge orchestrator — assembles variant inputs, launches sandboxed `pi` judge via Gondolin, parses JSON verdicts. Each judge invocation gets its own isolated sandbox with judge-only directives and auth.
- `judge-sandbox.ts`: judge sandbox lifecycle — creates workspace (judge AGENTS.md + CLAUDE.md), home (auth only), and output dirs under `/tmp/pi-eval-judge/<uuid>/`; cleans up via `assertManagedTempPath`.
- Judge directives live in `config/judge/AGENTS.md` (focused evaluation prompt, JSON-only output, no tool use).
- Judge sandbox intentionally has no `.codex` mount — full isolation from host config.
