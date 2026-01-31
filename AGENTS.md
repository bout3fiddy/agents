# Repo Notes

- This repo is the global workflow/template source; prefer changes here over per-repo tweaks.
- Rollout flow: update `devcontainer/`, run `./devcontainer/install.sh self-install`, then in the target repo remove `.devcontainer`, run `devc install .`, and finally `devc rebuild .`.
- `./bin/sync.sh --hard` only syncs skills/instructions; it does not update devcontainer templates. Use `./devcontainer/install.sh self-install` + `devc install .` to propagate template changes.
- Devcontainer post-install ensures `ruff`, `pytest`, `mypy`, `prek`, and `takopi` are installed via `uv tool install` using Python 3.14 (takopi uses `-U`).
- Devcontainer bind-mounts host config dirs (currently `~/.claude`, `~/.codex`, `~/.takopi`) into `/home/node`.
- Only run `uv run prek run --all-files` when repo changes touch files the hooks apply to; skip when there are no relevant changes.
- `devc install` injects `node_modules` mounts by reading workspace globs from root `package.json` and/or `pnpm-workspace.yaml`; repos without workspaces won't get extra directories created.
- Devcontainer bun installs now scan workspace globs (package.json workspaces / pnpm-workspace) instead of assuming `apps/` or `packages/`.
- Devcontainer sets `UV_PROJECT_ENVIRONMENT` to `/home/node/.venv` and mounts the venv volume there to keep it out of the repo.
- `bin/build-agents-index.sh` auto-generates the skills index block in `instructions/global.md`; it runs during `bin/sync.sh` (soft) and `bin/sync.sh --hard`.
- `bin/sync.sh` syncs skills/instructions to `~/.pi/agent` (Pi agent global context/skills); use `--hard` for destructive mirror.
- Eval specs live in `skills-evals/specs/pi-eval/` with a mirror in `docs/specs/pi-eval/` (keep both in sync).
