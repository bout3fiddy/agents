from __future__ import annotations

import json
from pathlib import Path
from typing import cast

from .decision_card import build_diff_decision_card
from .types import DiffOptions, JsonObject, JsonValue, as_json_array, as_json_object


def load_report(path: str) -> JsonObject:
    data = cast(JsonValue, json.loads(Path(path).read_text(encoding="utf-8")))
    report = as_json_object(data)
    if report is None:
        raise SystemExit(f"expected JSON object report: {path}")
    return report


def numeric_delta(before: int | float | None, after: int | float | None) -> JsonObject:
    if before is None or after is None:
        return {"before": before, "after": after, "delta": None, "delta_pct": None}
    delta = after - before
    return {
        "before": before,
        "after": after,
        "delta": delta,
        "delta_pct": None if before == 0 else (delta / before) * 100.0,
    }


def json_object(value: JsonValue) -> JsonObject:
    return as_json_object(value) or {}


def json_list(value: JsonValue) -> list[JsonValue]:
    return as_json_array(value) or []


def string_value(value: JsonValue) -> str | None:
    return value if isinstance(value, str) else None


def int_value(value: JsonValue) -> int | None:
    return value if isinstance(value, int) else None


def number_value(value: JsonValue) -> int | float | None:
    if isinstance(value, bool):
        return None
    return value if isinstance(value, (int, float)) else None


def primitive_value(value: JsonValue) -> str | int | float | bool | None:
    if isinstance(value, (str, int, float, bool)):
        return value
    return None


def value_path(
    report: JsonObject, path: tuple[str, ...]
) -> str | int | float | bool | None:
    current: JsonValue = report
    for part in path:
        current_object = json_object(current)
        current = current_object.get(part)
    return primitive_value(current)


def string_path(report: JsonObject, path: tuple[str, ...]) -> str | None:
    return string_value(value_path(report, path))


def check_count_map(report: JsonObject) -> dict[str, int]:
    checks = json_list(report.get("checks"))
    counts: dict[str, int] = {}
    for check_value in checks:
        check = json_object(check_value)
        key = check.get("key")
        if not isinstance(key, str):
            continue
        counts[key] = int_value(check.get("count")) or 0
    return counts


def call_summary(report: JsonObject) -> dict[str, int]:
    calls = json_object(report.get("calls"))
    summary = json_object(calls.get("summary"))
    return {key: value for key, value in summary.items() if isinstance(value, int)}


def call_target_set(report: JsonObject) -> set[str]:
    calls = json_object(report.get("calls"))
    call_items = json_list(calls.get("calls"))
    targets: set[str] = set()
    for call_value in call_items:
        call = json_object(call_value)
        target = call.get("target")
        if isinstance(target, str) and target:
            targets.add(target)
    return targets


def symbol_name_set(report: JsonObject) -> set[str]:
    symbols = json_object(report.get("symbols"))
    matches = json_list(symbols.get("matches"))
    names: set[str] = set()
    for match_value in matches:
        match = json_object(match_value)
        name = match.get("name")
        if isinstance(name, str) and name:
            names.add(name)
    return names


def benchmark_elapsed(report: JsonObject) -> int | None:
    elapsed = benchmark_parsed(report).get("elapsed_ns")
    return int_value(elapsed)


def benchmark_parsed(report: JsonObject) -> JsonObject:
    runtime = json_object(report.get("runtime"))
    benchmark = json_object(runtime.get("benchmark"))
    return json_object(benchmark.get("parsed"))


def benchmark_value(report: JsonObject, key: str) -> str | int | float | bool | None:
    return primitive_value(benchmark_parsed(report).get(key))


BENCHMARK_COMPARE_KEYS = (
    "boundary",
    "records",
    "samples",
    "frames",
    "pixels",
    "events",
    "items",
    "bytes",
    "rows",
    "cols",
    "iterations",
    "warmup",
    "checksum",
)


def benchmark_comparisons(before: JsonObject, after: JsonObject) -> list[JsonObject]:
    before_parsed = benchmark_parsed(before)
    after_parsed = benchmark_parsed(after)
    keys = [
        key
        for key in BENCHMARK_COMPARE_KEYS
        if key in before_parsed or key in after_parsed
    ]
    return [
        comparison(
            f"benchmark.{key}",
            benchmark_value(before, key),
            benchmark_value(after, key),
            "runtime",
        )
        for key in keys
    ]


def hot_boundary_lines(report: JsonObject) -> int | None:
    hot_boundary = json_object(report.get("hot_boundary"))
    return int_value(hot_boundary.get("lines"))


def comparison(field: str, before: object, after: object, affects: str) -> JsonObject:
    return {
        "field": field,
        "before": before,
        "after": after,
        "match": before == after,
        "affects": affects,
    }


def comparability_report(before: JsonObject, after: JsonObject) -> JsonObject:
    comparisons = [
        comparison(
            "source",
            string_path(before, ("inputs", "source")),
            string_path(after, ("inputs", "source")),
            "provenance",
        ),
        comparison(
            "symbol",
            string_path(before, ("inputs", "symbol")),
            string_path(after, ("inputs", "symbol")),
            "boundary",
        ),
        comparison(
            "build_strategy",
            string_path(before, ("build_strategy",)),
            string_path(after, ("build_strategy",)),
            "build",
        ),
        comparison(
            "build_step",
            string_path(before, ("inputs", "build_step")),
            string_path(after, ("inputs", "build_step")),
            "build",
        ),
        comparison(
            "bench_step",
            string_path(before, ("inputs", "bench_step")),
            string_path(after, ("inputs", "bench_step")),
            "runtime",
        ),
        comparison(
            "benchmark_command",
            string_path(before, ("runtime", "benchmark", "command_name")),
            string_path(after, ("runtime", "benchmark", "command_name")),
            "runtime",
        ),
        comparison(
            "zig_version",
            string_path(before, ("environment", "zig_env", "version")),
            string_path(after, ("environment", "zig_env", "version")),
            "compiler",
        ),
        comparison(
            "zig_target",
            string_path(before, ("environment", "zig_env", "target")),
            string_path(after, ("environment", "zig_env", "target")),
            "compiler",
        ),
        comparison(
            "host_machine",
            string_path(before, ("environment", "host", "machine")),
            string_path(after, ("environment", "host", "machine")),
            "host",
        ),
        *benchmark_comparisons(before, after),
    ]
    mismatches = [item for item in comparisons if item.get("match") is False]
    boundary_review = any(item.get("affects") == "boundary" for item in mismatches)
    runtime_review = any(item.get("affects") == "runtime" for item in mismatches)
    return {
        "status": "review" if mismatches else "comparable",
        "timing_claim": (
            "needs_matched_boundary" if boundary_review or runtime_review else "usable"
        ),
        "guidance": (
            "Use timing deltas for speed claims when status is comparable. "
            "When status is review, use check and call deltas as exploration "
            "signals and re-run on a matched boundary before claiming speed."
        ),
        "fields": comparisons,
        "mismatches": mismatches,
    }


def diff_reports(options: DiffOptions) -> JsonObject:
    before = load_report(options.before)
    after = load_report(options.after)
    before_checks = check_count_map(before)
    after_checks = check_count_map(after)
    all_check_keys = sorted(set(before_checks) | set(after_checks))
    before_calls = call_summary(before)
    after_calls = call_summary(after)
    all_call_keys = sorted(set(before_calls) | set(after_calls))
    before_targets = call_target_set(before)
    after_targets = call_target_set(after)
    before_symbols = symbol_name_set(before)
    after_symbols = symbol_name_set(after)
    report: JsonObject = {
        "schema_version": 1,
        "mode": "diff",
        "inputs": {
            "before": str(Path(options.before).resolve()),
            "after": str(Path(options.after).resolve()),
        },
        "comparability": comparability_report(before, after),
        "benchmark": {
            "before": benchmark_parsed(before),
            "after": benchmark_parsed(after),
            "comparisons": benchmark_comparisons(before, after),
        },
        "timing": {
            "elapsed_ns": numeric_delta(
                benchmark_elapsed(before), benchmark_elapsed(after)
            ),
        },
        "hot_boundary": {
            "line_count": numeric_delta(
                hot_boundary_lines(before), hot_boundary_lines(after)
            ),
        },
        "checks": {
            key: numeric_delta(before_checks.get(key, 0), after_checks.get(key, 0))
            for key in all_check_keys
        },
        "calls": {
            "summary": {
                key: numeric_delta(before_calls.get(key, 0), after_calls.get(key, 0))
                for key in all_call_keys
            },
            "new_targets": sorted(after_targets - before_targets),
            "removed_targets": sorted(before_targets - after_targets),
        },
        "symbols": {
            "new_matches": sorted(after_symbols - before_symbols),
            "removed_matches": sorted(before_symbols - after_symbols),
        },
        "agent_queries": [
            "jq -r '.comparability.status, .comparability.timing_claim' diff.json",
            (
                "jq -r '.comparability.mismatches[]? "
                "| [.field, .before, .after] | @tsv' diff.json"
            ),
            (
                "jq -r '.benchmark.comparisons[]? | select(.match == false) "
                "| [.field, .before, .after] | @tsv' diff.json"
            ),
            (
                "jq -r '.checks | to_entries[] "
                "| select(.value.delta != 0) "
                "| [.key, .value.before, .value.after, .value.delta] "
                "| @tsv' diff.json"
            ),
            (
                "jq -r '.calls.summary | to_entries[] "
                "| select(.value.delta != 0) "
                "| [.key, .value.before, .value.after, .value.delta] "
                "| @tsv' diff.json"
            ),
            "jq '.decision_card' diff.json",
        ],
    }
    report["decision_card"] = build_diff_decision_card(report)
    return report
