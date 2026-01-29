#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INPUT_FILE="$ROOT_DIR/specs/pi-eval/evals.md"
OUTPUT_FILE="$ROOT_DIR/cases/pi-eval.jsonl"

mkdir -p "$(dirname "$OUTPUT_FILE")"

# Extract JSONL lines (each case is a single-line JSON object)
awk '/^\{/{print}' "$INPUT_FILE" > "$OUTPUT_FILE"

if [[ ! -s "$OUTPUT_FILE" ]]; then
  echo "No cases found in $INPUT_FILE" >&2
  exit 1
fi

echo "Wrote $(wc -l < "$OUTPUT_FILE") cases to $OUTPUT_FILE"
