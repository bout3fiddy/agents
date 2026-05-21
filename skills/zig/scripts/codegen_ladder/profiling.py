from __future__ import annotations

import platform
import shutil
import subprocess
import time
from pathlib import Path

from .artifacts import zig_build_argv
from .common import CommandSpec, run_command
from .types import CommandResult, InspectOptions, JsonObject


def build_profile_command(
    options: InspectOptions, source: Path | None
) -> list[str] | None:
    build_options = list(options.build_option)
    bench_args = list(options.bench_arg)
    if options.bench_step:
        return zig_build_argv(options.bench_step, build_options, bench_args)
    if source is not None and options.run_arg:
        return ["zig", "run", str(source), "-OReleaseFast", "--", *options.run_arg]
    return None


def run_profiler(
    options: InspectOptions, source: Path | None, cwd: Path, out_dir: Path
) -> JsonObject:
    if options.profile == "none":
        return {"status": "skip", "profile": "none"}
    command = build_profile_command(options, source)
    if command is None:
        return {
            "status": "skip",
            "profile": options.profile,
            "reason": "no benchmark/run command available",
        }
    if options.profile == "macos-sample":
        return run_macos_sample(options, command, cwd, out_dir)
    if options.profile == "linux-perf":
        return run_linux_perf(options, command, cwd, out_dir)
    return {
        "status": "skip",
        "profile": options.profile,
        "reason": "unsupported profiler",
    }


def run_macos_sample(
    options: InspectOptions, command: list[str], cwd: Path, out_dir: Path
) -> JsonObject:
    if platform.system().lower() != "darwin" or not shutil.which("sample"):
        return {
            "status": "skip",
            "profile": options.profile,
            "reason": "sample unavailable",
        }
    sample_path = out_dir / "sample.txt"
    stdout_path = out_dir / "profile-command.stdout.txt"
    stderr_path = out_dir / "profile-command.stderr.txt"
    with (
        stdout_path.open("w", encoding="utf-8") as stdout,
        stderr_path.open("w", encoding="utf-8") as stderr,
    ):
        process = subprocess.Popen(command, cwd=str(cwd), stdout=stdout, stderr=stderr)
        time.sleep(0.25)
        if process.poll() is not None:
            return {
                "status": "skip",
                "profile": options.profile,
                "reason": "profiled command exited before sampling",
                "command": command,
                "stdout_path": str(stdout_path),
                "stderr_path": str(stderr_path),
            }
        sample_result = run_command(
            CommandSpec(
                name="profile-sample",
                argv=[
                    "sample",
                    str(process.pid),
                    str(options.profile_seconds),
                    "1",
                    "-fullPaths",
                    "-mayDie",
                    "-file",
                    str(sample_path),
                ],
                cwd=cwd,
                out_dir=out_dir,
                timeout_ms=(options.profile_seconds + 5) * 1000,
            )
        )
        profiled_exit_code = wait_for_profiled_process(process, options.timeout_ms)
    return {
        "status": "pass" if sample_result.status == "pass" else "review",
        "profile": options.profile,
        "command": command,
        "sample_path": str(sample_path),
        "sample_command": sample_result.to_json(),
        "profiled_exit_code": profiled_exit_code,
    }


def wait_for_profiled_process(
    process: subprocess.Popen[bytes], timeout_ms: int
) -> int | None:
    try:
        return process.wait(timeout=max(1, timeout_ms // 1000))
    except subprocess.TimeoutExpired:
        process.kill()
        return None


def run_linux_perf(
    options: InspectOptions, command: list[str], cwd: Path, out_dir: Path
) -> JsonObject:
    if not shutil.which("perf"):
        return {
            "status": "skip",
            "profile": options.profile,
            "reason": "perf unavailable",
        }
    perf_data = out_dir / "perf.data"
    record = run_command(
        CommandSpec(
            name="profile-perf-record",
            argv=["perf", "record", "-g", "-o", str(perf_data), "--", *command],
            cwd=cwd,
            out_dir=out_dir,
            timeout_ms=options.timeout_ms,
        )
    )
    report = run_perf_report(record, perf_data, cwd, out_dir, options.timeout_ms)
    return {
        "status": "pass" if record.status == "pass" else "review",
        "profile": options.profile,
        "command": command,
        "perf_data": str(perf_data),
        "record": record.to_json(),
        "report": report.to_json() if report else None,
    }


def run_perf_report(
    record: CommandResult, perf_data: Path, cwd: Path, out_dir: Path, timeout_ms: int
) -> CommandResult | None:
    if record.status != "pass" or not perf_data.exists():
        return None
    return run_command(
        CommandSpec(
            name="profile-perf-report",
            argv=["perf", "report", "--stdio", "-i", str(perf_data)],
            cwd=cwd,
            out_dir=out_dir,
            timeout_ms=timeout_ms,
        )
    )
