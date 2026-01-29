#!/bin/bash
set -euo pipefail

pretty_init_colors() {
  if [[ -n "${NO_COLOR:-}" && -z "${PRETTY_FORCE_COLOR:-}" && -z "${FORCE_COLOR:-}" ]]; then
    PRETTY_BOLD=""
    PRETTY_RED=""
    PRETTY_GREEN=""
    PRETTY_YELLOW=""
    PRETTY_BLUE=""
    PRETTY_CYAN=""
    PRETTY_RESET=""
    return
  fi

  if command -v tput >/dev/null 2>&1 && [[ -n "${TERM:-}" && "${TERM}" != "dumb" ]]; then
    PRETTY_BOLD="$(tput bold)"
    PRETTY_RED="$(tput setaf 1)"
    PRETTY_GREEN="$(tput setaf 2)"
    PRETTY_YELLOW="$(tput setaf 3)"
    PRETTY_BLUE="$(tput setaf 4)"
    PRETTY_CYAN="$(tput setaf 6)"
    PRETTY_RESET=$'\033[0m'
  else
    PRETTY_BOLD=$'\033[1m'
    PRETTY_RED=$'\033[31m'
    PRETTY_GREEN=$'\033[32m'
    PRETTY_YELLOW=$'\033[33m'
    PRETTY_BLUE=$'\033[34m'
    PRETTY_CYAN=$'\033[36m'
    PRETTY_RESET=$'\033[0m'
  fi
}

pretty_print_table() {
  local title="$1"
  local prefix="$2"
  local data_file="$3"
  if ! grep -q "^${prefix}\t" "$data_file"; then
    return
  fi

  printf "%b%s%b\n" "$PRETTY_BOLD" "$title" "$PRETTY_RESET"

  PRETTY_RED="$PRETTY_RED" \
  PRETTY_YELLOW="$PRETTY_YELLOW" \
  PRETTY_CYAN="$PRETTY_CYAN" \
  PRETTY_BOLD="$PRETTY_BOLD" \
  PRETTY_RESET="$PRETTY_RESET" \
  python3 - "$data_file" "$prefix" <<'PY'
import os
import sys
import textwrap

data_file = sys.argv[1]
prefix = sys.argv[2]
rows = []
with open(data_file, "r", encoding="utf-8") as handle:
    for line in handle:
        if not line.startswith(prefix + "\t"):
            continue
        parts = line.rstrip("\n").split("\t")
        rows.append(parts[1:])
if not rows:
    raise SystemExit(0)

red = os.environ.get("PRETTY_RED", "")
yellow = os.environ.get("PRETTY_YELLOW", "")
cyan = os.environ.get("PRETTY_CYAN", "")
bold = os.environ.get("PRETTY_BOLD", "")
reset = os.environ.get("PRETTY_RESET", "")

def colorize(text: str, color: str) -> str:
    if not color:
        return text
    return f"{color}{text}{reset}"

cols = 120
try:
    cols = int(os.popen("tput cols 2>/dev/null").read().strip() or "120")
except Exception:
    cols = 120

widths = [8, 50, 32, max(20, cols - (8 + 50 + 32 + 13))]

def wrap_cell(text: str, width: int) -> list[str]:
    return textwrap.wrap(text, width=width) or [""]

header = ["Type", "Path", "Issue", "Fix"]
border = "+-" + "-+-".join("-" * w for w in widths) + "-+"
print(border)
header_cells = [
    colorize(h.ljust(w), cyan + bold) for h, w in zip(header, widths)
]
print("| " + " | ".join(header_cells) + " |")
print(border)

for parts in rows:
    parts = (parts + ["", "", "", ""])[:4]
    wrapped = [wrap_cell(cell, width) for cell, width in zip(parts, widths)]
    height = max(len(lines) for lines in wrapped)
    for i in range(height):
        line_cells = []
        for idx, lines in enumerate(wrapped):
            cell = lines[i] if i < len(lines) else ""
            cell = cell.ljust(widths[idx])
            if idx == 0:
                if prefix == "ERROR":
                    cell = colorize(cell, red + bold)
                elif prefix == "WARN":
                    cell = colorize(cell, yellow + bold)
            line_cells.append(cell)
        print("| " + " | ".join(line_cells) + " |")
    print(border)
PY
}
