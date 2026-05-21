from __future__ import annotations

import json
from pathlib import Path
from typing import cast

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


def int_value(value: JsonValue) -> int | None:
    return value if isinstance(value, int) else None


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
    runtime = json_object(report.get("runtime"))
    benchmark = json_object(runtime.get("benchmark"))
    parsed = json_object(benchmark.get("parsed"))
    return int_value(parsed.get("elapsed_ns"))


def hot_boundary_lines(report: JsonObject) -> int | None:
    hot_boundary = json_object(report.get("hot_boundary"))
    return int_value(hot_boundary.get("lines"))


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
    return {
        "schema_version": 1,
        "mode": "diff",
        "inputs": {
            "before": str(Path(options.before).resolve()),
            "after": str(Path(options.after).resolve()),
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
    }
