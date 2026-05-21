from __future__ import annotations

import json
import re
from pathlib import Path
from typing import cast

from .common import read_text
from .types import JsonObject, JsonValue, as_json_object


def load_json_value(text: str) -> JsonValue:
    return cast(JsonValue, json.loads(text))


def allocation_expectation(
    count: int | None, expected_allocs: int | None, missing_reason: str | None = None
) -> JsonObject | None:
    if expected_allocs is None:
        return None
    if missing_reason:
        return {
            "expected_allocations": expected_allocs,
            "status": "unknown",
            "reason": missing_reason,
        }
    return {
        "expected_allocations": expected_allocs,
        "actual_allocations": count,
        "status": "unknown"
        if count is None
        else "pass"
        if count == expected_allocs
        else "review",
    }


def parse_allocation_text(text: str) -> JsonValue:
    try:
        return load_json_value(text)
    except json.JSONDecodeError:
        parsed: JsonObject = {}
        for match in re.finditer(r"([A-Za-z_][A-Za-z0-9_]*)=(\d+)", text):
            parsed[match.group(1)] = int(match.group(2))
        return parsed or {"raw": text}


def allocation_count(data: JsonValue) -> int | None:
    data_object = as_json_object(data)
    if data_object is None:
        return None
    for key in (
        "allocations",
        "allocation_count",
        "alloc_count",
        "total_allocations",
    ):
        value = data_object.get(key)
        if isinstance(value, int):
            return value
    return None


def read_allocation_report(
    path_value: str | None, cwd: Path, expect_allocs: int | None
) -> JsonObject:
    if not path_value:
        return {
            "status": "skip",
            "report_path": None,
            "data": None,
            "expectation": allocation_expectation(
                None, expect_allocs, "no allocation report path supplied"
            ),
        }
    path = Path(path_value)
    if not path.is_absolute():
        path = cwd / path
    if not path.exists():
        return {
            "status": "missing",
            "report_path": str(path),
            "data": None,
            "expectation": allocation_expectation(
                None, expect_allocs, "allocation report file missing"
            ),
        }

    data = parse_allocation_text(read_text(path).strip())
    count = allocation_count(data)
    return {
        "status": "pass",
        "report_path": str(path),
        "data": data,
        "expectation": allocation_expectation(count, expect_allocs),
    }
