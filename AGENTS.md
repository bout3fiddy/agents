# Repo Notes

- This repo is the global workflow/template source; prefer changes here over per-repo tweaks.
- Rollout flow: update `devcontainer/`, run `./devcontainer/install.sh self-install`, then in the target repo remove `.devcontainer`, run `devc install .`, and finally `devc rebuild .`.
