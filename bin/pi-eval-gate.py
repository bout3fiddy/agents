#!/usr/bin/env python3
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path


def warn(message: str) -> None:
    print(message, file=sys.stderr)


def run_git(args: list[str], root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *args],
        cwd=root,
        check=False,
        text=True,
        capture_output=True,
    )


def read_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if isinstance(data, dict):
        return data
    raise ValueError(f"Expected JSON object in {path}")


def resolve_model_key(required: str, keys: list[str], errors: list[str]) -> str | None:
    if required in keys:
        return required

    if "/" in required:
        errors.append(f"Required model '{required}' is missing from the report index.")
        return None

    exact_matches = [key for key in keys if key.split("/")[-1] == required]
    if len(exact_matches) == 1:
        return exact_matches[0]
    if len(exact_matches) > 1:
        errors.append(
            "Required model '{req}' matches multiple report keys ({matches}); use provider/id.".format(
                req=required,
                matches=", ".join(sorted(exact_matches)),
            )
        )
        return None

    substring_matches = [key for key in keys if required in key]
    if len(substring_matches) == 1:
        return substring_matches[0]
    if len(substring_matches) > 1:
        errors.append(
            "Required model '{req}' matches multiple report keys ({matches}); use provider/id.".format(
                req=required,
                matches=", ".join(sorted(substring_matches)),
            )
        )
        return None

    errors.append(f"Required model '{required}' is missing from the report index.")
    return None


def verify_commit(sha: str, root: Path) -> str | None:
    result = run_git(["rev-parse", "--verify", f"{sha}^{{commit}}"], root)
    if result.returncode != 0:
        return None
    return result.stdout.strip()


def main() -> int:
    root = Path(__file__).resolve().parents[1]
    config_path = root / "extensions" / "pi-eval" / "config" / "eval.config.json"
    index_path = root / "skills-evals" / "reports" / "index.json"

    if shutil.which("pi") is None:
        warn("pi-eval gate: pi is not installed; skipping eval gating.")
        return 0

    if shutil.which("git") is None:
        warn("pi-eval gate: git is not installed; skipping eval gating.")
        return 0

    if run_git(["rev-parse", "--is-inside-work-tree"], root).returncode != 0:
        warn("pi-eval gate: not in a git repository; skipping eval gating.")
        return 0

    if not config_path.exists():
        warn("pi-eval gate: config not found; skipping eval gating.")
        return 0

    try:
        config = read_json(config_path)
    except Exception as exc:  # pragma: no cover - defensive for invalid configs
        warn(f"pi-eval gate: failed to read config: {exc}")
        return 1

    required_models = config.get("requiredModels") or []
    if not required_models:
        return 0

    if not index_path.exists():
        warn(f"pi-eval gate: report index missing at {index_path}")
        return 1

    try:
        index = read_json(index_path)
    except Exception as exc:  # pragma: no cover - defensive for invalid index
        warn(f"pi-eval gate: failed to read report index: {exc}")
        return 1

    keys = sorted(index.keys())
    if not keys:
        warn("pi-eval gate: report index is empty.")
        return 1

    latest_change = run_git(
        ["log", "-1", "--format=%H", "--", "skills", "instructions/global.md"],
        root,
    ).stdout.strip()

    if not latest_change:
        warn("pi-eval gate: no commits found for skills/instructions; skipping eval gating.")
        return 0

    errors: list[str] = []

    for required in required_models:
        key = resolve_model_key(str(required), keys, errors)
        if not key:
            continue

        entry = index.get(key)
        if not isinstance(entry, dict):
            errors.append(f"Report index entry for '{key}' is invalid.")
            continue

        report_sha = entry.get("sha")
        if not isinstance(report_sha, str) or not report_sha:
            errors.append(f"Report index entry for '{key}' is missing a sha.")
            continue

        resolved_sha = verify_commit(report_sha, root)
        if not resolved_sha:
            errors.append(f"Report sha '{report_sha}' for '{key}' is not in git history.")
            continue

        up_to_date = run_git(["merge-base", "--is-ancestor", latest_change, resolved_sha], root)
        if up_to_date.returncode != 0:
            errors.append(
                "Report for '{key}' ({sha}) predates latest skills/instructions change ({latest}).".format(
                    key=key,
                    sha=report_sha,
                    latest=latest_change[:7],
                )
            )

    if errors:
        warn("pi-eval gate: eval reports are out of date:")
        for message in errors:
            warn(f"  - {message}")
        return 1

    return 0


if __name__ == "__main__":
    sys.exit(main())
