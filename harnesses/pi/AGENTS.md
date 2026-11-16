# Pi harness

- Read `README.md` for installation and `documentation/architecture.md` for authority and
  persistence.
- This directory owns Pi-specific prompts, roles, runtime, lint profiles and tests. Shared skill
  content is an input. Preserve Codex installation behavior; Claude cleanup belongs in `../claude/`
  and its workers receive explicit prompts from this harness.
- Use `npm ci`, `npm run format`, then `npm run verify`. Run `npm run test:live` when changing model
  integration, delegation, review or context behavior. Live runs use the configured Pi credentials.
- Keep trusted policy and receipts outside worker workspaces. Every product edit goes through a
  scoped worker and snapshot-bound verification. Never silently fall back from sandboxing.
- Persist accepted design before pruning. Preserve pending user input. Archived exploration must not
  re-enter a request through resume, tree navigation or compaction.
- Keep prompts in `prompts/`, role definitions in `roles/`, and operational evidence in ignored
  `reports/`. The installer backs up changed Pi assets and never reads credential contents.
- Preserve exit status, required skips, cancellation and stale evidence as distinct outcomes.
- Benchmarks measure real public behavior. Instrumentation must preserve disabled behavior.
