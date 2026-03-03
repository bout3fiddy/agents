#!/usr/bin/env python3

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from frontmatter_parser import parse_frontmatter_metadata, normalize_path

SCHEMA_VERSION = "1"
MAX_PRIMARY_REFS = 8
ACTIVATION_POLICIES = {"user_intent", "workflow_state", "both"}
DEFAULT_PRIORITY = 50
DEFAULT_LOAD_STRATEGY = "progressive"
TRIGGER_RE = r"`([^`]+)`"
TRIGGER_PATTERN = __import__("re").compile(TRIGGER_RE)
TRIGGER_REF_RE = __import__("re").compile(r"-\s*.*?->\s*`([^`]+)`")
DIRECT_REF_RE = __import__("re").compile(r"-\s*`([^`]+)`")

FALLBACK_SKILL_PRIORITIES = {
    "coding": 80,
    "design": 70,
    "housekeeping": 65,
}

FALLBACK_SKILL_TASK_TYPES = {
    "coding": ["implementation", "refactor", "bugfix", "technical-guidance", "coding"],
    "design": ["design", "ui-review", "animation", "dialkit"],
    "housekeeping": ["agents-architecture", "migration", "repo-housekeeping", "housekeeping"],
}

FALLBACK_SKILL_WORKFLOW_TRIGGERS = {
    "coding": ["implementation_request_detected", "refactor_request_detected", "bugfix_request_detected"],
    "design": ["design_request_detected", "ui_critique_requested", "animation_request_detected", "dialkit_request_detected"],
    "housekeeping": ["agents_architecture_requested", "legacy_migration_requested", "docs_housekeeping_requested"],
}

FALLBACK_REF_WORKFLOW_TRIGGERS = {
    "coding.ref.index": ["implementation_request_detected", "refactor_request_detected", "bugfix_request_detected"],
    "design.ref.index": ["design_request_detected"],
    "housekeeping.ref.index": ["agents_architecture_requested", "docs_housekeeping_requested", "legacy_migration_requested"],
}


@dataclass(frozen=True)
class RefNode:
    id: str
    path: str
    task_types: list[str]
    priority: int
    load_strategy: str
    route_exclude: bool
    activation_policy: str
    workflow_triggers: list[str]


@dataclass(frozen=True)
class SkillNode:
    id: str
    path: str
    task_types: list[str]
    priority: int
    load_strategy: str
    activation_policy: str
    workflow_triggers: list[str]
    primary_refs: list[str]


def normalize_identifier_segment(value: str) -> str:
    import re

    lowered = value.lower().strip()
    normalized = re.sub(r"[^a-z0-9-]+", "-", lowered)
    normalized = normalized.strip("-")
    return normalized or "item"


def normalize_skill_id(value: str) -> str:
    import re

    lowered = value.lower().strip()
    normalized = re.sub(r"[^a-z0-9.-]+", "-", lowered)
    normalized = normalized.strip(".-")
    return normalized or "skill"


def fallback_skill_id(skill_name: str) -> str:
    return f"{normalize_skill_id(skill_name)}.core"


def fallback_skill_priority(skill_name: str) -> int:
    return FALLBACK_SKILL_PRIORITIES.get(skill_name, DEFAULT_PRIORITY)


def fallback_skill_task_types(skill_name: str) -> list[str]:
    defaults = FALLBACK_SKILL_TASK_TYPES.get(skill_name, [skill_name])
    return unique_strings([*defaults, normalize_identifier_segment(skill_name)])


def fallback_skill_workflow_triggers(skill_name: str) -> list[str]:
    return FALLBACK_SKILL_WORKFLOW_TRIGGERS.get(
        skill_name,
        [f"{normalize_identifier_segment(skill_name)}_request_detected"],
    )


def fallback_ref_task_types(skill_name: str) -> list[str]:
    return [normalize_identifier_segment(skill_name)]


def fallback_reference_id(skill_name: str, rel_path: str) -> str:
    relative = rel_path
    if relative.startswith("references/"):
        relative = relative[len("references/") :]
    if relative.startswith("./"):
        relative = relative[2:]
    if relative.endswith(".md"):
        relative = relative[:-3]

    segments = [
        normalize_identifier_segment(skill_name),
        "ref",
        *[normalize_identifier_segment(part) for part in relative.split("/")],
    ]
    return ".".join(segment for segment in segments if segment)


def ensure_unique_skill_id(candidate: str, skill_name: str, used_ids: set[str]) -> str:
    normalized_candidate = normalize_skill_id(candidate)
    if normalized_candidate not in used_ids:
        used_ids.add(normalized_candidate)
        return normalized_candidate

    fallback_base = fallback_skill_id(skill_name)
    if fallback_base not in used_ids:
        used_ids.add(fallback_base)
        return fallback_base

    suffix = 2
    while True:
        synthetic = f"{fallback_base}-{suffix}"
        if synthetic not in used_ids:
            used_ids.add(synthetic)
            return synthetic
        suffix += 1


def unique_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        cleaned = value.strip()
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        output.append(cleaned)
    return output


def as_string(value: Any) -> str | None:
    if isinstance(value, str):
        cleaned = value.strip()
        return cleaned or None
    return None


def as_string_list(value: Any) -> list[str] | None:
    if not isinstance(value, list):
        return None
    output: list[str] = []
    for item in value:
        if not isinstance(item, str):
            return None
        cleaned = item.strip()
        if cleaned:
            output.append(cleaned)
    return unique_strings(output)


def as_int(value: Any) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and __import__("re").fullmatch(r"-?\d+", value.strip()):
        try:
            return int(value.strip())
        except ValueError:
            return None
    return None


def as_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered == "true":
            return True
        if lowered == "false":
            return False
    return None


def extract_skill_reference_paths(skill_text: str, skill_name: str) -> list[str]:
    paths: list[str] = []
    for line in skill_text.splitlines():
        stripped = line.strip()
        if stripped.startswith("```"):
            continue

        trigger_match = TRIGGER_REF_RE.match(stripped)
        if trigger_match:
            paths.append(normalize_path(skill_name, trigger_match.group(1)))
            continue

        direct_match = DIRECT_REF_RE.match(stripped)
        if direct_match:
            paths.append(normalize_path(skill_name, direct_match.group(1)))

    return unique_strings(paths)


def fallback_ref_workflow_triggers(skill_name: str, rel_path: str) -> list[str]:
    normalized_skill = normalize_identifier_segment(skill_name)
    rel_basename = rel_path.split("/")[-1].rsplit(".", 1)[0]
    key = f"{normalized_skill}.ref.{rel_basename}"
    triggers = FALLBACK_REF_WORKFLOW_TRIGGERS.get(
        key,
        FALLBACK_REF_WORKFLOW_TRIGGERS.get(
            f"{normalized_skill}.ref.index",
            [f"{normalized_skill}_request_detected"],
        ),
    )
    return triggers


def normalize_trigger_name(trigger: str) -> str:
    normalized = normalize_identifier_segment(trigger).replace("-", "_")
    if normalized.endswith("_detected"):
        return normalized
    return f"{normalized}_detected"


def collect_routeable_refs(root: Path) -> tuple[dict[str, RefNode], dict[str, list[RefNode]], list[Path]]:
    refs_by_path: dict[str, RefNode] = {}
    refs_by_skill: dict[str, list[RefNode]] = {}
    source_files: list[Path] = []

    skills_dir = root / "skills"
    if not skills_dir.exists():
        return refs_by_path, refs_by_skill, source_files

    for skill_dir in sorted(skills_dir.iterdir(), key=lambda path: path.name):
        if not skill_dir.is_dir():
            continue

        refs_dir = skill_dir / "references"
        if not refs_dir.is_dir():
            continue

        for ref_file in sorted(refs_dir.rglob("*.md"), key=lambda path: path.as_posix()):
            source_files.append(ref_file)
            text = ref_file.read_text(encoding="utf-8", errors="ignore")
            metadata = parse_frontmatter_metadata(
                text,
                fallback_keys={
                    "id",
                    "version",
                    "task_types",
                    "trigger_phrases",
                    "priority",
                    "load_strategy",
                    "route_exclude",
                    "activation_policy",
                    "workflow_triggers",
                },
            )

            route_exclude = as_bool(metadata.get("route_exclude", False))
            if route_exclude is True:
                continue

            rel_path = ref_file.relative_to(root).as_posix()
            ref_id = as_string(metadata.get("id")) or fallback_reference_id(
                skill_dir.name,
                rel_path.removeprefix(f"skills/{skill_dir.name}/"),
            )
            if not ref_id:
                continue

            priority = as_int(metadata.get("priority")) or DEFAULT_PRIORITY

            task_types = as_string_list(metadata.get("task_types"))
            if not task_types:
                task_types = fallback_ref_task_types(skill_dir.name)

            load_strategy = as_string(metadata.get("load_strategy")) or DEFAULT_LOAD_STRATEGY

            activation_policy = as_string(metadata.get("activation_policy")) or "both"
            if activation_policy not in ACTIVATION_POLICIES:
                activation_policy = "both"

            workflow_triggers = as_string_list(metadata.get("workflow_triggers")) or fallback_ref_workflow_triggers(
                skill_dir.name,
                rel_path,
            )
            workflow_triggers = [normalize_trigger_name(trigger) for trigger in workflow_triggers]

            ref = RefNode(
                id=ref_id,
                path=rel_path,
                task_types=task_types,
                priority=priority,
                load_strategy=load_strategy,
                route_exclude=route_exclude,
                activation_policy=activation_policy,
                workflow_triggers=workflow_triggers,
            )
            refs_by_path[rel_path] = ref
            refs_by_skill.setdefault(skill_dir.name, []).append(ref)

    for skill_name in refs_by_skill:
        refs_by_skill[skill_name].sort(key=lambda ref: (-ref.priority, ref.id, ref.path))

    return refs_by_path, refs_by_skill, source_files


def collect_skills(
    root: Path,
    refs_by_path: dict[str, RefNode],
    refs_by_skill: dict[str, list[RefNode]],
) -> tuple[list[dict[str, Any]], list[Path]]:
    skills: list[dict[str, Any]] = []
    source_files: list[Path] = []
    used_skill_ids: set[str] = set()

    skills_dir = root / "skills"
    if not skills_dir.exists():
        return skills, source_files

    for skill_dir in sorted(skills_dir.iterdir(), key=lambda path: path.name):
        if not skill_dir.is_dir():
            continue

        skill_file = skill_dir / "SKILL.md"
        if not skill_file.exists():
            continue

        source_files.append(skill_file)
        text = skill_file.read_text(encoding="utf-8", errors="ignore")
        metadata = parse_frontmatter_metadata(
            text,
            fallback_keys={
                "id",
                "version",
                "task_types",
                "trigger_phrases",
                "priority",
                "load_strategy",
                "activation_policy",
                "workflow_triggers",
            },
        )

        route_exclude = as_bool(metadata.get("route_exclude", False))
        if route_exclude is True:
            continue

        skill_id = as_string(metadata.get("id")) or fallback_skill_id(skill_dir.name)
        skill_id = ensure_unique_skill_id(skill_id, skill_dir.name, used_skill_ids)

        task_types = as_string_list(metadata.get("task_types"))
        if not task_types:
            task_types = fallback_skill_task_types(skill_dir.name)

        priority = as_int(metadata.get("priority"))
        if priority is None:
            priority = fallback_skill_priority(skill_dir.name)

        load_strategy = as_string(metadata.get("load_strategy")) or DEFAULT_LOAD_STRATEGY

        activation_policy = as_string(metadata.get("activation_policy")) or "both"
        if activation_policy not in ACTIVATION_POLICIES:
            activation_policy = "both"

        workflow_triggers = as_string_list(metadata.get("workflow_triggers"))
        if not workflow_triggers:
            workflow_triggers = fallback_skill_workflow_triggers(skill_dir.name)
        workflow_triggers = [normalize_trigger_name(trigger) for trigger in workflow_triggers]

        explicit_ref_paths = extract_skill_reference_paths(text, skill_dir.name)
        primary_refs: list[str] = []
        for ref_path in explicit_ref_paths:
            ref_node = refs_by_path.get(ref_path)
            if ref_node:
                primary_refs.append(ref_node.id)

        if not primary_refs:
            for ref_node in refs_by_skill.get(skill_dir.name, []):
                primary_refs.append(ref_node.id)

        skills.append(
            SkillNode(
                id=skill_id,
                path=skill_file.relative_to(root).as_posix(),
                task_types=task_types,
                priority=priority,
                load_strategy=load_strategy,
                activation_policy=activation_policy,
                workflow_triggers=workflow_triggers,
                primary_refs=unique_strings(primary_refs)[:MAX_PRIMARY_REFS],
            ).__dict__
        )

    skills.sort(key=lambda node: (-node["priority"], node["id"], node["path"]))
    return skills, source_files


def build_indexes(skills: list[dict[str, Any]]) -> tuple[dict[str, list[str]], dict[str, list[str]]]:
    by_task_type: dict[str, list[str]] = {}
    by_workflow_trigger: dict[str, list[str]] = {}

    for skill in skills:
        skill_id = skill["id"]

        for task_type in skill["task_types"]:
            by_task_type.setdefault(task_type, [])
            if skill_id not in by_task_type[task_type]:
                by_task_type[task_type].append(skill_id)

        for trigger in skill["workflow_triggers"]:
            by_workflow_trigger.setdefault(trigger, [])
            if skill_id not in by_workflow_trigger[trigger]:
                by_workflow_trigger[trigger].append(skill_id)

    ordered_task_type_index = {key: by_task_type[key] for key in sorted(by_task_type)}
    ordered_trigger_index = {
        key: by_workflow_trigger[key] for key in sorted(by_workflow_trigger)
    }
    return ordered_task_type_index, ordered_trigger_index


def compute_generated_at(source_files: list[Path]) -> str:
    source_date_epoch = os.getenv("SOURCE_DATE_EPOCH")
    if source_date_epoch:
        try:
            epoch = int(source_date_epoch)
            timestamp = datetime.fromtimestamp(epoch, tz=timezone.utc)
            return timestamp.replace(microsecond=0).isoformat().replace("+00:00", "Z")
        except ValueError:
            pass

    latest_mtime_ns = 0
    for path in source_files:
        try:
            stat = path.stat()
        except OSError:
            continue
        latest_mtime_ns = max(latest_mtime_ns, stat.st_mtime_ns)

    if latest_mtime_ns == 0:
        timestamp = datetime.now(timezone.utc)
    else:
        timestamp = datetime.fromtimestamp(latest_mtime_ns / 1_000_000_000, tz=timezone.utc)

    return timestamp.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def build_router_artifact(root: Path) -> tuple[dict[str, Any], int]:
    refs_by_path, refs_by_skill, ref_files = collect_routeable_refs(root)
    skills, skill_files = collect_skills(root, refs_by_path, refs_by_skill)
    by_task_type, by_workflow_trigger = build_indexes(skills)

    ref_nodes = [
        {
            "id": ref.id,
            "path": ref.path,
            "task_types": ref.task_types,
            "priority": ref.priority,
            "load_strategy": ref.load_strategy,
            "route_exclude": ref.route_exclude,
            "activation_policy": ref.activation_policy,
            "workflow_triggers": ref.workflow_triggers,
        }
        for path, ref in sorted(refs_by_path.items(), key=lambda item: item[0])
    ]

    source_files = [*skill_files, *ref_files, Path(__file__)]
    generated_at = compute_generated_at(source_files)

    artifact = {
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "skills": skills,
        "by_task_type": by_task_type,
        "by_workflow_trigger": by_workflow_trigger,
    }

    return artifact, len(ref_nodes)


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    output_router_path = root / "instructions" / "skills.router.min.json"
    artifact, routeable_refs_count = build_router_artifact(root)
    output_router_path.parent.mkdir(parents=True, exist_ok=True)
    output_router_path.write_text(
        json.dumps(artifact, ensure_ascii=True, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

    print(
        "Generated {path} | skills={skills} routeable_refs={refs}".format(
            path=output_router_path,
            skills=len(artifact["skills"]),
            refs=routeable_refs_count,
        ),
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
