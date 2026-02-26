#!/usr/bin/env python3

import re
import sys
from dataclasses import dataclass
from pathlib import Path

START_MARKER = "<!-- AGENTS_SKILLS_INDEX_START -->"
END_MARKER = "<!-- AGENTS_SKILLS_INDEX_END -->"
INDEX_HEADER = "AUTO-GENERATED SKILLS INDEX. SOURCE: skills/*/SKILL.md + skills/*/references/*.md"
DESCRIPTION_KEYS = ("description", "summary", "impactDescription")


@dataclass
class Result:
    kind: str
    path: str
    detail: str
    fix: str


def add_result(target: list[Result], kind: str, path: str, detail: str, fix: str) -> None:
    target.append(Result(kind=kind, path=path, detail=detail, fix=fix))


def parse_frontmatter(text: str) -> dict[str, str]:
    if not text.startswith("---"):
        return {}
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}

    data: dict[str, str] = {}
    for line in parts[1].splitlines():
        line = line.strip()
        if not line or line.startswith("#") or ":" not in line:
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
    in_code = False
    paragraph: list[str] = []

    for line in text.splitlines():
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


def scan_skills(
    root: Path,
) -> tuple[list[str], list[str], list[str], int, int, list[Result], list[Result]]:
    skill_entries: list[str] = []
    trigger_entries: list[str] = []
    ref_entries: list[str] = []
    errors: list[Result] = []
    warnings: list[Result] = []

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
            add_result(
                errors,
                "skill",
                f"skills/{skill_path.name}/SKILL.md",
                "Missing frontmatter name.",
                "Add name: <skill-name> to frontmatter.",
            )
        if not desc:
            add_result(
                errors,
                "skill",
                f"skills/{skill_path.name}/SKILL.md",
                "Missing frontmatter description.",
                "Add description: ... to frontmatter.",
            )

        skill_entries.append(
            f"skill|{sanitize(name)}|{sanitize(desc)}|skills/{skill_path.name}/SKILL.md"
        )

        for trigger, ref in parse_triggers(text):
            trigger_count += 1
            norm_path = normalize_ref_path(skill_path.name, ref)
            if not (root / norm_path).exists():
                add_result(
                    errors,
                    "trigger",
                    norm_path,
                    f"Missing referenced file for trigger '{trigger}'.",
                    "Fix trigger path or add the referenced file.",
                )
            trigger_entries.append(
                f"trigger|{sanitize(name)}|{sanitize(trigger)}|{norm_path}"
            )

        refs_dir = skill_path / "references"
        if not refs_dir.is_dir():
            continue

        for index_file in sorted(refs_dir.rglob("index.md")):
            index_text = index_file.read_text(encoding="utf-8", errors="ignore")
            for ref_path, desc_text in parse_reference_index(index_text):
                normalized = normalize_ref_path(skill_path.name, ref_path)
                index_listed_paths.add(normalized)

                if not desc_text:
                    index_desc_missing[normalized] = str(index_file.relative_to(root))
                else:
                    desc_text = normalize_text(desc_text)
                    existing_desc = index_desc_by_path.get(normalized)
                    if existing_desc and existing_desc != desc_text:
                        add_result(
                            warnings,
                            "index",
                            normalized,
                            "Conflicting descriptions in index files.",
                            "Consolidate to a single description.",
                        )
                    index_desc_by_path[normalized] = desc_text

                if not (root / normalized).exists():
                    add_result(
                        errors,
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
                add_result(
                    warnings,
                    "ref",
                    rel,
                    "Missing title heading; using filename as title.",
                    "Add a # Heading or frontmatter title.",
                )

            if ref_file.name != "index.md" and rel not in index_listed_paths:
                add_result(
                    warnings,
                    "index",
                    rel,
                    "Reference not listed in any index.md.",
                    "Add it to the nearest references index.",
                )

            if rel in index_desc_missing:
                add_result(
                    warnings,
                    "index",
                    rel,
                    f"Index entry missing description in {index_desc_missing[rel]}.",
                    "Add a short description after the path in the index.",
                )

            desc = index_desc_by_path.get(rel)
            if not desc:
                for key in DESCRIPTION_KEYS:
                    field = ref_fm.get(key)
                    if field:
                        desc = normalize_text(field)
                        break

            if not desc:
                paragraph = normalize_text(first_paragraph(ref_text))
                if paragraph:
                    desc = paragraph
                    if ref_file.name != "index.md":
                        add_result(
                            warnings,
                            "ref",
                            rel,
                            "Missing curated description; using first paragraph.",
                            "Add description/summary frontmatter or index description.",
                        )

            if not desc:
                add_result(
                    errors,
                    "ref",
                    rel,
                    "Missing description.",
                    "Add description/summary frontmatter or index description.",
                )
                desc = ""

            ref_entries.append(
                f"ref|{sanitize(name)}|{rel}|{sanitize(title)}|{sanitize(desc)}"
            )

    return (
        skill_entries,
        trigger_entries,
        ref_entries,
        trigger_count,
        ref_count,
        errors,
        warnings,
    )


def build_index(root: Path, instructions_path: Path) -> tuple[int, int, int, bool, list[Result], list[Result]]:
    if not instructions_path.exists():
        raise SystemExit(f"Missing instructions file: {instructions_path}")

    content = instructions_path.read_text(encoding="utf-8")
    if START_MARKER not in content or END_MARKER not in content:
        raise SystemExit("Skills index markers missing in instructions/global.md")

    (
        skill_entries,
        trigger_entries,
        ref_entries,
        trigger_count,
        ref_count,
        errors,
        warnings,
    ) = scan_skills(root)

    lines = [
        INDEX_HEADER,
        *sorted(skill_entries),
        *sorted(trigger_entries),
        *sorted(ref_entries),
    ]
    index_text = "\n".join(lines)

    start_index = content.index(START_MARKER) + len(START_MARKER)
    end_index = content.index(END_MARKER)
    new_block = f"\n{index_text}\n"
    existing_block = content[start_index:end_index]

    updated = False
    if existing_block != new_block:
        updated = True
        updated_content = content[:start_index] + new_block + content[end_index:]
        instructions_path.write_text(updated_content, encoding="utf-8")

    return len(skill_entries), trigger_count, ref_count, updated, errors, warnings


def print_results(
    skills_count: int,
    trigger_count: int,
    ref_count: int,
    updated: bool,
    errors: list[Result],
    warnings: list[Result],
    instructions_path: Path,
) -> None:
    status = "FAIL" if errors else "OK"
    print(f"Skills index audit: {status}")
    print(
        "Skills: {skills} | Triggers: {triggers} | References: {refs} | Errors: {errors} | Warnings: {warnings}".format(
            skills=skills_count,
            triggers=trigger_count,
            refs=ref_count,
            errors=len(errors),
            warnings=len(warnings),
        )
    )

    if errors:
        print("Errors:")
        for row in errors:
            print(f" - [{row.kind}] {row.path} :: {row.detail} | Fix: {row.fix}")

    if warnings:
        print("Warnings:")
        for row in warnings:
            print(f" - [{row.kind}] {row.path} :: {row.detail} | Fix: {row.fix}")

    if updated:
        print(f"Updated skills index in {instructions_path}")
    else:
        print(f"Skills index unchanged in {instructions_path}")


def main() -> int:
    root = Path(__file__).resolve().parents[3]
    instructions_path = root / "instructions" / "global.md"

    skills_count, trigger_count, ref_count, updated, errors, warnings = build_index(
        root=root,
        instructions_path=instructions_path,
    )

    print_results(
        skills_count=skills_count,
        trigger_count=trigger_count,
        ref_count=ref_count,
        updated=updated,
        errors=errors,
        warnings=warnings,
        instructions_path=instructions_path,
    )

    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
