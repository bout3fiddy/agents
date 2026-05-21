from __future__ import annotations

import os
import platform
import shutil
from dataclasses import dataclass
from pathlib import Path

from .allocation import read_allocation_report
from .artifacts import (
    copy_if_exists,
    infer_artifact,
    parse_elapsed_ns,
    parse_zig_env,
    resolve_source,
    zig_build_argv,
)
from .asm import extract_hot_asm, parse_nm_symbols
from .calls import parse_calls
from .checks import build_checks
from .common import (
    CommandSpec,
    command_by_name,
    command_status,
    default_scratch,
    parse_key_value_env,
    read_text,
    run_command,
)
from .llvm_mca import run_llvm_mca
from .next_checks import build_next_checks
from .profiling import run_profiler
from .source_map import collect_source_items, source_map_entries
from .types import CommandResult, InspectOptions, JsonObject


@dataclass(frozen=True)
class ArtifactPaths:
    emitted_asm: Path
    full_asm: Path
    hot_asm: Path
    symbols: Path
    llvm_ir: Path


@dataclass(frozen=True)
class InspectContext:
    cwd: Path
    source: Path | None
    out_dir: Path
    artifact: Path | None
    paths: ArtifactPaths
    source_mode: bool
    build_step_mode: bool
    build_options: list[str]
    run_env: dict[str, str]
    bench_env: dict[str, str]


def run_context_command(
    options: InspectOptions,
    context: InspectContext,
    name: str,
    argv: list[str],
    env_extra: dict[str, str] | None = None,
) -> CommandResult:
    return run_command(
        CommandSpec(
            name=name,
            argv=argv,
            cwd=context.cwd,
            out_dir=context.out_dir,
            timeout_ms=options.timeout_ms,
            env_extra=env_extra,
        )
    )


def build_context(options: InspectOptions) -> InspectContext:
    cwd = Path(options.build_root or os.getcwd()).resolve()
    source = resolve_source(options.source, cwd)
    out_dir = Path(options.out).resolve() if options.out else default_scratch()
    out_dir.mkdir(parents=True, exist_ok=True)
    source_mode = source is not None
    build_step_mode = bool(options.build_step)
    artifact = infer_artifact(cwd, options.build_step, options.artifact)
    if source_mode and artifact is None:
        artifact = out_dir / "app"
    if options.symbol.strip() == "":
        raise SystemExit("--symbol is required")
    if not source_mode and artifact is None:
        raise SystemExit("provide --source, --artifact, or --build-step")
    return InspectContext(
        cwd=cwd,
        source=source,
        out_dir=out_dir,
        artifact=artifact,
        paths=ArtifactPaths(
            emitted_asm=out_dir / "full.s",
            full_asm=out_dir / "full.asm",
            hot_asm=out_dir / "hot.asm",
            symbols=out_dir / "symbols.nm",
            llvm_ir=out_dir / "optimized.ll",
        ),
        source_mode=source_mode,
        build_step_mode=build_step_mode,
        build_options=list(options.build_option),
        run_env=parse_key_value_env(options.run_env),
        bench_env=parse_key_value_env(options.bench_env),
    )


def run_correctness(
    options: InspectOptions, context: InspectContext
) -> list[CommandResult]:
    commands: list[CommandResult] = []
    if options.test_step:
        commands.append(
            run_context_command(
                options,
                context,
                name="zig-build-test-step",
                argv=zig_build_argv(options.test_step, context.build_options),
            )
        )
    elif context.source_mode and context.source is not None:
        commands.append(
            run_context_command(
                options,
                context,
                name="zig-test",
                argv=["zig", "test", str(context.source), "-OReleaseFast"],
            )
        )
    return commands


def run_benchmark(
    options: InspectOptions, context: InspectContext
) -> list[CommandResult]:
    commands: list[CommandResult] = []
    if options.bench_step:
        commands.append(
            run_context_command(
                options,
                context,
                name="zig-build-bench-step",
                argv=zig_build_argv(
                    options.bench_step, context.build_options, list(options.bench_arg)
                ),
                env_extra=context.bench_env,
            )
        )
    elif context.source_mode and context.source is not None and options.run_arg:
        commands.append(
            run_context_command(
                options,
                context,
                name="zig-run",
                argv=[
                    "zig",
                    "run",
                    str(context.source),
                    "-OReleaseFast",
                    "--",
                    *options.run_arg,
                ],
                env_extra=context.run_env,
            )
        )
    return commands


def run_build(options: InspectOptions, context: InspectContext) -> list[CommandResult]:
    commands: list[CommandResult] = []
    if context.build_step_mode:
        commands.append(
            run_context_command(
                options,
                context,
                name="zig-build-step",
                argv=zig_build_argv(options.build_step, context.build_options),
            )
        )
    elif context.source_mode and context.source is not None:
        commands.append(
            run_context_command(
                options,
                context,
                name="build-exe",
                argv=[
                    "zig",
                    "build-exe",
                    str(context.source),
                    "-OReleaseFast",
                    "-fno-strip",
                    f"-femit-bin={context.artifact}",
                ],
            )
        )
    return commands


def emit_source_artifacts(
    options: InspectOptions, context: InspectContext, commands: list[CommandResult]
) -> list[CommandResult]:
    if (
        not context.source_mode
        or context.source is None
        or command_status(commands, "build-exe") != "pass"
    ):
        return []
    emitted = [
        run_context_command(
            options,
            context,
            name="emit-asm",
            argv=[
                "zig",
                "build-exe",
                str(context.source),
                "-OReleaseFast",
                "-fno-emit-bin",
                f"-femit-asm={context.paths.emitted_asm}",
            ],
        )
    ]
    if options.emit_ir:
        emitted.append(
            run_context_command(
                options,
                context,
                name="emit-llvm-ir",
                argv=[
                    "zig",
                    "build-exe",
                    str(context.source),
                    "-OReleaseFast",
                    "-fno-emit-bin",
                    f"-femit-llvm-ir={context.paths.llvm_ir}",
                ],
            )
        )
    return emitted


def collect_binary_artifacts(
    options: InspectOptions, context: InspectContext
) -> list[CommandResult]:
    if context.artifact is None or not context.artifact.exists():
        return []
    commands: list[CommandResult] = []
    nm_tool = shutil.which("nm")
    if nm_tool:
        nm_result = run_context_command(
            options,
            context,
            name="nm",
            argv=[nm_tool, "-an", str(context.artifact)],
        )
        commands.append(nm_result)
        copy_if_exists(Path(nm_result.stdout_path), context.paths.symbols)
    commands.extend(run_disassemblers(options, context))
    return commands


def disassembly_commands(artifact: Path) -> list[list[str]]:
    commands: list[list[str]] = []
    if shutil.which("objdump"):
        commands.extend(
            [
                ["objdump", "--disassemble", "--no-show-raw-insn", str(artifact)],
                [
                    "objdump",
                    "--macho",
                    "--disassemble",
                    "--no-show-raw-insn",
                    str(artifact),
                ],
            ]
        )
    if shutil.which("otool"):
        commands.append(["otool", "-tvV", str(artifact)])
    return commands


def run_disassemblers(
    options: InspectOptions, context: InspectContext
) -> list[CommandResult]:
    if context.artifact is None:
        return []
    commands: list[CommandResult] = []
    for index, argv in enumerate(disassembly_commands(context.artifact)):
        result = run_context_command(
            options,
            context,
            name=f"disassemble-{index + 1}",
            argv=argv,
        )
        commands.append(result)
        if result.status == "pass":
            copy_if_exists(Path(result.stdout_path), context.paths.full_asm)
            break
    return commands


def command_json(commands: list[CommandResult]) -> list[JsonObject]:
    return [command.to_json() for command in commands]


def benchmark_output(commands: list[CommandResult]) -> str:
    run_command_result = command_by_name(commands, "zig-run") or command_by_name(
        commands, "zig-build-bench-step"
    )
    if run_command_result is None:
        return ""
    return "\n".join(
        [
            read_text(Path(run_command_result.stdout_path)),
            read_text(Path(run_command_result.stderr_path)),
        ]
    )


def selected_benchmark_command(commands: list[CommandResult]) -> CommandResult | None:
    return command_by_name(commands, "zig-run") or command_by_name(
        commands, "zig-build-bench-step"
    )


def build_strategy(context: InspectContext) -> str:
    if context.build_step_mode:
        return "build-step"
    if context.source_mode:
        return "direct-source"
    return "artifact"


def artifact_report(context: InspectContext) -> JsonObject:
    return {
        "artifact": str(context.artifact) if context.artifact else None,
        "emitted_asm": str(context.paths.emitted_asm)
        if context.paths.emitted_asm.exists()
        else None,
        "llvm_ir": str(context.paths.llvm_ir)
        if context.paths.llvm_ir.exists()
        else None,
        "full_asm": str(context.paths.full_asm)
        if context.paths.full_asm.exists()
        else None,
        "hot_asm": str(context.paths.hot_asm)
        if context.paths.hot_asm.exists()
        else None,
        "symbols": str(context.paths.symbols)
        if context.paths.symbols.exists()
        else None,
    }


def tool_report() -> JsonObject:
    return {
        "zig": shutil.which("zig"),
        "nm": shutil.which("nm"),
        "objdump": shutil.which("objdump"),
        "otool": shutil.which("otool"),
        "atos": shutil.which("atos"),
        "addr2line": shutil.which("addr2line"),
        "sample": shutil.which("sample"),
        "perf": shutil.which("perf"),
        "llvm_mca": shutil.which("llvm-mca"),
        "jq": shutil.which("jq"),
    }


def inspect(options: InspectOptions) -> JsonObject:
    context = build_context(options)
    commands: list[CommandResult] = []
    commands.extend(run_correctness(options, context))
    commands.extend(run_benchmark(options, context))
    commands.extend(run_build(options, context))
    commands.extend(emit_source_artifacts(options, context, commands))
    commands.extend(collect_binary_artifacts(options, context))

    hot = extract_hot_asm(
        symbol_query=options.symbol,
        full_asm_path=context.paths.full_asm,
        emitted_asm_path=context.paths.emitted_asm,
        hot_asm_path=context.paths.hot_asm,
    )
    hot_found = bool(hot["symbol_found"])
    checks = build_checks(context.paths.hot_asm, hot_found, options.max_matches)
    empty_calls: JsonObject = {
        "count": 0,
        "summary": {},
        "calls": [],
    }
    calls: JsonObject = (
        parse_calls(context.paths.hot_asm, options.max_matches)
        if hot_found
        else empty_calls
    )
    empty_symbols: JsonObject = {"found": False, "matches": []}
    symbols: JsonObject = (
        parse_nm_symbols(context.paths.symbols, options.symbol)
        if context.paths.symbols.exists()
        else empty_symbols
    )
    source_map = source_map_entries(
        context.artifact, collect_source_items(checks, calls), context.cwd
    )
    run_command_result = selected_benchmark_command(commands)
    output = benchmark_output(commands)
    report: JsonObject = {
        "schema_version": 1,
        "mode": "inspect",
        "build_strategy": build_strategy(context),
        "inputs": {
            "source": str(context.source) if context.source else None,
            "symbol": options.symbol,
            "build_root": str(context.cwd),
            "build_step": options.build_step,
            "test_step": options.test_step,
            "bench_step": options.bench_step,
            "artifact": str(context.artifact) if context.artifact else None,
        },
        "scratch": str(context.out_dir),
        "environment": {
            "host": {
                "system": platform.system(),
                "machine": platform.machine(),
                "platform": platform.platform(),
            },
            "tools": tool_report(),
            "zig_env": parse_zig_env(context.cwd),
        },
        "commands": command_json(commands),
        "artifacts": artifact_report(context),
        "runtime": {
            "test": {
                "status": command_status(commands, "zig-build-test-step")
                if options.test_step
                else command_status(commands, "zig-test"),
            },
            "benchmark": {
                "status": run_command_result.status if run_command_result else "skip",
                "command_name": run_command_result.name if run_command_result else None,
                "parsed": {"elapsed_ns": parse_elapsed_ns(output)},
            },
        },
        "symbols": symbols,
        "hot_boundary": hot,
        "checks": checks,
        "calls": calls,
        "source_map": source_map,
        "allocation": read_allocation_report(
            options.alloc_report, context.cwd, options.expect_allocs
        ),
        "profiler": run_profiler(options, context.source, context.cwd, context.out_dir),
        "llvm_mca": run_llvm_mca(
            options, context.paths.hot_asm, context.cwd, context.out_dir
        ),
        "agent_queries": [
            (
                "jq -r '.next_checks.suggestions[]? "
                "| [.id, .severity, .confidence] | @tsv' report.json"
            ),
            (
                'jq -r \'.checks[] | select(.status=="review") '
                "| [.key, .count] | @tsv' report.json"
            ),
            "jq -r '.artifacts.hot_asm' report.json | xargs sed -n '1,160p'",
            "jq -r '.calls.summary // {}' report.json",
            "jq -r '.symbols.matches[].name' report.json",
        ],
    }
    report["next_checks"] = build_next_checks(report)
    return report
