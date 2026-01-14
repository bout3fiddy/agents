---
name: skill-installer
description: "Install skills into this repo using our workflow: clone/copy into skills/, validate with skills-ref (uv), and sync. Use when asked to install or import skills."
---

# Skill Installer (Repo Workflow)

## Operating rules
- Use **uv** for tooling; no pip installs.
- Install into `skills/<name>/` in this repo (not system dirs).
- Validate with `skills-ref` before finishing.
- Sync with `bin/sync.sh` unless `bin/sync-hard.sh` is explicitly requested.

## Workflow
1) Identify source (local path or repo URL) and skill name.
2) Copy into `skills/<name>/` in this repo.
3) Validate: `skills-ref validate skills/<name>`.
4) Summarize changes and sync if requested.

## Acquiring from GitHub (use repo-research)
- Use the `repo-research` skill to **clone → read → remove**.
- Prefer shallow clone and sparse checkout when only a subdirectory is needed.
- Copy only the target skill folder into `skills/<name>/`.
- Delete the temp clone when finished.
