#!/bin/bash
set -euo pipefail

SOURCE_DIR="${AGENTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TARGET_ROOT="$HOME/.agents"
TARGET_SKILLS_DIR="$TARGET_ROOT/skills"
TARGET_WORKFLOWS_DIR="$TARGET_ROOT/workflows"
TARGET_INSTRUCTIONS_FILE="$TARGET_ROOT/AGENTS.md"
SOURCE_SKILLS_DIR="$SOURCE_DIR/skills"
SOURCE_WORKFLOWS_DIR="$SOURCE_DIR/workflows"
SOURCE_INSTRUCTIONS_FILE="$SOURCE_DIR/instructions/global.md"
BUILD_AGENT_INDEX_SCRIPT="$SOURCE_DIR/bin/build_agents_index.py"

CLAUDE_DIR="$HOME/.claude"
CLAUDE_MD_FILE="$CLAUDE_DIR/CLAUDE.md"

usage() {
    cat <<'USAGE'
Usage: bin/sync.sh
Performs a hard one-way sync from this repo to ~/.agents and writes a
thin CLAUDE.md pointer into ~/.claude.
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
fi

if [[ "$#" -ne 0 ]]; then
    echo "sync: this command has no options; it always performs hard sync to ~/.agents." >&2
    usage >&2
    exit 1
fi

if [[ ! -d "$SOURCE_SKILLS_DIR" ]]; then
    echo "sync: missing source skills directory: $SOURCE_SKILLS_DIR" >&2
    exit 1
fi

if [[ ! -f "$SOURCE_INSTRUCTIONS_FILE" ]]; then
    echo "sync: missing source instructions file: $SOURCE_INSTRUCTIONS_FILE" >&2
    exit 1
fi

run_validation() {
    echo "Validating skills metadata..."
    python3 "$BUILD_AGENT_INDEX_SCRIPT" --no-warnings
}

run_validation

mirror_dir() {
    local src="$1"
    local dest="$2"

    [[ "$src" == "$dest" ]] && return

    mkdir -p "$dest"
    if command -v rsync >/dev/null 2>&1; then
        rsync -a --delete --copy-links "$src"/ "$dest"/
    else
        find "$dest" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
        cp -R -L "$src"/. "$dest"/
    fi
}

mirror_file() {
    local src="$1"
    local dest="$2"

    [[ "$src" == "$dest" ]] && return

    mkdir -p "$(dirname "$dest")"
    if command -v rsync >/dev/null 2>&1; then
        rsync -a --copy-links "$src" "$dest"
    else
        cp -L "$src" "$dest"
    fi
}

echo "Hard syncing from $SOURCE_DIR to $TARGET_ROOT..."

mirror_dir "$SOURCE_SKILLS_DIR" "$TARGET_SKILLS_DIR"
mirror_dir "$SOURCE_WORKFLOWS_DIR" "$TARGET_WORKFLOWS_DIR"
mirror_file "$SOURCE_INSTRUCTIONS_FILE" "$TARGET_INSTRUCTIONS_FILE"

# --- Clean up legacy artifacts ---
# Remove router artifact if present (no longer used at runtime).
if [[ -f "$TARGET_ROOT/skills.router.min.json" ]]; then
    rm "$TARGET_ROOT/skills.router.min.json"
    echo "Removed legacy $TARGET_ROOT/skills.router.min.json"
fi

# --- Claude Code integration ---
# Write a thin CLAUDE.md that references ~/.agents/AGENTS.md so Claude Code
# picks up the global instructions without duplicating content.
mkdir -p "$CLAUDE_DIR"
printf '@../.agents/AGENTS.md\n' > "$CLAUDE_MD_FILE"
echo "Wrote $CLAUDE_MD_FILE (-> ~/.agents/AGENTS.md)"

# Remove legacy ~/.claude/skills (skills now live in ~/.agents/skills).
if [[ -d "$CLAUDE_DIR/skills" ]]; then
    rm -rf "$CLAUDE_DIR/skills"
    echo "Removed legacy $CLAUDE_DIR/skills"
fi

echo "Done."
