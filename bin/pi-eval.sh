#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXT_PATH="$ROOT_DIR/extensions/pi-eval/index.ts"

if ! command -v pi >/dev/null 2>&1; then
  echo "pi is not installed or not on PATH." >&2
  exit 1
fi

cd "$ROOT_DIR"

export PI_EVAL_VERBOSE="${PI_EVAL_VERBOSE:-1}"
export PI_EVAL_TRACE="${PI_EVAL_TRACE:-0}"
if [[ -z "${NO_COLOR:-}" ]]; then
  export FORCE_COLOR="${FORCE_COLOR:-1}"
fi

if [[ -z "${PI_EVAL_TABLE_WIDTH:-}" ]]; then
  if [[ -n "${COLUMNS:-}" ]]; then
    export PI_EVAL_TABLE_WIDTH="$COLUMNS"
  elif command -v stty >/dev/null 2>&1; then
    TABLE_WIDTH="$(stty size </dev/tty 2>/dev/null | awk '{print $2}')"
    if [[ -n "$TABLE_WIDTH" ]]; then
      export PI_EVAL_TABLE_WIDTH="$TABLE_WIDTH"
    fi
  elif command -v tput >/dev/null 2>&1; then
    TABLE_WIDTH="$(tput cols </dev/tty 2>/dev/null || true)"
    if [[ -n "$TABLE_WIDTH" ]]; then
      export PI_EVAL_TABLE_WIDTH="$TABLE_WIDTH"
    fi
  fi
fi

LOG_DIR="${PI_EVAL_LOG_DIR:-$ROOT_DIR/docs/specs/pi-eval/logs}"
LOG_PATH="${PI_EVAL_LOG:-}"
if [[ "$LOG_PATH" == "off" || "$LOG_PATH" == "0" ]]; then
  LOG_PATH=""
elif [[ -z "$LOG_PATH" ]]; then
  TIMESTAMP="$(date +"%Y-%m-%d_%H-%M-%S")"
  LOG_PATH="$LOG_DIR/$TIMESTAMP.log"
fi

if [[ -n "$LOG_PATH" ]]; then
  mkdir -p "$(dirname "$LOG_PATH")"
  echo "Logging to $LOG_PATH"
  pi --no-session --no-extensions -e "$EXT_PATH" -p "/eval $*" 2>&1 | tee "$LOG_PATH"
else
  pi --no-session --no-extensions -e "$EXT_PATH" -p "/eval $*"
fi
