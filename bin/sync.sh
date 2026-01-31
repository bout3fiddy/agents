#!/bin/bash
set -euo pipefail

DEFAULT_AGENTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENTS_DIR="${AGENTS_DIR:-$DEFAULT_AGENTS_DIR}"
SYNC_MODE="soft"
EVAL_MODE="0"

usage() {
    cat <<'EOF'
Usage: bin/sync.sh [--hard] [--eval]
  --hard  Destructive mirror from repo to targets
  --eval  Skip eval gate and use EVAL_SYNC_HOME as HOME (for temp agent homes)
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --hard)
            SYNC_MODE="hard"
            shift
            ;;
        --eval)
            EVAL_MODE="1"
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if [[ "$EVAL_MODE" == "1" ]]; then
    export SKIP_PI_EVAL_GATE=1
    if [[ -n "${EVAL_SYNC_HOME:-}" ]]; then
        export HOME="$EVAL_SYNC_HOME"
    fi
fi

CLAUDE_DIR="$HOME/.claude"
CODEX_DIR="$HOME/.codex"
PI_DIR="${PI_DIR:-$HOME/.pi/agent}"

shopt -s nullglob

if [[ "${SKIP_PI_EVAL_GATE:-}" != "1" ]]; then
    if ! "$AGENTS_DIR/bin/pi-eval-gate.py"; then
        exit 1
    fi
fi

echo "Syncing from $AGENTS_DIR..."

# Ensure base directories exist
mkdir -p "$AGENTS_DIR/skills" "$AGENTS_DIR/instructions"
mkdir -p "$CLAUDE_DIR/skills" "$CODEX_DIR/skills" "$PI_DIR/skills"

mtime() {
    local path="$1"
    if stat -f "%m" "$path" >/dev/null 2>&1; then
        stat -f "%m" "$path"
    else
        stat -c "%Y" "$path"
    fi
}

latest_mtime() {
    local dir="$1"
    if [[ ! -d "$dir" ]]; then
        echo 0
        return
    fi
    if stat -f "%m" "$dir" >/dev/null 2>&1; then
        local ts
        ts="$(find "$dir" -type f -print0 2>/dev/null | \
            xargs -0 stat -f "%m" 2>/dev/null | \
            sort -n | tail -1 | awk '{print $1+0}')"
        echo "${ts:-0}"
    else
        local ts
        ts="$(find "$dir" -type f -print0 2>/dev/null | \
            xargs -0 stat -c "%Y" 2>/dev/null | \
            sort -n | tail -1 | awk '{print $1+0}')"
        echo "${ts:-0}"
    fi
}

copy_dir() {
    local src="$1"
    local dest="$2"

    mkdir -p "$dest"
    if command -v rsync &> /dev/null; then
        rsync -a --copy-links "$src"/ "$dest"/
    else
        cp -R -L "$src"/. "$dest"/
    fi
}

copy_file() {
    local src="$1"
    local dest="$2"

    mkdir -p "$(dirname "$dest")"
    if command -v rsync &> /dev/null; then
        rsync -a --copy-links "$src" "$dest"
    else
        cp -L "$src" "$dest"
    fi
}

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

sync_dir_latest_wins() {
    local a="$1"
    local b="$2"
    local a_time
    local b_time

    a_time="$(latest_mtime "$a")"
    b_time="$(latest_mtime "$b")"

    if [[ "$a_time" -ge "$b_time" ]]; then
        copy_dir "$a" "$b"
    else
        copy_dir "$b" "$a"
    fi
}

sync_dir_latest_wins_three() {
    local a="$1"
    local b="$2"
    local c="$3"
    local a_time
    local b_time
    local c_time
    local winner

    a_time="$(latest_mtime "$a")"
    b_time="$(latest_mtime "$b")"
    c_time="$(latest_mtime "$c")"

    if [[ "$a_time" -ge "$b_time" && "$a_time" -ge "$c_time" ]]; then
        winner="$a"
    elif [[ "$b_time" -ge "$a_time" && "$b_time" -ge "$c_time" ]]; then
        winner="$b"
    else
        winner="$c"
    fi

    [[ -d "$winner" ]] || return
    if [[ "$winner" != "$a" ]]; then
        copy_dir "$winner" "$a"
    fi
    if [[ "$winner" != "$b" ]]; then
        copy_dir "$winner" "$b"
    fi
    if [[ "$winner" != "$c" ]]; then
        copy_dir "$winner" "$c"
    fi
}

sync_dir_latest_wins_four() {
    local a="$1"
    local b="$2"
    local c="$3"
    local d="$4"
    local a_time
    local b_time
    local c_time
    local d_time
    local winner

    a_time="$(latest_mtime "$a")"
    b_time="$(latest_mtime "$b")"
    c_time="$(latest_mtime "$c")"
    d_time="$(latest_mtime "$d")"

    winner="$a"
    if [[ "$b_time" -ge "$a_time" && "$b_time" -ge "$c_time" && "$b_time" -ge "$d_time" ]]; then
        winner="$b"
    elif [[ "$c_time" -ge "$a_time" && "$c_time" -ge "$b_time" && "$c_time" -ge "$d_time" ]]; then
        winner="$c"
    elif [[ "$d_time" -ge "$a_time" && "$d_time" -ge "$b_time" && "$d_time" -ge "$c_time" ]]; then
        winner="$d"
    fi

    [[ -d "$winner" ]] || return
    if [[ "$winner" != "$a" ]]; then
        copy_dir "$winner" "$a"
    fi
    if [[ "$winner" != "$b" ]]; then
        copy_dir "$winner" "$b"
    fi
    if [[ "$winner" != "$c" ]]; then
        copy_dir "$winner" "$c"
    fi
    if [[ "$winner" != "$d" ]]; then
        copy_dir "$winner" "$d"
    fi
}

sync_file_latest_wins() {
    local a="$1"
    local b="$2"

    if [[ ! -f "$a" && ! -f "$b" ]]; then
        return
    fi
    if [[ ! -f "$a" ]]; then
        copy_file "$b" "$a"
        return
    fi
    if [[ ! -f "$b" ]]; then
        copy_file "$a" "$b"
        return
    fi

    if [[ "$(mtime "$a")" -ge "$(mtime "$b")" ]]; then
        copy_file "$a" "$b"
    else
        copy_file "$b" "$a"
    fi
}

sync_file_latest_wins_three() {
    local a="$1"
    local b="$2"
    local c="$3"
    local a_time=0
    local b_time=0
    local c_time=0
    local winner

    [[ -f "$a" ]] && a_time="$(mtime "$a")"
    [[ -f "$b" ]] && b_time="$(mtime "$b")"
    [[ -f "$c" ]] && c_time="$(mtime "$c")"

    if [[ "$a_time" -ge "$b_time" && "$a_time" -ge "$c_time" ]]; then
        winner="$a"
    elif [[ "$b_time" -ge "$a_time" && "$b_time" -ge "$c_time" ]]; then
        winner="$b"
    else
        winner="$c"
    fi

    [[ -f "$winner" ]] || return
    if [[ "$winner" != "$a" ]]; then
        copy_file "$winner" "$a"
    fi
    if [[ "$winner" != "$b" ]]; then
        copy_file "$winner" "$b"
    fi
    if [[ "$winner" != "$c" ]]; then
        copy_file "$winner" "$c"
    fi
}

sync_file_latest_wins_four() {
    local a="$1"
    local b="$2"
    local c="$3"
    local d="$4"
    local a_time=0
    local b_time=0
    local c_time=0
    local d_time=0
    local winner

    [[ -f "$a" ]] && a_time="$(mtime "$a")"
    [[ -f "$b" ]] && b_time="$(mtime "$b")"
    [[ -f "$c" ]] && c_time="$(mtime "$c")"
    [[ -f "$d" ]] && d_time="$(mtime "$d")"

    winner="$a"
    if [[ "$b_time" -ge "$a_time" && "$b_time" -ge "$c_time" && "$b_time" -ge "$d_time" ]]; then
        winner="$b"
    elif [[ "$c_time" -ge "$a_time" && "$c_time" -ge "$b_time" && "$c_time" -ge "$d_time" ]]; then
        winner="$c"
    elif [[ "$d_time" -ge "$a_time" && "$d_time" -ge "$b_time" && "$d_time" -ge "$c_time" ]]; then
        winner="$d"
    fi

    [[ -f "$winner" ]] || return
    if [[ "$winner" != "$a" ]]; then
        copy_file "$winner" "$a"
    fi
    if [[ "$winner" != "$b" ]]; then
        copy_file "$winner" "$b"
    fi
    if [[ "$winner" != "$c" ]]; then
        copy_file "$winner" "$c"
    fi
    if [[ "$winner" != "$d" ]]; then
        copy_file "$winner" "$d"
    fi
}

sync_skills() {
    echo "Syncing skills..."

    mkdir -p "$AGENTS_DIR/skills" "$CLAUDE_DIR/skills" "$CODEX_DIR/skills" "$PI_DIR/skills"

    if [[ "$SYNC_MODE" == "hard" ]]; then
        echo "  (hard mirror)"
        mirror_dir "$AGENTS_DIR/skills" "$CLAUDE_DIR/skills"
        mirror_dir "$AGENTS_DIR/skills" "$CODEX_DIR/skills"
        mirror_dir "$AGENTS_DIR/skills" "$PI_DIR/skills"
        return
    fi

    local skill_dir
    for skill_dir in "$AGENTS_DIR/skills" "$CLAUDE_DIR/skills" "$CODEX_DIR/skills" "$PI_DIR/skills"; do
        mkdir -p "$skill_dir"
    done

    local name
    for name in $(ls -1 "$AGENTS_DIR/skills" "$CLAUDE_DIR/skills" "$CODEX_DIR/skills" "$PI_DIR/skills" 2>/dev/null | sort -u); do
        [[ -z "$name" ]] && continue
        local agents_skill="$AGENTS_DIR/skills/$name"
        local claude_skill="$CLAUDE_DIR/skills/$name"
        local codex_skill="$CODEX_DIR/skills/$name"
        local pi_skill="$PI_DIR/skills/$name"
        local agents_valid=0
        local claude_valid=0
        local codex_valid=0
        local pi_valid=0

        [[ -f "$agents_skill/SKILL.md" ]] && agents_valid=1
        [[ -f "$claude_skill/SKILL.md" ]] && claude_valid=1
        [[ -f "$codex_skill/SKILL.md" ]] && codex_valid=1
        [[ -f "$pi_skill/SKILL.md" ]] && pi_valid=1

        if [[ "$agents_valid" -eq 0 && "$claude_valid" -eq 0 && "$codex_valid" -eq 0 && "$pi_valid" -eq 0 ]]; then
            continue
        fi

        echo "  $name"
        sync_dir_latest_wins_four "$agents_skill" "$claude_skill" "$codex_skill" "$pi_skill"
    done
}

sync_instructions() {
    echo "Syncing instructions..."

    mkdir -p "$AGENTS_DIR/instructions"

    if [[ "$SYNC_MODE" == "hard" ]]; then
        build_skills_index
        mirror_file "$AGENTS_DIR/instructions/global.md" "$CLAUDE_DIR/CLAUDE.md"
        mirror_file "$AGENTS_DIR/instructions/global.md" "$CODEX_DIR/AGENTS.md"
        mirror_file "$AGENTS_DIR/instructions/global.md" "$PI_DIR/AGENTS.md"
        echo "  global.md -> Claude + Codex + Pi (hard mirror)"
        return
    fi

    sync_file_latest_wins_four \
        "$AGENTS_DIR/instructions/global.md" \
        "$CLAUDE_DIR/CLAUDE.md" \
        "$CODEX_DIR/AGENTS.md" \
        "$PI_DIR/AGENTS.md"
    echo "  global.md <-> Claude + Codex + Pi (latest wins)"

    build_skills_index
    copy_file "$AGENTS_DIR/instructions/global.md" "$CLAUDE_DIR/CLAUDE.md"
    copy_file "$AGENTS_DIR/instructions/global.md" "$CODEX_DIR/AGENTS.md"
    copy_file "$AGENTS_DIR/instructions/global.md" "$PI_DIR/AGENTS.md"
}

build_skills_index() {
    local builder="$AGENTS_DIR/bin/build-agents-index.sh"
    if [[ -f "$builder" ]]; then
        bash "$builder"
    else
        echo "Skills index builder not found; skipping."
    fi
}

sync_skills
sync_instructions
echo ""
echo "Done!"
