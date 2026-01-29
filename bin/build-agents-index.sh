#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_DIR="${AGENTS_DIR:-$ROOT_DIR}"
INSTRUCTIONS_FILE="$ROOT_DIR/instructions/global.md"

export PRETTY_FORCE_COLOR=1
source "$ROOT_DIR/bin/lib/pretty.sh"
pretty_init_colors

tmp_file="$(mktemp)"
status=0
trap 'rm -f "$tmp_file"' EXIT

set +e
python3 - <<'PY' "$ROOT_DIR" "$INSTRUCTIONS_FILE" >"$tmp_file"
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
instructions_path = Path(sys.argv[2])

start_marker = "<!-- AGENTS_SKILLS_INDEX_START -->"
end_marker = "<!-- AGENTS_SKILLS_INDEX_END -->"

if not instructions_path.exists():
    raise SystemExit(f"Missing instructions file: {instructions_path}")

content = instructions_path.read_text(encoding="utf-8")
if start_marker not in content or end_marker not in content:
    raise SystemExit("Skills index markers missing in instructions/global.md")

def parse_frontmatter(text: str) -> dict:
    if not text.startswith("---"):
        return {}
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}
    data: dict[str, str] = {}
    for line in parts[1].splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        if ":" not in line:
            continue
        key, value = line.split(":", 1)
        data[key.strip()] = value.strip().strip("'\"")
    return data

def strip_frontmatter(text: str) -> str:
    if not text.startswith("---"):
        return text
    parts = text.split("---", 2)
    return parts[2] if len(parts) >= 3 else text

def first_heading(text: str) -> str:
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#"):
            return line.lstrip("#").strip()
    return ""

def first_paragraph(text: str) -> str:
    text = strip_frontmatter(text)
    lines = text.splitlines()
    in_code = False
    paragraph: list[str] = []
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("```"):
            in_code = not in_code
            continue
        if in_code:
            continue
        if stripped.startswith("#"):
            if paragraph:
                break
            continue
        if not stripped:
            if paragraph:
                break
            continue
        if stripped.startswith("- "):
            if paragraph:
                break
            continue
        paragraph.append(stripped)
    return " ".join(paragraph)

def normalize_text(value: str, max_len: int = 220) -> str:
    value = re.sub(r"\s+", " ", value or "").strip()
    if len(value) > max_len:
        return value[: max_len - 3].rstrip() + "..."
    return value

def sanitize(value: str) -> str:
    return normalize_text(value).replace("|", "/").strip()

def normalize_ref_path(skill_name: str, ref: str) -> str:
    ref = ref.strip().strip("`")
    if ref.startswith("skills/"):
        return ref
    if ref.startswith("./"):
        ref = ref[2:]
    if ref.startswith("references/"):
        return f"skills/{skill_name}/{ref}"
    return f"skills/{skill_name}/{ref}"

def parse_triggers(text: str) -> list[tuple[str, str]]:
    triggers: list[tuple[str, str]] = []
    in_section = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            header = stripped[3:].strip().lower()
            in_section = header.startswith("reference triggers")
            continue
        if in_section and stripped.startswith("- "):
            match = re.match(r"-\s*(.*?)\s*->\s*`([^`]+)`", stripped)
            if match:
                triggers.append((match.group(1).strip(), match.group(2).strip()))
        elif in_section and stripped.startswith("## "):
            in_section = False
    return triggers

def parse_reference_index(text: str) -> list[tuple[str, str]]:
    items: list[tuple[str, str]] = []
    in_section = False
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("## "):
            header = stripped[3:].strip().lower()
            in_section = header == "references"
            continue
        if not in_section or not stripped.startswith("- "):
            continue
        match = re.match(r"-\s*`([^`]+)`\s*(?:[-—–:]\s*(.+))?$", stripped)
        if match:
            path = match.group(1).strip()
            desc = (match.group(2) or "").strip()
            items.append((path, desc))
    return items

skill_entries: list[str] = []
trigger_entries: list[str] = []
ref_entries: list[str] = []

errors: list[list[str]] = []
warnings: list[list[str]] = []

def add_error(kind: str, path: str, detail: str, fix: str) -> None:
    errors.append([kind, path, detail, fix])

def add_warning(kind: str, path: str, detail: str, fix: str) -> None:
    warnings.append([kind, path, detail, fix])

index_desc_by_path: dict[str, str] = {}
index_desc_missing: dict[str, str] = {}
index_listed_paths: set[str] = set()
trigger_count = 0
ref_count = 0

skills_dir = root / "skills"
for skill_path in sorted(skills_dir.iterdir()):
    if not skill_path.is_dir():
        continue
    skill_file = skill_path / "SKILL.md"
    if not skill_file.exists():
        continue
    text = skill_file.read_text(encoding="utf-8")
    fm = parse_frontmatter(text)
    name = fm.get("name") or skill_path.name
    desc = fm.get("description", "")
    if not fm.get("name"):
        add_error(
            "skill",
            f"skills/{skill_path.name}/SKILL.md",
            "Missing frontmatter name.",
            "Add name: <skill-name> to frontmatter.",
        )
    if not desc:
        add_error(
            "skill",
            f"skills/{skill_path.name}/SKILL.md",
            "Missing frontmatter description.",
            "Add description: ... to frontmatter.",
        )
    desc = sanitize(desc)
    skill_entries.append(
        f"skill|{sanitize(name)}|{desc}|skills/{skill_path.name}/SKILL.md"
    )

    for trigger, ref in parse_triggers(text):
        trigger_count += 1
        norm_path = normalize_ref_path(skill_path.name, ref)
        if not (root / norm_path).exists():
            add_error(
                "trigger",
                norm_path,
                f"Missing referenced file for trigger '{trigger}'.",
                "Fix trigger path or add the referenced file.",
            )
        trigger_entries.append(
            f"trigger|{sanitize(name)}|{sanitize(trigger)}|{norm_path}"
        )

    refs_dir = skill_path / "references"
    if refs_dir.is_dir():
        for index_file in sorted(refs_dir.rglob("index.md")):
            index_text = index_file.read_text(encoding="utf-8", errors="ignore")
            for ref_path, desc_text in parse_reference_index(index_text):
                normalized = normalize_ref_path(skill_path.name, ref_path)
                index_listed_paths.add(normalized)
                if not desc_text:
                    index_desc_missing[normalized] = str(index_file.relative_to(root))
                else:
                    desc_text = normalize_text(desc_text)
                    if normalized in index_desc_by_path and index_desc_by_path[normalized] != desc_text:
                        add_warning(
                            "index",
                            normalized,
                            "Conflicting descriptions in index files.",
                            "Consolidate to a single description.",
                        )
                    index_desc_by_path[normalized] = desc_text
                if not (root / normalized).exists():
                    add_error(
                        "index",
                        normalized,
                        "Reference listed in index but file is missing.",
                        "Fix the path or add the file.",
                    )

        for ref_file in sorted(refs_dir.rglob("*.md")):
            ref_count += 1
            rel = ref_file.relative_to(root).as_posix()
            ref_text = ref_file.read_text(encoding="utf-8", errors="ignore")
            ref_fm = parse_frontmatter(ref_text)
            title = ref_fm.get("title") or first_heading(ref_text)
            if not title:
                title = ref_file.stem.replace("-", " ")
                add_warning(
                    "ref",
                    rel,
                    "Missing title heading; using filename as title.",
                    "Add a # Heading or frontmatter title.",
                )

            if ref_file.name != "index.md" and rel not in index_listed_paths:
                add_warning(
                    "index",
                    rel,
                    "Reference not listed in any index.md.",
                    "Add it to the nearest references index.",
                )
            if rel in index_desc_missing:
                add_warning(
                    "index",
                    rel,
                    f"Index entry missing description in {index_desc_missing[rel]}.",
                    "Add a short description after the path in the index.",
                )

            desc = index_desc_by_path.get(rel)
            if not desc:
                for key in ("description", "summary", "impactDescription"):
                    if ref_fm.get(key):
                        desc = normalize_text(ref_fm.get(key, ""))
                        break
            if not desc:
                paragraph = normalize_text(first_paragraph(ref_text))
                if paragraph:
                    desc = paragraph
                    if ref_file.name != "index.md":
                        add_warning(
                            "ref",
                            rel,
                            "Missing curated description; using first paragraph.",
                            "Add description/summary frontmatter or index description.",
                        )
            if not desc:
                add_error(
                    "ref",
                    rel,
                    "Missing description.",
                    "Add description/summary frontmatter or index description.",
                )
                desc = ""

            ref_entries.append(
                f"ref|{sanitize(name)}|{rel}|{sanitize(title)}|{sanitize(desc)}"
            )

lines = [
    "AUTO-GENERATED SKILLS INDEX. SOURCE: skills/*/SKILL.md + skills/*/references/*.md",
    *sorted(skill_entries),
    *sorted(trigger_entries),
    *sorted(ref_entries),
]

index_text = "\n".join(lines)

start_index = content.index(start_marker) + len(start_marker)
end_index = content.index(end_marker)
existing_block = content[start_index:end_index]
new_block = f"\n{index_text}\n"

updated = False
if existing_block != new_block:
    updated = True
    content = content[:start_index] + new_block + content[end_index:]
    instructions_path.write_text(content, encoding="utf-8")

print(f"SUMMARY\t{len(skill_entries)}\t{trigger_count}\t{ref_count}\t{len(errors)}\t{len(warnings)}\t{'updated' if updated else 'unchanged'}")
for row in errors:
    print("ERROR\t" + "\t".join(row))
for row in warnings:
    print("WARN\t" + "\t".join(row))

if errors:
    raise SystemExit(1)
PY
status=$?
set -e

summary_line="$(grep '^SUMMARY\t' "$tmp_file" | head -1)"
IFS=$'\t' read -r _ skills triggers refs errors warnings updated <<<"$summary_line"

status_label="OK"
status_color="$PRETTY_GREEN"
if [[ "${errors:-0}" -gt 0 ]]; then
  status_label="FAIL"
  status_color="$PRETTY_RED"
fi

printf "%bSkills index audit:%b %b%s%b\n" "$PRETTY_BOLD" "$PRETTY_RESET" "$status_color" "$status_label" "$PRETTY_RESET"
printf "Skills: %s | Triggers: %s | References: %s | Errors: %s | Warnings: %s\n" \
  "$skills" "$triggers" "$refs" "$errors" "$warnings"

pretty_print_table "Errors" "ERROR" "$tmp_file"
pretty_print_table "Warnings" "WARN" "$tmp_file"

if [[ "$updated" == "updated" ]]; then
  printf "%bUpdated skills index in %s%b\n" "$PRETTY_CYAN" "$INSTRUCTIONS_FILE" "$PRETTY_RESET"
else
  printf "%bSkills index unchanged in %s%b\n" "$PRETTY_CYAN" "$INSTRUCTIONS_FILE" "$PRETTY_RESET"
fi

rm -f "$tmp_file"
exit "$status"
