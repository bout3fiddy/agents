# Repo Notes

- This repository is the canonical source for shared agent instructions, skills,
  evaluation tooling, and the devcontainer template. Make global
  changes here instead of patching synced copies under home directories.
- Start with [README.md](README.md). For scoped work, use
  [devcontainer/README.md](devcontainer/README.md) or
  [skills-evals/AGENTS.md](skills-evals/AGENTS.md) and
  [skills-evals/README.md](skills-evals/README.md).
- `./bin/sync.sh` validates skill metadata, hard-syncs skills and global
  instructions into `~/.agents`, mirrors native Claude assets into `~/.claude`,
  and writes the Codex global pointer. It does not deploy devcontainer changes.
- Validate a changed skill with
  `uvx --from skills-ref agentskills validate skills/<name>` or
  `bun run skills-evals/validate/index.ts validate skills/<name>`.
- Run `./skills-evals/run.sh --case <CASE_ID>` for a targeted skill eval and
  `./skills-evals/run.sh` for the configured suite. Improve skills, references,
  or instructions when behavior fails; do not weaken fixtures to obtain a pass.
- Devcontainer rollout is separate: update `devcontainer/`, run
  `./devcontainer/install.sh self-install`, then run `devc install .` and
  `devc rebuild .` in each target repository.
