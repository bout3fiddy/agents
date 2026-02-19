# Unified Agent Configuration

Skills-first setup for Claude Code + Codex. Keep everything in `~/.agents` and sync copies to each tool.

Repo-specific notes live in `AGENTS.md`.

## Structure

```
agents/
├── skills/                    # Reusable skills (<name>/SKILL.md)
├── instructions/              # Minimal bootstrap instructions
│   └── global.md              # -> CLAUDE.md, AGENTS.md
├── commands/                  # Claude-only (optional)
├── agents/                    # Claude-only (optional)
└── bin/
    ├── sync.sh
    └── sync.sh                # Sync skills/instructions (use --hard for destructive mirror)
```

## Skills Directory

Short descriptions of the skills stored in `skills/`:

- `agent-observability`: Logs explicit user corrections to improve assistant behavior.
- `coding`: Core engineering rules for implementation, refactors, and bug fixes.
- `planning`: Spec-driven planning, scope clarification, and Linear tracking workflows.
- `seo`: SEO strategy and execution, including programmatic SEO and SEO audits.
- `skill-creator`: Create, update, or install skills in this repo and keep the index in sync.

## Quick Start

```bash
# Recommended: keep this repo at ~/.agents
# If you keep it elsewhere, export AGENTS_DIR to point at it:
# export AGENTS_DIR="/path/to/agents"

# Add to PATH (optional, add to ~/.zshrc or ~/.bashrc)
export PATH="$PATH:$HOME/.agents/bin"

# Sync everything (creates needed dirs)
./bin/sync.sh

# Hard-sync (destructive mirror)
./bin/sync.sh --hard
```

## How It Works

### Skills

**Source of truth:** `skills/<name>/SKILL.md`

**Sync behavior:**
- **Claude**: `~/.claude/skills/<name>/SKILL.md` (copied)
- **Agents home (Codex standard)**: `~/.agents/skills/<name>/SKILL.md` (copied)
- **Pi (default)**: `~/.agents/skills/<name>/SKILL.md` (same location)

**Latest wins:**
- `sync.sh` compares modification times and propagates the newest version to the other locations.
- `sync.sh --hard` is destructive and mirrors this repo exactly to `~/.agents` and `~/.claude`.
- To target a legacy Pi directory, set `PI_DIR` explicitly (for example `PI_DIR="$HOME/.pi/agent"`).

### Instructions (bootstrap)

`instructions/global.md` is copied to:
- `~/.claude/CLAUDE.md`
- `~/.agents/AGENTS.md`
- `~/.agents/AGENTS.md` (Pi default)

`sync.sh` uses a latest-wins policy across these files.

### Commands (Claude-only, optional)

`commands/*.md` are copied to:
- `~/.claude/commands/`

Commands also use latest-wins syncing between `~/.agents/commands` and `~/.claude/commands`.

## Creating New Content

```bash
# Create a new skill
mkdir -p skills/my-new-skill
cat > skills/my-new-skill/SKILL.md <<'EOF'
---
name: my-new-skill
description: Brief description of what this skill does and when to use it.
---

# My New Skill
EOF

# Sync to all tools
./bin/sync.sh
```

## Validate Skills

Use `skills-ref` (via `uv`) to validate a skill folder:

```bash
uv sync
uv run skills-ref validate skills/my-new-skill
```

## Tool Compatibility Matrix

| Content | Claude | Codex | Pi |
|---------|--------|-------|----|
| Skills | ✅ | ✅ | ✅ |
| Instructions | ✅ CLAUDE.md | ✅ AGENTS.md | ✅ AGENTS.md |

## File Locations After Sync

```
~/.claude/
├── CLAUDE.md (latest-wins with ~/.agents/instructions/global.md)
└── skills/<name>/SKILL.md (latest-wins with ~/.agents/skills/<name>/SKILL.md)

~/.agents/
├── AGENTS.md (latest-wins with ~/.agents/instructions/global.md)
└── skills/<name>/SKILL.md (latest-wins with ~/.agents/skills/<name>/SKILL.md)

Legacy Pi target (optional override):
  PI_DIR="$HOME/.pi/agent" ./bin/sync.sh
```
