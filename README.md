# Unified Agent Configuration

Skills-first setup for Claude Code + Codex. Keep everything in `~/.agents` and sync copies to each tool.

## Structure

```
agents/
├── skills/                    # Reusable skills (<name>/SKILL.md)
├── instructions/              # Minimal bootstrap instructions
│   └── global.md              # -> CLAUDE.md, AGENTS.md
├── commands/                  # Claude-only (optional)
├── agents/                    # Claude-only (optional)
└── bin/
    └── sync.sh
```

## Quick Start

```bash
# Recommended: keep this repo at ~/.agents
# If you keep it elsewhere, export AGENTS_DIR to point at it:
# export AGENTS_DIR="/path/to/agents"

# Add to PATH (optional, add to ~/.zshrc or ~/.bashrc)
export PATH="$PATH:$HOME/.agents/bin"

# Sync everything (creates needed dirs)
./bin/sync.sh
```

## How It Works

### Skills

**Source of truth:** `skills/<name>/SKILL.md`

**Sync behavior:**
- **Claude**: `~/.claude/skills/<name>/SKILL.md` (copied)
- **Codex**: `~/.codex/skills/<name>/SKILL.md` (copied)

**Latest wins:**
- `sync.sh` compares modification times and propagates the newest version to the other locations.

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
