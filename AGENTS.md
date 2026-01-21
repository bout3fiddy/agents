# Repo Notes

- This repo is the global workflow/template source; prefer changes here over per-repo tweaks.
- Rollout flow: update `devcontainer/`, run `./devcontainer/install.sh self-install`, then in the target repo remove `.devcontainer`, run `devc install .`, and finally `devc rebuild .`.
- `./bin/sync-hard.sh` only syncs skills/instructions; it does not update devcontainer templates. Use `./devcontainer/install.sh self-install` + `devc install .` to propagate template changes.
- Devcontainer post-install ensures `ruff`, `pytest`, `mypy`, and `prek` are installed via `uv tool install`.
