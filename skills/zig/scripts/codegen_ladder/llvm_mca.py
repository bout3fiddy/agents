from __future__ import annotations

import shutil
from pathlib import Path

from .common import CommandSpec, run_command
from .types import InspectOptions, JsonObject


def run_llvm_mca(
    options: InspectOptions, hot_asm: Path, cwd: Path, out_dir: Path
) -> JsonObject:
    if not options.llvm_mca:
        return {"status": "skip", "tool": "llvm-mca"}
    if not hot_asm.exists() or hot_asm.stat().st_size == 0:
        return {
            "status": "skip",
            "tool": "llvm-mca",
            "reason": "focused assembly missing",
        }
    if not shutil.which("llvm-mca"):
        return {"status": "skip", "tool": "llvm-mca", "reason": "llvm-mca unavailable"}
    result = run_command(
        CommandSpec(
            name="llvm-mca",
            argv=["llvm-mca", str(hot_asm)],
            cwd=cwd,
            out_dir=out_dir,
            timeout_ms=options.timeout_ms,
        )
    )
    return {
        "status": "pass" if result.status == "pass" else "review",
        "tool": "llvm-mca",
        "command": result.to_json(),
    }
