from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .types import JsonArray, JsonObject, as_json_array, as_json_object

Severity = Literal["low", "medium", "high"]
Confidence = Literal["low", "medium", "high"]


@dataclass(frozen=True)
class EvidencePoint:
    path: str
    value: object
    condition: str

    def to_json(self) -> JsonObject:
        return {
            "path": self.path,
            "value": self.value,
            "condition": self.condition,
        }


@dataclass(frozen=True)
class ToolCall:
    tool: str
    purpose: str
    jq: tuple[str, ...]
    command_hint: str | None = None

    def to_json(self) -> JsonObject:
        return {
            "tool": self.tool,
            "purpose": self.purpose,
            "jq": list(self.jq),
            "command_hint": self.command_hint,
        }


@dataclass(frozen=True)
class NextCheckRule:
    id: str
    category: str
    severity: Severity
    confidence: Confidence
    interpretation: str
    next_checks: tuple[str, ...]
    tool_call: ToolCall
    trigger: Callable[[JsonObject], list[EvidencePoint]]

    def evaluate(self, report: JsonObject) -> JsonObject | None:
        evidence = self.trigger(report)
        if not evidence:
            return None
        return {
            "id": self.id,
            "category": self.category,
            "severity": self.severity,
            "confidence": self.confidence,
            "triggered_by": [point.to_json() for point in evidence],
            "interpretation": self.interpretation,
            "next_checks": list(self.next_checks),
            "tool_call": self.tool_call.to_json(),
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


def int_at(report: JsonObject, path: tuple[str, ...]) -> int:
    current: object = report
    for part in path:
        current_object = as_json_object(current)
        if current_object is None:
            return 0
        current = current_object.get(part)
    return current if isinstance(current, int) else 0


def str_at(report: JsonObject, path: tuple[str, ...]) -> str:
    current: object = report
    for part in path:
        current_object = as_json_object(current)
        if current_object is None:
            return ""
        current = current_object.get(part)
    return current if isinstance(current, str) else ""


def source_text(report: JsonObject) -> str:
    source = str_at(report, ("inputs", "source"))
    if not source:
        return ""
    try:
        return Path(source).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""


def check_count(report: JsonObject, key: str) -> int:
    for check_value in list_at(report, ("checks",)):
        check = as_json_object(check_value)
        if check is None or check.get("key") != key:
            continue
        count = check.get("count")
        return count if isinstance(count, int) else 0
    return 0


def call_count(report: JsonObject, category: str) -> int:
    return int_at(report, ("calls", "summary", category))


def allocation_report_status(report: JsonObject) -> str:
    return str_at(report, ("allocation", "status"))


def evidence_when(
    condition: bool, path: str, value: object, label: str
) -> list[EvidencePoint]:
    if not condition:
        return []
    return [EvidencePoint(path=path, value=value, condition=label)]


def evidence_for_count(path: str, count: int) -> list[EvidencePoint]:
    return evidence_when(count > 0, path, count, "> 0")


def hot_allocator_evidence(report: JsonObject) -> list[EvidencePoint]:
    allocator_count = check_count(report, "allocator_hash_cache")
    call_allocator_count = call_count(report, "allocator")
    return [
        *evidence_for_count(".checks.allocator_hash_cache.count", allocator_count),
        *evidence_for_count(".calls.summary.allocator", call_allocator_count),
    ]


def hot_hash_lookup_evidence(report: JsonObject) -> list[EvidencePoint]:
    hash_count = call_count(report, "hash_map")
    check_value = check_count(report, "allocator_hash_cache")
    return [
        *evidence_for_count(".calls.summary.hash_map", hash_count),
        *evidence_for_count(".checks.allocator_hash_cache.count", check_value),
    ]


def copy_evidence(report: JsonObject) -> list[EvidencePoint]:
    check_value = check_count(report, "copy_helpers")
    copy_calls = call_count(report, "copy")
    return [
        *evidence_for_count(".checks.copy_helpers.count", check_value),
        *evidence_for_count(".calls.summary.copy", copy_calls),
    ]


def diagnostics_evidence(report: JsonObject) -> list[EvidencePoint]:
    check_value = check_count(report, "diagnostics")
    diagnostic_calls = call_count(report, "diagnostic")
    panic_calls = call_count(report, "panic")
    return [
        *evidence_for_count(".checks.diagnostics.count", check_value),
        *evidence_for_count(".calls.summary.diagnostic", diagnostic_calls),
        *evidence_for_count(".calls.summary.panic", panic_calls),
    ]


def division_evidence(report: JsonObject) -> list[EvidencePoint]:
    return evidence_for_count(".checks.division.count", check_count(report, "division"))


def unknown_call_evidence(report: JsonObject) -> list[EvidencePoint]:
    unknown_calls = call_count(report, "unknown")
    indirect_calls = call_count(report, "indirect")
    return [
        *evidence_for_count(".calls.summary.unknown", unknown_calls),
        *evidence_for_count(".calls.summary.indirect", indirect_calls),
    ]


def missing_symbol_evidence(report: JsonObject) -> list[EvidencePoint]:
    found = object_at(report, ("hot_boundary",)).get("symbol_found")
    return evidence_when(
        found is False,
        ".hot_boundary.symbol_found",
        found,
        "is false",
    )


def allocation_report_needed_evidence(report: JsonObject) -> list[EvidencePoint]:
    allocator_evidence = hot_allocator_evidence(report)
    status = allocation_report_status(report)
    if not allocator_evidence or status not in {"skip", "missing"}:
        return []
    return [
        *allocator_evidence,
        EvidencePoint(
            path=".allocation.status",
            value=status,
            condition="is skip or missing",
        ),
    ]


def benchmark_signal_evidence(report: JsonObject) -> list[EvidencePoint]:
    elapsed = object_at(report, ("runtime", "benchmark", "parsed")).get("elapsed_ns")
    status = str_at(report, ("runtime", "benchmark", "status"))
    if isinstance(elapsed, int) and elapsed > 0:
        return []
    return [
        EvidencePoint(
            path=".runtime.benchmark.status",
            value=status or "unknown",
            condition="has no parsed elapsed_ns",
        )
    ]


def llvm_mca_candidate_evidence(report: JsonObject) -> list[EvidencePoint]:
    hot_found = object_at(report, ("hot_boundary",)).get("symbol_found")
    llvm_status = str_at(report, ("llvm_mca", "status"))
    call_total = int_at(report, ("calls", "count"))
    division_count = check_count(report, "division")
    if hot_found is not True or llvm_status != "skip":
        return []
    if call_total == 0 and division_count == 0:
        return []
    return [
        EvidencePoint(
            path=".llvm_mca.status",
            value=llvm_status,
            condition="is skip while hot asm has calls or divisions",
        )
    ]


def clean_hot_boundary_ceiling_evidence(report: JsonObject) -> list[EvidencePoint]:
    hot_found = object_at(report, ("hot_boundary",)).get("symbol_found")
    elapsed = object_at(report, ("runtime", "benchmark", "parsed")).get("elapsed_ns")
    call_total = int_at(report, ("calls", "count"))
    check_counts = (
        check_count(report, "allocator_hash_cache"),
        check_count(report, "copy_helpers"),
        check_count(report, "diagnostics"),
        check_count(report, "division"),
    )
    if hot_found is not True or not isinstance(elapsed, int):
        return []
    if call_total != 0 or any(count != 0 for count in check_counts):
        return []
    return [
        EvidencePoint(
            path=".hot_boundary.symbol_found",
            value=hot_found,
            condition="is true",
        ),
        EvidencePoint(
            path=".runtime.benchmark.parsed.elapsed_ns",
            value=elapsed,
            condition="is present",
        ),
    ]


def bounded_fast_path_evidence(report: JsonObject) -> list[EvidencePoint]:
    source = source_text(report)
    if not source:
        return []

    has_private_limit = (
        re.search(r"\b(?:max|limit)_[A-Za-z0-9_]*\s*=", source) is not None
    )
    has_len_guard = (
        re.search(
            r"\bif\s*\([^)]*\.len\s*(?:>|>=)\s*[A-Za-z_][A-Za-z0-9_]*",
            source,
        )
        is not None
    )
    has_fallback_shape = re.search(r"\b(?:fallback|slow|Slow)\b", source) is not None
    has_null_or_error_escape = (
        re.search(
            r"\breturn\s+(?:null|error\.[A-Za-z_][A-Za-z0-9_]*)\b",
            source,
        )
        is not None
    )

    if not (
        has_private_limit
        and has_len_guard
        and (has_fallback_shape or has_null_or_error_escape)
    ):
        return []

    return [
        EvidencePoint(
            path=".inputs.source",
            value=str_at(report, ("inputs", "source")),
            condition="source has a private size limit plus a guarded fallback path",
        )
    ]


def candidate_scan_evidence(report: JsonObject) -> list[EvidencePoint]:
    source = source_text(report)
    if not source:
        return []

    has_bit_scan = "@ctz" in source or "remaining &= remaining - 1" in source
    has_candidate_loop = (
        re.search(
            r"\bwhile\s*\([^)]*(?:remaining|candidate|mask)[^)]*!=\s*0",
            source,
        )
        is not None
    )
    has_lookup_context = (
        re.search(r"\b(?:lookup|match|rule|policy|control)\b", source) is not None
    )

    if not (has_bit_scan and has_candidate_loop and has_lookup_context):
        return []

    return [
        EvidencePoint(
            path=".inputs.source",
            value=str_at(report, ("inputs", "source")),
            condition="source uses a bitset or candidate scan in lookup-like code",
        )
    ]


def wide_record_by_value_evidence(report: JsonObject) -> list[EvidencePoint]:
    source = source_text(report)
    if not source:
        return []

    has_cold_wide_field = (
        re.search(
            r"\b(?:label|provenance|metadata|payload)\b[^;\n]*\[[0-9_]+\]u8",
            source,
        )
        is not None
    )
    has_by_value_loop = (
        re.search(
            r"\bfor\s*\([^)]*\)\s*\|[A-Za-z_][A-Za-z0-9_]*\|",
            source,
        )
        is not None
    )

    if not (has_cold_wide_field and has_by_value_loop):
        return []

    return [
        EvidencePoint(
            path=".inputs.source",
            value=str_at(report, ("inputs", "source")),
            condition="source has wide cold fields and by-value loop iteration",
        )
    ]


CODEGEN_INSPECT = "codegen.inspect"

NEXT_CHECK_RULES: tuple[NextCheckRule, ...] = (
    NextCheckRule(
        id="hot_allocator",
        category="allocation",
        severity="high",
        confidence="high",
        interpretation="Allocator-related work appears inside the hot boundary.",
        next_checks=(
            (
                "classify whether allocation is output growth, cache growth, "
                "or temporary storage"
            ),
            "measure allocation count inside the same boundary",
            "try caller-owned buffers or a retained workspace for repeated calls",
        ),
        tool_call=ToolCall(
            tool=CODEGEN_INSPECT,
            purpose="inspect allocator fingerprints and source-mapped hot asm lines",
            jq=(
                '.checks[] | select(.key == "allocator_hash_cache")',
                ".calls.summary.allocator // 0",
                ".source_map.entries[]?",
            ),
        ),
        trigger=hot_allocator_evidence,
    ),
    NextCheckRule(
        id="hot_hash_lookup",
        category="lookup",
        severity="high",
        confidence="medium",
        interpretation=(
            "Hash-map or cache-growth fingerprints suggest dynamic lookup in "
            "the measured boundary."
        ),
        next_checks=(
            "identify whether the lookup key set is stable across repeated calls",
            "test a prepared dense plan or indexed table outside the hot loop",
            "compare setup time separately from steady-state execution",
        ),
        tool_call=ToolCall(
            tool=CODEGEN_INSPECT,
            purpose="inspect hash-map call targets and source mapping",
            jq=(
                '.calls.calls[]? | select(.category == "hash_map")',
                '.checks[] | select(.key == "allocator_hash_cache")',
                ".source_map.entries[]?",
            ),
        ),
        trigger=hot_hash_lookup_evidence,
    ),
    NextCheckRule(
        id="copy_in_boundary",
        category="copy",
        severity="medium",
        confidence="high",
        interpretation="Copy helpers survived in the hot boundary.",
        next_checks=(
            (
                "check whether the copy is avoidable output movement or "
                "required semantic movement"
            ),
            "try writing directly into caller-owned output",
            "measure bytes copied per unit if the benchmark can expose it",
        ),
        tool_call=ToolCall(
            tool=CODEGEN_INSPECT,
            purpose="inspect copy helper matches in focused assembly",
            jq=(
                '.checks[] | select(.key == "copy_helpers")',
                '.calls.calls[]? | select(.category == "copy")',
            ),
        ),
        trigger=copy_evidence,
    ),
    NextCheckRule(
        id="diagnostics_in_boundary",
        category="diagnostics",
        severity="medium",
        confidence="high",
        interpretation=(
            "Diagnostics, formatting, tracing, or panic paths appear in the "
            "hot boundary; active formatting can also keep allocator work alive."
        ),
        next_checks=(
            "separate steady-state compute from reporting and validation",
            (
                "use bounded stack or caller-owned buffers for formatting that "
                "must run on active records"
            ),
            "keep trace and report formatting behind an explicit cold path",
            "check whether safety or panic edges are expected for this build mode",
        ),
        tool_call=ToolCall(
            tool=CODEGEN_INSPECT,
            purpose="inspect diagnostic fingerprints and call categories",
            jq=(
                '.checks[] | select(.key == "diagnostics")',
                (
                    '.calls.calls[]? | select(.category == "diagnostic" '
                    'or .category == "panic")'
                ),
            ),
        ),
        trigger=diagnostics_evidence,
    ),
    NextCheckRule(
        id="division_in_hot_boundary",
        category="arithmetic",
        severity="medium",
        confidence="medium",
        interpretation="Division instructions appear in the hot boundary.",
        next_checks=(
            "check whether denominators are invariant and can become reciprocals",
            "separate integer indexing from floating-point math in the measured loop",
            "run a throughput model if division dominates the focused assembly",
        ),
        tool_call=ToolCall(
            tool=CODEGEN_INSPECT,
            purpose="inspect division matches and consider llvm-mca throughput",
            jq=(
                '.checks[] | select(.key == "division")',
                ".artifacts.hot_asm",
            ),
            command_hint="rerun with --llvm-mca when the focused asm is small enough",
        ),
        trigger=division_evidence,
    ),
    NextCheckRule(
        id="unknown_or_indirect_calls",
        category="calls",
        severity="medium",
        confidence="medium",
        interpretation="Unknown or indirect calls remain in the hot boundary.",
        next_checks=(
            (
                "source-map the call addresses and identify whether they are "
                "tiny helpers, dispatch, or real work"
            ),
            (
                "check whether call targets should inline after build flags "
                "and symbol choice are confirmed"
            ),
            (
                "inspect the focused assembly around each call before "
                "changing source shape"
            ),
        ),
        tool_call=ToolCall(
            tool=CODEGEN_INSPECT,
            purpose="inspect unresolved hot-boundary calls",
            jq=(
                (
                    '.calls.calls[]? | select(.category == "unknown" '
                    'or .category == "indirect")'
                ),
                ".source_map.entries[]?",
            ),
        ),
        trigger=unknown_call_evidence,
    ),
    NextCheckRule(
        id="missing_hot_symbol",
        category="symbol",
        severity="high",
        confidence="high",
        interpretation=(
            "The requested hot symbol was not extracted, so codegen checks "
            "may be incomplete."
        ),
        next_checks=(
            "confirm the symbol name with nm output",
            "check whether the function was inlined or stripped",
            (
                "use the nearest public boundary or an address range for "
                "focused inspection"
            ),
        ),
        tool_call=ToolCall(
            tool=CODEGEN_INSPECT,
            purpose="inspect symbol lookup and focused assembly extraction",
            jq=(
                ".symbols.matches[]?",
                ".hot_boundary",
                ".artifacts.symbols",
            ),
        ),
        trigger=missing_symbol_evidence,
    ),
    NextCheckRule(
        id="allocation_report_needed",
        category="measurement",
        severity="medium",
        confidence="high",
        interpretation=(
            "Codegen shows allocator-related work, but no runtime allocation "
            "report was attached."
        ),
        next_checks=(
            "add a counting allocator around exactly the measured boundary",
            "report allocations and allocated bytes per unit",
            "compare allocation counts before and after any storage-shape change",
        ),
        tool_call=ToolCall(
            tool=CODEGEN_INSPECT,
            purpose="attach allocation evidence to the existing codegen signal",
            jq=(
                ".allocation",
                '.checks[] | select(.key == "allocator_hash_cache")',
            ),
            command_hint=(
                "rerun with --alloc-report <path> and optionally --expect-allocs 0"
            ),
        ),
        trigger=allocation_report_needed_evidence,
    ),
    NextCheckRule(
        id="benchmark_signal_missing",
        category="measurement",
        severity="medium",
        confidence="high",
        interpretation="The report has no parsed elapsed_ns for the measured boundary.",
        next_checks=(
            "make the benchmark print elapsed_ns=<integer>",
            "keep setup and steady-state timing separate",
            "normalize timing by item, byte, row, or another stable unit",
        ),
        tool_call=ToolCall(
            tool=CODEGEN_INSPECT,
            purpose="confirm benchmark command and parsed timing field",
            jq=(
                ".runtime.benchmark",
                (
                    '.commands[] | select(.name == "zig-run" '
                    'or .name == "zig-build-bench-step")'
                ),
            ),
        ),
        trigger=benchmark_signal_evidence,
    ),
    NextCheckRule(
        id="bounded_fast_path_cliff",
        category="source-shape",
        severity="high",
        confidence="medium",
        interpretation=(
            "The source appears to use a capped optimized path with a fallback; "
            "that can create a performance cliff outside the benchmark shape."
        ),
        next_checks=(
            "run the same public boundary at the benchmark size and just above the cap",
            "compare against a uniform fast path when the prompt has no such limit",
            "report prepared-state size together with same-boundary timing",
        ),
        tool_call=ToolCall(
            tool=CODEGEN_INSPECT,
            purpose="compare the capped path with the fallback boundary",
            jq=(
                ".inputs.source",
                ".runtime.benchmark.parsed",
                ".decision_card",
            ),
            command_hint=(
                "add a scratch benchmark that exercises the cap and cap-plus-one"
            ),
        ),
        trigger=bounded_fast_path_evidence,
    ),
    NextCheckRule(
        id="candidate_scan_source_probe",
        category="source-shape",
        severity="medium",
        confidence="medium",
        interpretation=(
            "The source appears to use a candidate or bitset scan inside a lookup; "
            "clean codegen for that scan still needs comparison against direct "
            "table lookup or prepared indexes."
        ),
        next_checks=(
            "measure candidate count per item on the benchmark workload",
            "compare a direct decision table or preselected rule-index table",
            "keep ordered semantics tests while comparing the rival shape",
        ),
        tool_call=ToolCall(
            tool=CODEGEN_INSPECT,
            purpose="move from current-symbol inspection to a source-shape comparison",
            jq=(
                ".inputs.source",
                ".checks",
                ".runtime.benchmark.parsed",
            ),
        ),
        trigger=candidate_scan_evidence,
    ),
    NextCheckRule(
        id="wide_record_by_value",
        category="source-shape",
        severity="medium",
        confidence="medium",
        interpretation=(
            "The source appears to iterate records by value while the record "
            "contains wide cold fields such as labels, provenance, metadata, "
            "or payload."
        ),
        next_checks=(
            "switch the hot loop to pointer or index iteration",
            "keep cold fields out of the measured data path when possible",
            "rerun the same-boundary benchmark and checksum after the change",
        ),
        tool_call=ToolCall(
            tool=CODEGEN_INSPECT,
            purpose="check for large per-item copies in the hot source path",
            jq=(
                ".inputs.source",
                ".runtime.benchmark.parsed",
                ".decision_card",
            ),
        ),
        trigger=wide_record_by_value_evidence,
    ),
    NextCheckRule(
        id="clean_hot_boundary_ceiling_probe",
        category="ceiling",
        severity="low",
        confidence="medium",
        interpretation=(
            "Focused compiler output is clean for the current symbol; the next "
            "useful question is likely a source-level data, control, or "
            "algorithm comparison."
        ),
        next_checks=(
            "compare before and after with the same benchmark workload",
            (
                "look for a stronger source hypothesis: prepared controls, "
                "direct decision tables, fused passes, field grouping, "
                "or workspace reuse"
            ),
            (
                "when the simple source shape is already optimal for the "
                "contract, report that ceiling instead of adding scaffolding"
            ),
        ),
        tool_call=ToolCall(
            tool=CODEGEN_INSPECT,
            purpose=(
                "decide whether more low-level inspection or a higher-level "
                "comparison is useful"
            ),
            jq=(
                ".runtime.benchmark.parsed",
                ".checks",
                ".calls.summary",
            ),
        ),
        trigger=clean_hot_boundary_ceiling_evidence,
    ),
    NextCheckRule(
        id="llvm_mca_candidate",
        category="throughput",
        severity="low",
        confidence="medium",
        interpretation=(
            "Focused assembly has calls or divisions and can benefit from a "
            "throughput model."
        ),
        next_checks=(
            "run llvm-mca on the focused assembly when the host tool is available",
            "compare predicted throughput with measured cycles per unit",
            (
                "use the result to distinguish arithmetic throughput from "
                "memory or call overhead"
            ),
        ),
        tool_call=ToolCall(
            tool=CODEGEN_INSPECT,
            purpose="request an optional static throughput model",
            jq=(
                ".llvm_mca",
                '.checks[] | select(.key == "division")',
                ".calls.summary",
            ),
            command_hint="rerun with --llvm-mca",
        ),
        trigger=llvm_mca_candidate_evidence,
    ),
)


def build_next_checks(report: JsonObject) -> JsonObject:
    suggestions = [
        suggestion
        for rule in NEXT_CHECK_RULES
        if (suggestion := rule.evaluate(report)) is not None
    ]
    return {
        "schema_version": 1,
        "rules_evaluated": len(NEXT_CHECK_RULES),
        "suggestions": suggestions,
    }
