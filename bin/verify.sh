#!/bin/bash
set -euo pipefail
SOURCE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$SOURCE_DIR"
node bin/lint-repo.mjs
npm --prefix harnesses/pi run verify
(
  cd skills-evals/pi-eval
  bun test
)
(
  cd skills-evals/validate
  bun test
)
python3 bin/build_agents_index.py --no-warnings
