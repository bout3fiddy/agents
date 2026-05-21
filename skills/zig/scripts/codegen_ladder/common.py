from __future__ import annotations

import os
import re
import subprocess
import tempfile
import time
from dataclasses import dataclass
from itertools import islice
from pathlib import Path

from .types import CommandResult


def normalize_option_values(argv: list[str]) -> list[str]:
    value_options = {
        "--run-arg",
        "--bench-arg",
        "--build-option",
        "--run-env",
        "--bench-env",
    }
    normalized: list[str] = []
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg in value_options and index + 1 < len(argv):
            normalized.append(f"{arg}={argv[index + 1]}")
            index += 2
            continue
        normalized.append(arg)
        index += 1
    return normalized


def default_scratch() -> Path:
    return Path(tempfile.mkdtemp(prefix="zig-codegen-ladder."))


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except FileNotFoundError:
        return ""


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    _ = path.write_text(text, encoding="utf-8")


def command_head(path: Path, max_lines: int = 12) -> str:
    if not path.exists() or path.stat().st_size == 0:
        return ""
    lines: list[str] = []
    with path.open("r", encoding="utf-8", errors="replace") as handle:
        for line in islice(handle, max_lines):
            lines.append(line.rstrip("\n"))
    return "\n".join(lines)


def safe_name(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", name).strip("-") or "command"


def command_environment(env_extra: dict[str, str] | None = None) -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "NO_COLOR": "1",
            "FORCE_COLOR": "0",
            "TERM": "dumb",
        }
    )
    if env_extra:
        env.update(env_extra)
    return env


@dataclass(frozen=True)
class CommandSpec:
    name: str
    argv: list[str]
    cwd: Path
    out_dir: Path
    timeout_ms: int
    env_extra: dict[str, str] | None = None


def run_command(spec: CommandSpec) -> CommandResult:
    stdout_path = spec.out_dir / f"{safe_name(spec.name)}.stdout.txt"
    stderr_path = spec.out_dir / f"{safe_name(spec.name)}.stderr.txt"
    started = time.monotonic()
    timed_out = False
    exit_code: int | None
    with (
        stdout_path.open("w", encoding="utf-8") as stdout,
        stderr_path.open("w", encoding="utf-8") as stderr,
    ):
        try:
            completed = subprocess.run(
                spec.argv,
                cwd=str(spec.cwd),
                env=command_environment(spec.env_extra),
                stdout=stdout,
                stderr=stderr,
                text=True,
                timeout=spec.timeout_ms / 1000,
                check=False,
            )
            exit_code = completed.returncode
        except subprocess.TimeoutExpired:
            timed_out = True
            exit_code = None
        except OSError as error:
            _ = stderr.write(str(error))
            exit_code = None

    duration_ms = int((time.monotonic() - started) * 1000)
    status = "pass" if exit_code == 0 and not timed_out else "fail"
    return CommandResult(
        name=spec.name,
        argv=spec.argv,
        cwd=str(spec.cwd),
        exit_code=exit_code,
        timed_out=timed_out,
        duration_ms=duration_ms,
        status=status,
        stdout_path=str(stdout_path),
        stderr_path=str(stderr_path),
        stdout_head=command_head(stdout_path),
        stderr_head=command_head(stderr_path),
    )


def timeout_text(value: str | bytes | None, fallback: str = "") -> str:
    if value is None:
        return fallback
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return value


def run_capture(
    argv: list[str], cwd: Path, timeout_ms: int = 15_000
) -> tuple[int | None, str, str]:
    try:
        completed = subprocess.run(
            argv,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout_ms / 1000,
            check=False,
        )
        return completed.returncode, completed.stdout, completed.stderr
    except subprocess.TimeoutExpired as error:
        return None, timeout_text(error.stdout), timeout_text(error.stderr, "timed out")
    except OSError as error:
        return None, "", str(error)


def parse_key_value_env(values: list[str]) -> dict[str, str]:
    env: dict[str, str] = {}
    for value in values:
        if "=" not in value:
            raise SystemExit(f"expected KEY=VALUE environment override, got: {value}")
        key, raw = value.split("=", 1)
        if not key:
            raise SystemExit(f"empty environment key in: {value}")
        env[key] = raw
    return env


def command_by_name(commands: list[CommandResult], name: str) -> CommandResult | None:
    for command in commands:
        if command.name == name:
            return command
    return None


def command_status(commands: list[CommandResult], name: str) -> str:
    command = command_by_name(commands, name)
    if command is None:
        return "skip"
    return command.status
