# Repo Notes

- This repository is the canonical source for shared agent instructions, skills,
  evaluation tooling, and the devcontainer template. Make global
  changes here instead of patching synced copies under home directories.
- Start with [README.md](README.md). For scoped work, use
  [harnesses/README.md](harnesses/README.md),
  [devcontainer/README.md](devcontainer/README.md) or
  [skills-evals/AGENTS.md](skills-evals/AGENTS.md) and
  [skills-evals/README.md](skills-evals/README.md).
- `./bin/sync.sh` validates metadata, syncs existing Codex skills/instructions into
  `~/.agents`, and writes the Codex pointer. Codex behavior remains unchanged.
- Pi-specific prompts, roles, executable linting, runtime and tests belong in
  `harnesses/pi/`. Install them with `./bin/sync-pi.sh`.
- Claude remains free of global repository instructions/skills. Its Pi workers
  receive explicit prompts through the CLI adapter. See `harnesses/claude/`.
- All authored repository code follows the executable lint policy. Run
  `node bin/format-repo.mjs` to format, `node bin/lint-repo.mjs` to lint, and
  `./bin/verify.sh` for the complete local checks. Intentional evaluation
  fixtures are excluded; existing evaluation code retains its formatting style.
- Validate a changed skill with
  `uvx --from skills-ref agentskills validate skills/<name>` or
  `bun run skills-evals/validate/index.ts validate skills/<name>`.
- Run `./skills-evals/run.sh --case <CASE_ID>` for a targeted skill eval and
  `./skills-evals/run.sh` for the configured suite. Improve skills, references,
  or instructions when behavior fails; do not weaken fixtures to obtain a pass.
- Devcontainer rollout is separate: update `devcontainer/`, run
  `./devcontainer/install.sh self-install`, then run `devc install .` and
  `devc rebuild .` in each target repository.
