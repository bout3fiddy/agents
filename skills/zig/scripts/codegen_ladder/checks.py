from __future__ import annotations

import re
from pathlib import Path

from .asm import extract_address
from .common import read_text
from .types import JsonArray

CHECK_PATTERNS: list[tuple[str, str, str]] = [
    (
        "allocator_hash_cache",
        "allocator/hash/cache growth fingerprints",
        r"SmpAllocator|PageAllocator|GeneralPurposeAllocator|malloc|alloc|free|HashMap|hash_map|ensureTotalCapacity|growIfNeeded",
    ),
    ("copy_helpers", "copy helper calls", r"memcpy|memmove|copyForwards|copyBackwards"),
    (
        "diagnostics",
        "diagnostic/format/tracing fingerprints",
        r"print|format|json|trace|zone|panic",
    ),
    ("division", "division instructions", r"\b(idiv|div|sdiv|udiv|fdiv)\b"),
]


def collect_matches(
    path: Path, pattern: str, max_matches: int
) -> tuple[int, JsonArray]:
    regex = re.compile(pattern)
    total = 0
    matches: JsonArray = []
    for line_no, line in enumerate(read_text(path).splitlines(), start=1):
        if not regex.search(line):
            continue
        total += 1
        if len(matches) < max_matches:
            matches.append(
                {
                    "line": line_no,
                    "address": extract_address(line),
                    "text": line,
                }
            )
    return total, matches


def build_checks(hot_asm_path: Path, hot_found: bool, max_matches: int) -> JsonArray:
    checks: JsonArray = []
    for key, label, pattern in CHECK_PATTERNS:
        if not hot_found:
            checks.append(
                {
                    "key": key,
                    "name": label,
                    "status": "skip",
                    "count": 0,
                    "matches": [],
                }
            )
            continue
        count, matches = collect_matches(hot_asm_path, pattern, max_matches)
        checks.append(
            {
                "key": key,
                "name": label,
                "status": "pass" if count == 0 else "review",
                "count": count,
                "matches": matches,
            }
        )
    return checks
