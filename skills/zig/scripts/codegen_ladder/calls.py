from __future__ import annotations

import re
from pathlib import Path

from .asm import extract_address
from .common import read_text
from .types import JsonArray, JsonObject

CALL_RE = re.compile(r"\b(callq?|bl|blr)\b\s*([^#;\n]*)")
CALL_CATEGORIES: list[tuple[str, str]] = [
    ("hash_map", r"ensuretotalcapacity|growifneeded|hashmap|hash_map"),
    (
        "allocator",
        r"allocator|malloc|alloc|free|page_allocator|smpallocator|generalpurposeallocator",
    ),
    ("copy", r"memcpy|memmove|copyforwards|copybackwards"),
    ("diagnostic", r"print|format|json|trace|zone"),
    ("math", r"\b(exp|log|pow|sin|cos|tan|sqrt)\b"),
]
INDIRECT_TARGETS = {"", "x0", "x1", "x2", "x3", "rax", "rbx", "rcx", "rdx"}


def call_target_from_line(line: str) -> tuple[str, str] | None:
    match = CALL_RE.search(line)
    if not match:
        return None
    instruction = match.group(1)
    target = match.group(2).strip()
    angle = re.search(r"<([^>]+)>", target)
    if angle:
        target = angle.group(1)
    target = target.split()[0] if target.split() else target
    return instruction, target


def classify_call(target: str, line: str) -> str:
    haystack = f"{target} {line}".lower()
    if "panic" in haystack:
        return "panic"
    if target in INDIRECT_TARGETS:
        return "indirect"
    for category, pattern in CALL_CATEGORIES:
        if re.search(pattern, haystack):
            return category
    return "unknown"


def parse_calls(hot_asm_path: Path, max_matches: int) -> JsonObject:
    calls: JsonArray = []
    summary: dict[str, int] = {}
    total = 0
    for line_no, line in enumerate(read_text(hot_asm_path).splitlines(), start=1):
        parsed = call_target_from_line(line)
        if not parsed:
            continue
        total += 1
        instruction, target = parsed
        category = classify_call(target, line)
        summary[category] = summary.get(category, 0) + 1
        if len(calls) < max_matches:
            calls.append(
                {
                    "line": line_no,
                    "address": extract_address(line),
                    "instruction": instruction,
                    "target": target,
                    "category": category,
                    "text": line,
                }
            )
    return {
        "count": total,
        "summary": dict(sorted(summary.items())),
        "calls": calls,
    }
