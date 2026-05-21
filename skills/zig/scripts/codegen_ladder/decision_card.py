from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .types import JsonArray, JsonObject, as_json_array, as_json_object

Decision = Literal[
    "locate_hot_boundary",
    "add_benchmark_signal",
    "edit_source",
    "ceiling_or_source_probe",
    "rerun_matched_benchmark",
    "claim_improvement_with_evidence",
    "report_non_timing_cleanup",
    "investigate_regression",
]

Severity = Literal["low", "medium", "high"]

CHECK_SEVERITY: dict[str, Severity] = {
    "allocator_hash_cache": "high",
    "copy_helpers": "medium",
    "diagnostics": "medium",
    "division": "medium",
}

CALL_SEVERITY: dict[str, Severity] = {
    "allocator": "high",
    "hash_map": "high",
    "copy": "medium",
    "diagnostic": "medium",
    "panic": "medium",
    "indirect": "medium",
    "unknown": "medium",
}

SIGNIFICANT_DELTA_PCT = 5.0


@dataclass(frozen=True)
class Hazard:
    source: str
    key: str
    count: int
    severity: Severity

    def to_json(self) -> JsonObject:
        return {
            "source": self.source,
            "key": self.key,
            "count": self.count,
            "severity": self.severity,
        }


def object_at(report: JsonObject, path: tuple[str, ...]) -> JsonObject:
    current: object = report
    for part in path:
        current_object = as_json_object(current)
        if current_object is None:
            return {}
        current = current_object.get(part)
    return as_json_object(current) or {}


def list_at(report: JsonObject, path: tuple[str, ...]) -> JsonArray:
    current: object = report
    for part in path:
        current_object = as_json_object(current)
        if current_object is None:
            return []
        current = current_object.get(part)
    return as_json_array(current) or []


def number_at(report: JsonObject, path: tuple[str, ...]) -> int | float | None:
    current: object = report
    for part in path:
        current_object = as_json_object(current)
        if current_object is None:
            return None
        current = current_object.get(part)
    if isinstance(current, bool):
        return None
    return current if isinstance(current, (int, float)) else None


def str_at(report: JsonObject, path: tuple[str, ...]) -> str:
    current: object = report
    for part in path:
        current_object = as_json_object(current)
        if current_object is None:
            return ""
        current = current_object.get(part)
    return current if isinstance(current, str) else ""


def bool_at(report: JsonObject, path: tuple[str, ...]) -> bool | None:
    current: object = report
    for part in path:
        current_object = as_json_object(current)
        if current_object is None:
            return None
        current = current_object.get(part)
    return current if isinstance(current, bool) else None


def inspect_hazards(report: JsonObject) -> list[Hazard]:
    hazards: list[Hazard] = []
    for value in list_at(report, ("checks",)):
        check = as_json_object(value) or {}
        key = check.get("key")
        count = check.get("count")
        if not isinstance(key, str) or not isinstance(count, int) or count <= 0:
            continue
        hazards.append(
            Hazard(
                source="check",
                key=key,
                count=count,
                severity=CHECK_SEVERITY.get(key, "medium"),
            )
        )

    calls = object_at(report, ("calls", "summary"))
    for key, value in calls.items():
        if not isinstance(value, int) or value <= 0:
            continue
        severity = CALL_SEVERITY.get(key, "low")
        hazards.append(Hazard(source="call", key=key, count=value, severity=severity))
    return hazards


def benchmark_fields(report: JsonObject) -> JsonObject:
    return object_at(report, ("runtime", "benchmark", "parsed"))


def has_elapsed_ns(report: JsonObject) -> bool:
    elapsed = benchmark_fields(report).get("elapsed_ns")
    return isinstance(elapsed, int) and elapsed > 0


def top_next_check_actions(report: JsonObject) -> list[str]:
    severity_rank = {"high": 0, "medium": 1, "low": 2}
    suggestions = [
        as_json_object(value) or {}
        for value in list_at(report, ("next_checks", "suggestions"))
    ]
    suggestions.sort(key=lambda item: severity_rank.get(str(item.get("severity")), 3))

    actions: list[str] = []
    for suggestion in suggestions:
        for value in as_json_array(suggestion.get("next_checks")) or []:
            if isinstance(value, str) and value not in actions:
                actions.append(value)
            if len(actions) >= 5:
                return actions
    return actions


def inspect_decision(
    hot_found: bool | None, elapsed: bool, hazards: list[Hazard]
) -> Decision:
    if hot_found is not True:
        return "locate_hot_boundary"
    if not elapsed:
        return "add_benchmark_signal"
    if hazards:
        return "edit_source"
    return "ceiling_or_source_probe"


def inspect_default_actions(decision: Decision) -> list[str]:
    if decision == "locate_hot_boundary":
        return [
            "confirm the symbol with nm or the build artifact's exported names",
            "extract the nearest measured public boundary when the helper is inlined",
        ]
    if decision == "add_benchmark_signal":
        return [
            "make the benchmark print elapsed_ns=<integer>",
            "include enough workload fields to compare later runs",
        ]
    if decision == "edit_source":
        return [
            "turn the highest-severity hazard into a source-level hypothesis",
            "rerun correctness and same-boundary timing after the edit",
        ]
    return [
        "compare a source-level alternative only when it changes work done",
        "report a practical ceiling when the simple source shape remains fastest",
    ]


def inspect_reporting_rule(decision: Decision) -> str:
    if decision == "locate_hot_boundary":
        return "Anchor machine-level claims to an extracted measured boundary."
    if decision == "add_benchmark_signal":
        return "Use speed claims after elapsed time and workload fields are present."
    if decision == "edit_source":
        return (
            "Use speed claims after the source edit removes or justifies the "
            "hot-boundary hazard and same-boundary timing is checked."
        )
    return (
        "Use clean compiler output as a ceiling or source-comparison signal, "
        "and pair speed claims with matched timing."
    )


def build_inspect_decision_card(report: JsonObject) -> JsonObject:
    hot_found = bool_at(report, ("hot_boundary", "symbol_found"))
    elapsed = has_elapsed_ns(report)
    hazards = inspect_hazards(report)
    decision = inspect_decision(hot_found, elapsed, hazards)
    actions = top_next_check_actions(report) or inspect_default_actions(decision)
    return {
        "schema_version": 1,
        "mode": "inspect",
        "decision": decision,
        "status": "continue" if decision != "ceiling_or_source_probe" else "review",
        "hot_boundary": {
            "symbol_found": hot_found,
            "state": "clean"
            if hot_found is True and not hazards
            else "review"
            if hot_found is True
            else "missing",
        },
        "benchmark": {
            "has_elapsed_ns": elapsed,
            "parsed": benchmark_fields(report),
        },
        "hazards": [hazard.to_json() for hazard in hazards],
        "recommended_actions": actions,
        "reporting_rule": inspect_reporting_rule(decision),
    }


def comparison_mismatches(report: JsonObject) -> list[JsonObject]:
    return [
        as_json_object(value) or {}
        for value in list_at(report, ("comparability", "mismatches"))
    ]


def delta_pct_value(report: JsonObject, path: tuple[str, ...]) -> int | float | None:
    return number_at(report, (*path, "delta_pct"))


def timing_class(report: JsonObject) -> str:
    delta_pct = delta_pct_value(report, ("timing", "elapsed_ns"))
    if delta_pct is None:
        return "missing"
    if delta_pct <= -SIGNIFICANT_DELTA_PCT:
        return "faster"
    if delta_pct >= SIGNIFICANT_DELTA_PCT:
        return "slower"
    return "equivalent"


def changed_hazards(report: JsonObject, path: tuple[str, ...]) -> list[JsonObject]:
    changes: list[JsonObject] = []
    for key, value in object_at(report, path).items():
        item = as_json_object(value) or {}
        delta = item.get("delta")
        if not isinstance(delta, (int, float)) or delta == 0:
            continue
        changes.append(
            {
                "key": key,
                "before": item.get("before"),
                "after": item.get("after"),
                "delta": delta,
                "direction": "added" if delta > 0 else "removed",
            }
        )
    return changes


def diff_decision(
    timing_claim: str,
    timing: str,
    added_hazards: list[JsonObject],
    removed_hazards: list[JsonObject],
) -> Decision:
    if timing_claim != "usable":
        return "rerun_matched_benchmark"
    if timing == "missing":
        return "add_benchmark_signal"
    if added_hazards or timing == "slower":
        return "investigate_regression"
    if timing == "faster":
        return "claim_improvement_with_evidence"
    if removed_hazards:
        return "report_non_timing_cleanup"
    return "ceiling_or_source_probe"


def diff_recommended_actions(decision: Decision) -> list[str]:
    if decision == "rerun_matched_benchmark":
        return [
            (
                "rerun both reports with the same boundary, workload, "
                "build mode, and checksum"
            ),
            (
                "use check and call deltas as exploration signals until "
                "timing is comparable"
            ),
        ]
    if decision == "add_benchmark_signal":
        return [
            "add elapsed_ns and workload fields to both benchmark outputs",
            "rerun the diff after timing fields parse",
        ]
    if decision == "investigate_regression":
        return [
            "inspect added hazards before claiming a cleanup",
            "rerun a focused source or layout alternative against the same boundary",
        ]
    if decision == "claim_improvement_with_evidence":
        return [
            (
                "report the matched boundary, correctness gate, elapsed delta, "
                "and removed hazards"
            ),
            "include remaining unmeasured risks",
        ]
    if decision == "report_non_timing_cleanup":
        return [
            "report the removed hazards as maintainability or risk reduction",
            "describe timing as equivalent on the measured boundary",
        ]
    return [
        "look for a source-level alternative that changes work done",
        "report a practical ceiling when alternatives stay equivalent",
    ]


def diff_reporting_rule(decision: Decision) -> str:
    if decision == "rerun_matched_benchmark":
        return "Use timing claims after the diff compares a matched runtime boundary."
    if decision == "add_benchmark_signal":
        return "Use speed claims after both reports expose parsed elapsed time."
    if decision == "investigate_regression":
        return "Treat slower timing or added hazards as a regression investigation."
    if decision == "claim_improvement_with_evidence":
        return (
            "Tie the performance claim to matched timing, correctness, "
            "and hazard deltas."
        )
    if decision == "report_non_timing_cleanup":
        return "Separate hazard cleanup from speed claims when timing is equivalent."
    return (
        "Treat equivalent clean output as ceiling evidence or a prompt for "
        "source-level alternatives."
    )


def build_diff_decision_card(report: JsonObject) -> JsonObject:
    timing_claim = str_at(report, ("comparability", "timing_claim"))
    timing = timing_class(report)
    check_changes = changed_hazards(report, ("checks",))
    call_changes = changed_hazards(report, ("calls", "summary"))
    added = [
        *[item for item in check_changes if item.get("direction") == "added"],
        *[item for item in call_changes if item.get("direction") == "added"],
    ]
    removed = [
        *[item for item in check_changes if item.get("direction") == "removed"],
        *[item for item in call_changes if item.get("direction") == "removed"],
    ]
    decision = diff_decision(timing_claim, timing, added, removed)
    return {
        "schema_version": 1,
        "mode": "diff",
        "decision": decision,
        "status": "continue"
        if decision
        in {
            "rerun_matched_benchmark",
            "add_benchmark_signal",
            "investigate_regression",
        }
        else "report",
        "comparability": {
            "status": str_at(report, ("comparability", "status")),
            "timing_claim": timing_claim,
            "mismatch_count": len(comparison_mismatches(report)),
        },
        "timing": {
            "class": timing,
            "significant_delta_pct": SIGNIFICANT_DELTA_PCT,
            "elapsed_ns": object_at(report, ("timing", "elapsed_ns")),
        },
        "hazard_changes": {
            "added": added,
            "removed": removed,
        },
        "recommended_actions": diff_recommended_actions(decision),
        "reporting_rule": diff_reporting_rule(decision),
    }
