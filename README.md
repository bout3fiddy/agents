# Agents Workflow Template

Canonical source for shared agent skills and global instructions used by Claude/Codex-style setups.

Repo-specific operating notes live in `AGENTS.md`.

## What this repo manages

- Skills under `skills/<name>/` (`SKILL.md` plus optional `references/`)
- Global instruction source at `instructions/global.md`
- Sync tooling in `bin/` (`sync.sh`, `build-agents-index.sh`, eval gate)

## Repository layout

```text
agents/
├── skills/                    # Skill packages: <name>/SKILL.md (+ references/)
├── instructions/
│   └── global.md              # Source copied to CLAUDE.md / AGENTS.md targets
├── bin/
│   ├── sync.sh                # Sync skills + instructions
│   ├── build-agents-index.sh  # Regenerate auto skills index block
│   └── pi-eval-gate.py        # Sync gate for evals
├── devcontainer/              # Devcontainer template and installer
└── AGENTS.md                  # Repo-specific durable notes
```

## Quick start

```bash
# Recommended location
cd ~
git clone https://github.com/bout3fiddy/agents.git .agents
cd ~/.agents

# Sync skills + instructions (latest-wins)
./bin/sync.sh

# Destructive mirror from this repo to targets
./bin/sync.sh --hard
```

If this repo is not at `~/.agents`, set:

```bash
export AGENTS_DIR="/absolute/path/to/agents"
```

## Sync behavior

`bin/sync.sh` targets:

- `~/.claude/skills/`
- `~/.agents/skills/`
- `PI_DIR/skills/` (defaults to `~/.agents/skills/`)
- `~/.claude/CLAUDE.md`
- `~/.agents/AGENTS.md`
- `PI_DIR/AGENTS.md`

### Modes

- `./bin/sync.sh`
  - Skills: latest-wins across repo + targets
  - Instructions: latest-wins across `instructions/global.md` and target instruction files
- `./bin/sync.sh --hard`
  - Skills: mirror this repo's `skills/` to targets
  - Instructions: mirror this repo's `instructions/global.md` to target instruction files

### Index regeneration

`bin/build-agents-index.sh` runs during sync and updates the auto-generated skills index block inside `instructions/global.md`.

## Creating or updating a skill

1. Create/update `skills/<name>/SKILL.md`.
2. Keep `SKILL.md` concise; place longer material in `skills/<name>/references/`.
3. Validate:

```bash
uvx --from skills-ref agentskills validate skills/<name>
```

4. Sync:

```bash
./bin/sync.sh
# or, if you intentionally want destructive mirror:
./bin/sync.sh --hard
```

## Useful commands

```bash
# Rebuild only the skills index block
./bin/build-agents-index.sh

# Sync with eval override (for temp/eval homes)
./bin/sync.sh --eval

# Legacy Pi target example
PI_DIR="$HOME/.pi/agent" ./bin/sync.sh
```

## Devcontainer rollout note

`./bin/sync.sh --hard` only syncs skills/instructions. It does not roll out devcontainer template changes.

For devcontainer template rollout:

1. Update files under `devcontainer/` in this repo
2. Run `./devcontainer/install.sh self-install`
3. In target repo: `devc install .`
4. Rebuild container: `devc rebuild .`
