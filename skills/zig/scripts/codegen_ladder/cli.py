# argparse intentionally returns Action objects while building the parser.
# The parser shape is validated by converting the Namespace into dataclasses.
# pyright: reportUnusedCallResult=false

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import cast

from .common import normalize_option_values
from .diff import diff_reports
from .inspect import inspect
from .types import DiffOptions, InspectOptions, JsonObject, ProfileMode


def optional_string(namespace: argparse.Namespace, name: str) -> str | None:
    value = cast(object, getattr(namespace, name))
    return value if isinstance(value, str) else None


def required_string(namespace: argparse.Namespace, name: str) -> str:
    value = cast(object, getattr(namespace, name))
    if not isinstance(value, str):
        raise SystemExit(f"missing required argument: --{name.replace('_', '-')}")
    return value


def string_list(namespace: argparse.Namespace, name: str) -> list[str]:
    value = cast(object, getattr(namespace, name))
    if value is None:
        return []
    if isinstance(value, list):
        items = cast(list[object], value)
        if all(isinstance(item, str) for item in items):
            return cast(list[str], items)
    raise SystemExit(f"expected repeated string argument: --{name.replace('_', '-')}")


def int_value(namespace: argparse.Namespace, name: str) -> int:
    value = cast(object, getattr(namespace, name))
    if isinstance(value, int):
        return value
    raise SystemExit(f"expected integer argument: --{name.replace('_', '-')}")


def optional_int(namespace: argparse.Namespace, name: str) -> int | None:
    value = cast(object, getattr(namespace, name))
    if value is None or isinstance(value, int):
        return value
    raise SystemExit(f"expected integer argument: --{name.replace('_', '-')}")


def bool_value(namespace: argparse.Namespace, name: str) -> bool:
    value = cast(object, getattr(namespace, name))
    if isinstance(value, bool):
        return value
    raise SystemExit(f"expected boolean argument: --{name.replace('_', '-')}")


def profile_mode(namespace: argparse.Namespace) -> ProfileMode:
    value = required_string(namespace, "profile")
    if value not in {"none", "macos-sample", "linux-perf"}:
        raise SystemExit(f"unsupported profile mode: {value}")
    return cast(ProfileMode, value)


def inspect_options(namespace: argparse.Namespace) -> InspectOptions:
    return InspectOptions(
        source=optional_string(namespace, "source"),
        symbol=required_string(namespace, "symbol"),
        out=optional_string(namespace, "out"),
        build_root=optional_string(namespace, "build_root"),
        artifact=optional_string(namespace, "artifact"),
        build_step=optional_string(namespace, "build_step"),
        test_step=optional_string(namespace, "test_step"),
        bench_step=optional_string(namespace, "bench_step"),
        build_option=string_list(namespace, "build_option"),
        run_arg=string_list(namespace, "run_arg"),
        bench_arg=string_list(namespace, "bench_arg"),
        run_env=string_list(namespace, "run_env"),
        bench_env=string_list(namespace, "bench_env"),
        emit_ir=bool_value(namespace, "emit_ir"),
        alloc_report=optional_string(namespace, "alloc_report"),
        expect_allocs=optional_int(namespace, "expect_allocs"),
        profile=profile_mode(namespace),
        profile_seconds=int_value(namespace, "profile_seconds"),
        llvm_mca=bool_value(namespace, "llvm_mca"),
        max_matches=int_value(namespace, "max_matches"),
        timeout_ms=int_value(namespace, "timeout_ms"),
        json_out=optional_string(namespace, "json_out"),
    )


def diff_options(namespace: argparse.Namespace) -> DiffOptions:
    return DiffOptions(
        before=required_string(namespace, "before"),
        after=required_string(namespace, "after"),
        json_out=optional_string(namespace, "json_out"),
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Emit JSON evidence for Zig codegen, benchmark, symbol, "
            "and disassembly checks."
        ),
    )
    subparsers = parser.add_subparsers(dest="command")

    inspect_parser = subparsers.add_parser(
        "inspect", help="inspect one source file, build step, or artifact"
    )
    inspect_parser.add_argument("--source")
    inspect_parser.add_argument("--symbol", required=True)
    inspect_parser.add_argument("--out")
    inspect_parser.add_argument("--build-root")
    inspect_parser.add_argument("--artifact")
    inspect_parser.add_argument("--build-step")
    inspect_parser.add_argument("--test-step")
    inspect_parser.add_argument("--bench-step")
    inspect_parser.add_argument("--build-option", action="append", default=[])
    inspect_parser.add_argument("--run-arg", action="append", default=[])
    inspect_parser.add_argument("--bench-arg", action="append", default=[])
    inspect_parser.add_argument("--run-env", action="append", default=[])
    inspect_parser.add_argument("--bench-env", action="append", default=[])
    inspect_parser.add_argument("--emit-ir", action="store_true")
    inspect_parser.add_argument("--alloc-report")
    inspect_parser.add_argument("--expect-allocs", type=int)
    inspect_parser.add_argument(
        "--profile", choices=["none", "macos-sample", "linux-perf"], default="none"
    )
    inspect_parser.add_argument("--profile-seconds", type=int, default=10)
    inspect_parser.add_argument("--llvm-mca", action="store_true")
    inspect_parser.add_argument("--max-matches", type=int, default=24)
    inspect_parser.add_argument("--timeout-ms", type=int, default=120_000)
    inspect_parser.add_argument("--json-out")

    diff_parser = subparsers.add_parser("diff", help="compare two JSON reports")
    diff_parser.add_argument("--before", required=True)
    diff_parser.add_argument("--after", required=True)
    diff_parser.add_argument("--json-out")
    return parser


def run_from_namespace(
    parser: argparse.ArgumentParser, args: argparse.Namespace
) -> tuple[JsonObject, str | None]:
    command = optional_string(args, "command")
    if command is None:
        parser.print_help()
        raise SystemExit(2)
    if command == "inspect":
        options = inspect_options(args)
        return inspect(options), options.json_out
    if command == "diff":
        options = diff_options(args)
        return diff_reports(options), options.json_out
    raise SystemExit(f"unsupported command: {command}")


def main(argv: list[str]) -> int:
    normalized = normalize_option_values(argv)
    if normalized and normalized[0] not in {"inspect", "diff", "-h", "--help"}:
        normalized = ["inspect", *normalized]
    parser = build_parser()
    report, json_out = run_from_namespace(parser, parser.parse_args(normalized))
    text = json.dumps(report, indent=2, sort_keys=True)
    if json_out:
        _ = Path(json_out).write_text(f"{text}\n", encoding="utf-8")
    print(text)
    return 0
