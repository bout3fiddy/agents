#!/bin/bash
set -euo pipefail
SOURCE_DIR="${AGENTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
exec npm --prefix "$SOURCE_DIR/harnesses/pi" run install:local
