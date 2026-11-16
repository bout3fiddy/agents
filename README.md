# Agents Workflow Source

Canonical source for personal agent instructions, reusable skills, evaluation
tooling, and the autonomous devcontainer template used across Codex, Claude, and
compatible agents.

## Layout

```text
agents/
├── instructions/global.md     # always-loaded personal defaults
├── skills/                    # progressively disclosed Agent Skills
├── harnesses/                 # isolated Pi runtime and Claude baseline
├── bin/
│   ├── sync.sh                # validate and hard-sync global assets
│   └── build_agents_index.py  # skill/reference metadata audit
├── skills-evals/              # Gondolin-backed skill evaluation harness
├── devcontainer/              # reusable autonomous coding container
└── AGENTS.md                  # concise repository router and guardrails
```

Detailed instructions live near their scope:

- [Devcontainer operations](devcontainer/README.md)
- [Pi coding harness](harnesses/pi/README.md)
- [Claude baseline](harnesses/claude/README.md)
- [Skill evaluation harness](skills-evals/README.md)
- [Evaluation guardrails](skills-evals/AGENTS.md)
- Individual workflow and domain guidance under `skills/<name>/`

## Sync global assets

Run from the repository root:

```bash
./bin/sync.sh
```

The sync command first runs `python3 bin/build_agents_index.py --no-warnings`,
then mirrors:

- `skills/` to `~/.agents/skills/`
- `instructions/global.md` to `~/.agents/AGENTS.md`
- a thin `~/.codex/AGENTS.md` pointer to `~/.agents/AGENTS.md`

Sync removes the retired `~/.agents/workflows/` tree. It leaves Claude and Pi
alone. Pi installs separately with `./bin/sync-pi.sh`; Claude's global baseline
is managed by `harnesses/claude/reset.py`.

If the checkout is not the intended source directory, set `AGENTS_DIR` to its
absolute path before syncing. Sync does not deploy devcontainer template
changes.

## Create or update a skill

All authored repository code uses the executable lint rules under
`harnesses/pi/scripts/linting/` and the shared Oxlint configuration. Run:

```sh
node bin/format-repo.mjs
node bin/lint-repo.mjs
./bin/verify.sh
```

The checks cover code across this repository. Intentional evaluation fixtures
are excluded. Existing evaluation code keeps tabs, double quotes and semicolons;
Pi code uses spaces and single quotes. Both enforce logical paragraph spacing,
100 columns and semantic checks. Long literals may use concatenation to preserve
their exact contents within the column limit.

On a fresh checkout, first install the pinned dependencies with
`npm ci --prefix harnesses/pi --ignore-scripts` and
`bun install --cwd skills-evals/pi-eval --frozen-lockfile`.
Verification needs macOS, Node, Python and Bun. The formatting command also uses
`uvx` to run pinned Ruff.

Every `skills/<name>/SKILL.md` uses Agent Skills frontmatter:

```yaml
---
name: skill-name
description: State the user goal, trigger boundary, and important exclusions.
---
```

Keep the entrypoint focused. Put conditional procedures, examples, schemas, or
deep technical material in `references/`; use scripts only for deterministic
work that instructions cannot perform reliably.

Validate changed skills before sync:

```bash
python3 bin/build_agents_index.py
uvx --from skills-ref agentskills validate skills/<name>
bun run skills-evals/validate/index.ts validate skills/<name>
```

## Evaluate skill behavior

The source of truth for cases is `skills-evals/fixtures/eval-cases/`, with one
`case.jsonl` per case directory.

```bash
# One case across configured models
./skills-evals/run.sh --case ZG-001

# Full configured suite
./skills-evals/run.sh
```

Reports are written under `skills-evals/reports/` and mirrored into
`docs/specs/pi-eval/reports/`. Eval failures are evidence about the skill,
router, harness, or model; do not weaken fixtures solely to produce a pass.

## Railway integration

`skills/railway-operations` remains a compatibility skill for installations
whose Railway CLI does not yet provide maintained agent setup. Once the local
CLI exposes `railway setup agent`, prefer Railway's maintained skill and MCP
configuration and remove the compatibility skill after equivalent behavior is
verified.

## Devcontainer rollout

Devcontainer templates have a separate installation path:

```bash
./devcontainer/install.sh self-install
```

Then, in each target repository:

```bash
devc install .
devc rebuild .
```

See [devcontainer/README.md](devcontainer/README.md) for mounts, toolchains, and
runtime behavior.
