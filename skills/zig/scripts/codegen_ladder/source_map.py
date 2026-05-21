from __future__ import annotations

import platform
import shutil
from pathlib import Path

from .common import run_capture
from .types import JsonArray, JsonObject, JsonValue, as_json_array, as_json_object

SOURCE_MAP_ADDRESS_LIMIT = 16


def item_address(item: JsonValue) -> str | None:
    item_object = as_json_object(item)
    if item_object is None:
        return None
    address = item_object.get("address")
    return address if isinstance(address, str) else None


def collect_source_items(checks: JsonArray, calls: JsonObject) -> JsonArray:
    items: JsonArray = []
    for check in checks:
        check_object = as_json_object(check)
        if check_object is None:
            continue
        matches = as_json_array(check_object.get("matches"))
        if matches is not None:
            items.extend(item for item in matches if as_json_object(item) is not None)
    call_items = as_json_array(calls.get("calls"))
    if call_items is not None:
        items.extend(item for item in call_items if as_json_object(item) is not None)
    return items


def collect_addresses(items: JsonArray) -> list[str]:
    addresses: list[str] = []
    for item in items:
        address = item_address(item)
        if address and address not in addresses:
            addresses.append(address)
        if len(addresses) >= SOURCE_MAP_ADDRESS_LIMIT:
            break
    return addresses


def source_map_skip(reason: str) -> JsonObject:
    return {
        "status": "skip",
        "tool": None,
        "entries": [],
        "errors": [reason],
    }


def source_map_entries(
    artifact: Path | None, items: JsonArray, cwd: Path
) -> JsonObject:
    if artifact is None or not artifact.exists():
        return source_map_skip("artifact missing")
    addresses = collect_addresses(items)
    if not addresses:
        return source_map_skip("no addresses to map")

    system = platform.system().lower()
    if system == "darwin" and shutil.which("atos"):
        return run_atos_source_map(artifact, addresses, cwd)
    if shutil.which("addr2line"):
        return run_addr2line_source_map(artifact, addresses, cwd)
    return source_map_skip("no supported source mapper found")


def run_atos_source_map(artifact: Path, addresses: list[str], cwd: Path) -> JsonObject:
    arch = platform.machine() or "arm64"
    entries: JsonArray = []
    errors: JsonArray = []
    for address in addresses:
        code, stdout, stderr = run_capture(
            ["atos", "-inlineFrames", "-o", str(artifact), "-arch", arch, address],
            cwd,
        )
        entries.append(
            {
                "address": address,
                "status": "pass" if code == 0 else "fail",
                "frames": [line for line in stdout.splitlines() if line.strip()],
            }
        )
        if stderr.strip():
            errors.append(stderr.strip())
    return {"status": "pass", "tool": "atos", "entries": entries, "errors": errors}


def run_addr2line_source_map(
    artifact: Path, addresses: list[str], cwd: Path
) -> JsonObject:
    entries: JsonArray = []
    errors: JsonArray = []
    for address in addresses:
        code, stdout, stderr = run_capture(
            ["addr2line", "-e", str(artifact), "-f", "-C", address],
            cwd,
        )
        entries.append(
            {
                "address": address,
                "status": "pass" if code == 0 else "fail",
                "frames": [line for line in stdout.splitlines() if line.strip()],
            }
        )
        if stderr.strip():
            errors.append(stderr.strip())
    return {"status": "pass", "tool": "addr2line", "entries": entries, "errors": errors}
