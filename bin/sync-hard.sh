#!/bin/bash
set -euo pipefail

# Destructive mirror from repo → ~/.codex and ~/.claude
# This deletes any skills in targets that are not present in this repo.

DEFAULT_AGENTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_DIR="${AGENTS_DIR:-$DEFAULT_AGENTS_DIR}"
CLAUDE_DIR="$HOME/.claude"
CODEX_DIR="$HOME/.codex"
PI_DIR="${PI_DIR:-$HOME/.pi}"

if ! "$AGENTS_DIR/bin/pi-eval-gate.py"; then
  exit 1
fi

echo "Hard-syncing from $AGENTS_DIR..."

# Ensure source directories exist (treat missing as empty)
mkdir -p "$AGENTS_DIR/skills" "$AGENTS_DIR/instructions"
mkdir -p "$PI_DIR/skills"

mirror_dir() {
  local src="$1"
  local dest="$2"

  mkdir -p "$dest"
  if command -v rsync &> /dev/null; then
    rsync -a --delete --copy-links "$src"/ "$dest"/
  else
    shopt -s dotglob
    rm -rf "$dest"/*
    cp -R -L "$src"/. "$dest"/
    shopt -u dotglob
  fi
}

mirror_file() {
  local src="$1"
  local dest="$2"
  mkdir -p "$(dirname "$dest")"
  if command -v rsync &> /dev/null; then
    rsync -a --copy-links "$src" "$dest"
  else
    cp -L "$src" "$dest"
  fi
}

build_skills_index() {
  local builder="$AGENTS_DIR/bin/build-agents-index.sh"
  if [[ -f "$builder" ]]; then
    bash "$builder"
  else
    echo "Skills index builder not found; skipping."
  fi
}

build_skills_index

echo "Syncing skills (destructive mirror)..."
mirror_dir "$AGENTS_DIR/skills" "$CLAUDE_DIR/skills"
mirror_dir "$AGENTS_DIR/skills" "$CODEX_DIR/skills"
mirror_dir "$AGENTS_DIR/skills" "$PI_DIR/skills"

echo "Syncing instructions (overwrite)..."
mirror_file "$AGENTS_DIR/instructions/global.md" "$CLAUDE_DIR/CLAUDE.md"
mirror_file "$AGENTS_DIR/instructions/global.md" "$CODEX_DIR/AGENTS.md"
mirror_file "$AGENTS_DIR/instructions/global.md" "$PI_DIR/AGENTS.md"

echo ""
echo "Done!"
