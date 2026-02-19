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
- Skill validation in this repo uses the `agentskills` executable from `skills-ref` (`uvx --from skills-ref agentskills validate skills/<name>`).
- `bin/sync.sh` syncs skills/instructions to `~/.pi/agent` (Pi agent global context/skills); use `--hard` for destructive mirror.
- Eval specs live in `skills-evals/specs/pi-eval/` with a mirror in `docs/specs/pi-eval/` (keep both in sync).
- `DEVC_DISABLE_MCP_SERVERS` in `devcontainer/devcontainer.json` can disable MCP startup in containers (comma/space/semi-colon separated list); use it to skip auth-heavy servers (e.g. `sentry` and/or `linear`) on non-interactive session starts.
- Third-party skill installers may land content in `~/.agents/skills/<name>`; to vendor into this repo, copy into `skills/<name>/`, ensure progressive disclosure (`SKILL.md` + `references/`), then run `./bin/build-agents-index.sh`.
- Global policy now requires AGENTS docs to be curated and progressive-disclosure based (concise root router + scoped/nested AGENTS + deep docs), and to migrate legacy monolithic AGENTS files instead of appending indefinitely.
