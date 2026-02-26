#!/bin/bash
set -euo pipefail

SOURCE_DIR="${AGENTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
TARGET_ROOT="$HOME/.agents"
TARGET_SKILLS_DIR="$TARGET_ROOT/skills"
TARGET_INSTRUCTIONS_FILE="$TARGET_ROOT/AGENTS.md"
SOURCE_SKILLS_DIR="$SOURCE_DIR/skills"
SOURCE_INSTRUCTIONS_FILE="$SOURCE_DIR/instructions/global.md"

usage() {
    cat <<'USAGE'
Usage: bin/sync.sh
Performs a hard one-way sync from this repo to ~/.agents only.
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
mirror_file "$SOURCE_INSTRUCTIONS_FILE" "$TARGET_INSTRUCTIONS_FILE"

echo "Done."
