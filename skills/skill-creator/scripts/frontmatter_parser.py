#!/usr/bin/env python3

from __future__ import annotations

from typing import Any
import re

FRONTMATTER_RE = re.compile(r"\A---\s*\n(.*?)\n---\s*(?:\n|$)", re.DOTALL)
KEY_VALUE_RE = re.compile(r"^([A-Za-z0-9_-]+)\s*:\s*(.*)$")


def _leading_spaces(line: str) -> int:
    return len(line) - len(line.lstrip(" "))


def _strip_inline_comment(value: str) -> str:
    quote: str | None = None
    escaped = False
    for idx, char in enumerate(value):
        if escaped:
            escaped = False
            continue
        if char == "\\":
            escaped = True
            continue
        if quote:
            if char == quote:
                quote = None
            continue
        if char in ("'", '"'):
            quote = char
            continue
        if char == "#":
            return value[:idx].rstrip()
    return value.rstrip()


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        inner = value[1:-1]
        if value[0] == '"':
            inner = inner.replace(r"\"", '"').replace(r"\\", "\\")
        elif value[0] == "'":
            inner = inner.replace("\\'", "'").replace(r"\\", "\\")
        return inner
    return value


def _split_inline_items(value: str) -> list[str]:
    items: list[str] = []
    chunk: list[str] = []
    quote: str | None = None
    escaped = False
    depth = 0

    for char in value:
        if escaped:
            chunk.append(char)
            escaped = False
            continue
        if char == "\\" and quote:
            chunk.append(char)
            escaped = True
            continue
        if quote:
            chunk.append(char)
            if char == quote:
                quote = None
            continue
        if char in ("'", '"'):
            quote = char
            chunk.append(char)
            continue
        if char in "[{(":
            depth += 1
            chunk.append(char)
            continue
        if char in "]})":
            if depth > 0:
                depth -= 1
            chunk.append(char)
            continue
        if char == "," and depth == 0:
            items.append("".join(chunk).strip())
            chunk = []
            continue
        chunk.append(char)

    items.append("".join(chunk).strip())
    return [item for item in items if item]


def parse_scalar(value: str) -> Any:
    value = _strip_inline_comment(value).strip()
    if not value:
        return ""

    if value.startswith("[") and value.endswith("]"):
        inner = value[1:-1].strip()
        if not inner:
            return []
        return [parse_scalar(item) for item in _split_inline_items(inner)]

    lowered = value.lower()
    if lowered == "true":
        return True
    if lowered == "false":
        return False
    if lowered in {"null", "none", "~"}:
        return None
    if re.fullmatch(r"-?\d+", value):
        try:
            return int(value)
        except ValueError:
            pass

    return _unquote(value)


def _dedent_lines(lines: list[str]) -> list[str]:
    non_empty = [line for line in lines if line.strip()]
    if not non_empty:
        return []
    min_indent = min(_leading_spaces(line) for line in non_empty)
    if min_indent <= 0:
        return lines
    return [line[min_indent:] if len(line) >= min_indent else "" for line in lines]


def _parse_subblock(lines: list[str]) -> Any:
    dedented = _dedent_lines(lines)
    content_lines = [line for line in dedented if line.strip() and not line.lstrip().startswith("#")]
    if not content_lines:
        return None
    first = content_lines[0].lstrip()
    if first.startswith("- "):
        return _parse_list_block(dedented)
    return _parse_mapping_block(dedented)


def _parse_list_block(lines: list[str]) -> list[Any]:
    items: list[Any] = []
    idx = 0
    while idx < len(lines):
        line = lines[idx]
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            idx += 1
            continue
        if _leading_spaces(line) != 0 or not line.startswith("- "):
            idx += 1
            continue

        raw_value = line[2:].strip()
        idx += 1

        child_lines: list[str] = []
        while idx < len(lines):
            next_line = lines[idx]
            next_stripped = next_line.strip()
            if not next_stripped:
                child_lines.append(next_line)
                idx += 1
                continue
            if _leading_spaces(next_line) == 0 and next_line.startswith("- "):
                break
            child_lines.append(next_line)
            idx += 1

        if raw_value:
            items.append(parse_scalar(raw_value))
            continue

        items.append(_parse_subblock(child_lines))

    return items


def _parse_mapping_block(lines: list[str]) -> dict[str, Any]:
    output: dict[str, Any] = {}
    idx = 0
    while idx < len(lines):
        line = lines[idx]
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            idx += 1
            continue
        if _leading_spaces(line) != 0:
            idx += 1
            continue

        match = KEY_VALUE_RE.match(line)
        if not match:
            idx += 1
            continue

        key = match.group(1).strip()
        raw_value = match.group(2).strip()
        idx += 1

        child_lines: list[str] = []
        while idx < len(lines):
            next_line = lines[idx]
            next_stripped = next_line.strip()
            if not next_stripped:
                child_lines.append(next_line)
                idx += 1
                continue
            if _leading_spaces(next_line) == 0 and KEY_VALUE_RE.match(next_line):
                break
            child_lines.append(next_line)
            idx += 1

        if raw_value:
            output[key] = parse_scalar(raw_value)
            continue

        output[key] = _parse_subblock(child_lines) if child_lines else None

    return output


def parse_frontmatter_text(text: str) -> dict[str, Any]:
    if not text.startswith("---"):
        return {}

    match = FRONTMATTER_RE.match(text)
    if not match:
        return {}

    payload = match.group(1)
    parsed = _parse_mapping_block(payload.splitlines())
    if not isinstance(parsed, dict):
        return {}
    return parsed


def parse_frontmatter_metadata(text: str, fallback_keys: set[str] | list[str] | tuple[str, ...] | None = None) -> dict[str, Any]:
    frontmatter_obj = parse_frontmatter_text(text)
    metadata = frontmatter_obj.get("metadata")
    if isinstance(metadata, dict):
        return metadata

    if not fallback_keys:
        return {}

    return {
        key: value
        for key, value in frontmatter_obj.items()
        if key in set(fallback_keys)
    }


def normalize_path(skill_name: str, ref_path: str) -> str:
    ref_path = ref_path.strip().strip("`")
    if ref_path.startswith("skills/"):
        return ref_path
    if ref_path.startswith("./"):
        ref_path = ref_path[2:]
    return f"skills/{skill_name}/{ref_path}"
