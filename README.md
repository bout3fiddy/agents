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
    └── sync-hard.sh           # Destructive mirror to ~/.codex and ~/.claude
```

## Skills Directory

Short descriptions of the skills stored in `skills/`:

- `agent-browser`: Browser automation for navigation, form filling, screenshots, and extraction.
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
./bin/sync-hard.sh
```

## How It Works

### Skills

**Source of truth:** `skills/<name>/SKILL.md`

**Sync behavior:**
- **Claude**: `~/.claude/skills/<name>/SKILL.md` (copied)
- **Codex**: `~/.codex/skills/<name>/SKILL.md` (copied)

**Latest wins:**
- `sync.sh` compares modification times and propagates the newest version to the other locations.
- `sync-hard.sh` is destructive and mirrors this repo exactly to `~/.codex` and `~/.claude`.

### Instructions (bootstrap)

`instructions/global.md` is copied to:
- `~/.claude/CLAUDE.md`
- `~/.codex/AGENTS.md`

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

| Content | Claude | Codex |
|---------|--------|-------|
| Skills | ✅ | ✅ |
| Instructions | ✅ CLAUDE.md | ✅ AGENTS.md |

## File Locations After Sync

```
~/.claude/
├── CLAUDE.md (latest-wins with ~/.agents/instructions/global.md)
└── skills/<name>/SKILL.md (latest-wins with ~/.agents/skills/<name>/SKILL.md)

~/.codex/
├── AGENTS.md (latest-wins with ~/.agents/instructions/global.md)
└── skills/<name>/SKILL.md (latest-wins with ~/.agents/skills/<name>/SKILL.md)
```
