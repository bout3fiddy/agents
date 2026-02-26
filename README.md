# Agents Workflow Template

Canonical source for shared agent skills and global instructions used by Claude/Codex-style setups.

Repo-specific operating notes live in `AGENTS.md`.

## What this repo manages

- Skills under `skills/<name>/` (`SKILL.md` plus optional `references/`)
- Global instruction source at `instructions/global.md`
- Sync tooling in `bin/` (`sync.sh`)
- Skills index tooling in `skills/skill-creator/scripts/build_agents_index.py`

## Repository layout

```text
agents/
├── skills/                    # Skill packages: <name>/SKILL.md (+ references/)
├── instructions/
│   └── global.md              # Source copied to ~/.agents/AGENTS.md
├── bin/
│   ├── sync.sh                # Hard sync to ~/.agents
├── skills/skill-creator/scripts/
│   └── build_agents_index.py  # Regenerate auto skills index block (manual)
├── skills-evals/bin/
│   └── pi-eval.sh             # Eval runner wrapper
├── devcontainer/              # Devcontainer template and installer
└── AGENTS.md                  # Repo-specific durable notes
```

## Quick start

```bash
# Recommended location
cd ~
git clone https://github.com/bout3fiddy/agents.git .agents
cd ~/.agents

# Hard sync skills + instructions to ~/.agents
./bin/sync.sh
```

If this repo is not at `~/.agents`, set:

```bash
export AGENTS_DIR="/absolute/path/to/agents"
```

## Sync behavior

`bin/sync.sh` always performs a hard one-way sync from this repo to:

- `~/.agents/skills/`
- `~/.agents/AGENTS.md` (from `instructions/global.md`)

### Index regeneration

Run `python3 skills/skill-creator/scripts/build_agents_index.py` manually when you want to refresh the auto-generated skills index block inside `instructions/global.md`.

## Creating or updating a skill

1. Create/update `skills/<name>/SKILL.md`.
2. Keep `SKILL.md` concise; place longer material in `skills/<name>/references/`.
3. Validate:

```bash
uvx --from skills-ref agentskills validate skills/<name>
# or use the in-repo TypeScript port:
bun run skills-evals/validate/index.ts validate skills/<name>
```

4. Sync:

```bash
./bin/sync.sh
```

## Useful commands

```bash
# Rebuild only the skills index block
python3 skills/skill-creator/scripts/build_agents_index.py
```

## Devcontainer rollout note

`./bin/sync.sh` only syncs skills/instructions. It does not roll out devcontainer template changes.

For devcontainer template rollout:

1. Update files under `devcontainer/` in this repo
2. Run `./devcontainer/install.sh self-install`
3. In target repo: `devc install .`
4. Rebuild container: `devc rebuild .`
