from __future__ import annotations

import re
from pathlib import Path

from .common import read_text, write_text
from .types import JsonArray, JsonObject

ADDRESS_RE = re.compile(r"^\s*([0-9a-fA-F]+):")
OBJDUMP_SYMBOL_RE = re.compile(r"^[0-9a-fA-F]+\s+<.*>:")
ASM_SYMBOL_RE = re.compile(r"^_?[A-Za-z0-9_.$]+:$")


def parse_nm_symbols(symbols_path: Path, symbol_query: str) -> JsonObject:
    matches: JsonArray = []
    query_lower = symbol_query.lower()
    for line in read_text(symbols_path).splitlines():
        if query_lower not in line.lower():
            continue
        fields = line.split()
        address = (
            fields[0] if fields and re.fullmatch(r"[0-9A-Fa-f]+", fields[0]) else None
        )
        name = fields[-1] if fields else line
        kind = fields[1] if len(fields) > 1 else None
        matches.append(
            {
                "address": address,
                "kind": kind,
                "name": name,
                "raw": line,
            }
        )
    return {
        "found": len(matches) > 0,
        "matches": matches,
    }


def is_objdump_symbol_line(line: str) -> bool:
    return bool(OBJDUMP_SYMBOL_RE.search(line))


def is_asm_symbol_line(line: str) -> bool:
    return bool(ASM_SYMBOL_RE.search(line.strip()))


def extract_objdump_symbol(lines: list[str], symbol_query: str) -> list[str]:
    extracted: list[str] = []
    started = False
    for line in lines:
        if is_objdump_symbol_line(line) and symbol_query in line:
            started = True
        if not started:
            continue
        if extracted and is_objdump_symbol_line(line) and symbol_query not in line:
            break
        extracted.append(line)
    return extracted


def extract_emitted_symbol(lines: list[str], symbol_query: str) -> list[str]:
    extracted: list[str] = []
    started = False
    seen_end = False
    for line in lines:
        if is_asm_symbol_line(line) and symbol_query in line:
            started = True
        if not started:
            continue
        extracted.append(line)
        if re.match(r"^\s*\.cfi_endproc", line):
            seen_end = True
        elif seen_end and line.strip() == "":
            break
    return extracted


def focused_asm_lines(
    symbol_query: str, full_asm_path: Path, emitted_asm_path: Path
) -> tuple[str, list[str]]:
    disassembly = extract_objdump_symbol(
        read_text(full_asm_path).splitlines(), symbol_query
    )
    if disassembly:
        return "disassembly", disassembly
    emitted = extract_emitted_symbol(
        read_text(emitted_asm_path).splitlines(), symbol_query
    )
    if emitted:
        return "emitted_assembly", emitted
    return "none", []


def extract_hot_asm(
    *,
    symbol_query: str,
    full_asm_path: Path,
    emitted_asm_path: Path,
    hot_asm_path: Path,
) -> JsonObject:
    source, lines = focused_asm_lines(symbol_query, full_asm_path, emitted_asm_path)
    write_text(hot_asm_path, "\n".join(lines) + ("\n" if lines else ""))
    return {
        "symbol_found": bool(lines),
        "extraction": source,
        "lines": len(lines),
    }


def extract_address(text: str) -> str | None:
    match = ADDRESS_RE.search(text)
    if match:
        return f"0x{match.group(1)}"
    match = re.match(r"^\s*([0-9a-fA-F]+)\s+<", text)
    if match:
        return f"0x{match.group(1)}"
    return None
