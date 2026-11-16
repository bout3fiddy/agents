#!/usr/bin/env python3
"""Remove repository-managed Claude instructions without touching login or preferences."""

import json
import shutil
from pathlib import Path


def reset() -> dict[str, object]:
    root = Path.home() / ".claude"
    removed = []

    for name in ("CLAUDE.md", "skills", "agents", "commands", "workflows"):
        source = root / name

        if not source.exists() and not source.is_symlink():
            continue

        if source.is_symlink() or source.is_file():
            source.unlink()
        else:
            shutil.rmtree(source)

        removed.append(name)

    return {"removed": removed, "source": "agents/instructions and agents/skills"}


if __name__ == "__main__":
    print(json.dumps(reset(), indent=2))
