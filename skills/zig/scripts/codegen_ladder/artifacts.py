from __future__ import annotations

import re
import shutil
from pathlib import Path

from .common import run_capture
from .types import JsonObject


def resolve_source(path_value: str | None, cwd: Path) -> Path | None:
    if not path_value:
        return None
    path = Path(path_value)
    if not path.is_absolute():
        path = cwd / path
    return path.resolve()


def infer_artifact(
    build_root: Path, build_step: str | None, explicit: str | None
) -> Path | None:
    if explicit:
        path = Path(explicit)
        if not path.is_absolute():
            path = build_root / path
        return path.resolve()
    if build_step:
        return (build_root / "zig-out" / "bin" / build_step).resolve()
    return None


def zig_build_argv(
    step: str | None, build_options: list[str], trailing_args: list[str] | None = None
) -> list[str]:
    argv = ["zig", "build"]
    if step and step != "default":
        argv.append(step)
    argv.extend(["-Doptimize=ReleaseFast", *build_options])
    if trailing_args is not None:
        argv.extend(["--", *trailing_args])
    return argv


def copy_if_exists(source: Path, target: Path) -> None:
    if source.exists():
        target.parent.mkdir(parents=True, exist_ok=True)
        _ = shutil.copyfile(source, target)


def parse_zig_env(cwd: Path) -> JsonObject:
    code, stdout, stderr = run_capture(["zig", "env"], cwd)
    info: JsonObject = {
        "status": "pass" if code == 0 else "fail",
        "stderr": stderr.strip(),
    }
    for field in (
        "zig_exe",
        "lib_dir",
        "std_dir",
        "global_cache_dir",
        "version",
        "target",
    ):
        match = re.search(rf"\.{field}\s*=\s*\"([^\"]+)\"", stdout)
        if match:
            info[field] = match.group(1)
    return info


def parse_benchmark_scalar(value: str) -> object:
    cleaned = value.rstrip(",;")
    if re.fullmatch(r"-?\d+", cleaned):
        return int(cleaned)
    if re.fullmatch(r"-?(?:\d+\.\d*|\d*\.\d+)(?:[eE][+-]?\d+)?", cleaned):
        return float(cleaned)
    return cleaned


def parse_benchmark_fields(text: str, symbol: str | None = None) -> JsonObject:
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    if symbol:
        symbol_lines = [
            line
            for line in lines
            if f"boundary={symbol}" in line or f"boundary={symbol} " in line
        ]
        if symbol_lines:
            lines = symbol_lines

    parsed: JsonObject = {}
    for line in lines:
        for match in re.finditer(r"\b([A-Za-z_][A-Za-z0-9_]*)=([^\s]+)", line):
            parsed[match.group(1)] = parse_benchmark_scalar(match.group(2))
    return parsed


def parse_elapsed_ns(text: str) -> int | None:
    elapsed = parse_benchmark_fields(text).get("elapsed_ns")
    return elapsed if isinstance(elapsed, int) else None
