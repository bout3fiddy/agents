#!/usr/bin/env python3
from __future__ import annotations

import sys

from codegen_ladder.cli import main  # pyright: ignore[reportImplicitRelativeImport]

if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
