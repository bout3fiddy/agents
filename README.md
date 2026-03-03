# Agents Workflow Template

Canonical source for shared agent skills and global instructions used by Claude/Codex-style setups.

Repo-specific operating notes live in `AGENTS.md`.

## What this repo manages

- Skills under `skills/<name>/` (`SKILL.md` plus optional `references/`)
- Global instruction source at `instructions/global.md`
- Machine routing artifacts:
  - `instructions/skills.router.min.json` (primary runtime artifact)
- Sync tooling in `bin/` (`sync.sh`)
- Skills routing metadata tooling in `skills/skill-creator/scripts/build_agents_index.py`

## Repository layout

```text
agents/
├── skills/                    # Skill packages: <name>/SKILL.md (+ references/)
├── instructions/
│   ├── global.md              # Source copied to ~/.agents/AGENTS.md
│   ├── skills.router.min.json # Source copied to ~/.agents/skills.router.min.json
├── bin/
│   ├── sync.sh                # Hard sync to ~/.agents
├── skills/skill-creator/scripts/
│   └── build_agents_index.py      # Validate skill/routing metadata (no marker updates)
├── skills-evals/
│   ├── run.sh                 # Eval runner wrapper (supports --case CASE_ID)
│   └── fixtures/
│       ├── eval-cases.jsonl   # Source-of-truth eval cases
│       └── models.jsonl       # Models + thinking config
├── devcontainer/              # Devcontainer template and installer
└── AGENTS.md                  # Repo-specific durable notes
```

## Quick start

```bash
# Recommended location
cd ~
git clone https://github.com/bout3fiddy/agents.git .agents
cd ~/.agents

# Hard sync skills + instructions + routing artifact to ~/.agents
./bin/sync.sh
```

If this repo is not at `~/.agents`, set:

```bash
export AGENTS_DIR="/absolute/path/to/agents"
```

## Sync behavior

`bin/sync.sh` performs hard sync from this repo to:

- `~/.agents/skills/`
- `~/.agents/AGENTS.md` (from `instructions/global.md`)
- `~/.agents/skills.router.min.json` (from `instructions/skills.router.min.json`)
- `sync` runs metadata validation + `check-router-artifact` before copy.

### Artifact regeneration

Run these when you need to refresh routing metadata locally:
- `python3 skills/skill-creator/scripts/build_agents_index.py` (source validation)
- `python3 skills/skill-creator/scripts/build_skills_router_artifact.py` (artifact regeneration)

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
# Rebuild routing artifact
python3 skills/skill-creator/scripts/build_agents_index.py
python3 skills/skill-creator/scripts/build_skills_router_artifact.py
bun run skills-evals/validate/index.ts check-router-artifact

# Run evals for all configured models/cases
./skills-evals/run.sh

# Run a single eval case id across configured models
./skills-evals/run.sh --case CD-015
```

## Devcontainer rollout note

`./bin/sync.sh` only syncs skills, global instructions, and the machine routing artifact. It does not roll out devcontainer template changes.

For devcontainer template rollout:

1. Update files under `devcontainer/` in this repo
2. Run `./devcontainer/install.sh self-install`
3. In target repo: `devc install .`
4. Rebuild container: `devc rebuild .`
