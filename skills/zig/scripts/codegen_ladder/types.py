from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, cast

JsonValue = object
JsonObject = dict[str, object]
JsonArray = list[object]

CommandState = Literal["pass", "fail"]
ProfileMode = Literal["none", "macos-sample", "linux-perf"]


def as_json_object(value: object) -> JsonObject | None:
    return cast(JsonObject, value) if isinstance(value, dict) else None


def as_json_array(value: object) -> JsonArray | None:
    return cast(JsonArray, value) if isinstance(value, list) else None


@dataclass(frozen=True)
class CommandResult:
    name: str
    argv: list[str]
    cwd: str
    exit_code: int | None
    timed_out: bool
    duration_ms: int
    status: CommandState
    stdout_path: str
    stderr_path: str
    stdout_head: str
    stderr_head: str

    def to_json(self) -> JsonObject:
        return {
            "name": self.name,
            "argv": list(self.argv),
            "cwd": self.cwd,
            "exit_code": self.exit_code,
            "timed_out": self.timed_out,
            "duration_ms": self.duration_ms,
            "status": self.status,
            "stdout_path": self.stdout_path,
            "stderr_path": self.stderr_path,
            "stdout_head": self.stdout_head,
            "stderr_head": self.stderr_head,
        }


@dataclass(frozen=True)
class InspectOptions:
    source: str | None
    symbol: str
    out: str | None
    build_root: str | None
    artifact: str | None
    build_step: str | None
    test_step: str | None
    bench_step: str | None
    build_option: list[str]
    run_arg: list[str]
    bench_arg: list[str]
    run_env: list[str]
    bench_env: list[str]
    emit_ir: bool
    alloc_report: str | None
    expect_allocs: int | None
    profile: ProfileMode
    profile_seconds: int
    llvm_mca: bool
    max_matches: int
    timeout_ms: int
    json_out: str | None


@dataclass(frozen=True)
class DiffOptions:
    before: str
    after: str
    json_out: str | None
