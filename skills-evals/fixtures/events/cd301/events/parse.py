"""Event parser — normalizes raw JSON dicts into a standard shape.

Currently returns plain dicts; downstream code consumes dict keys directly.
"""

from __future__ import annotations

from datetime import datetime, timezone


def parse_event(raw: dict) -> dict:
    """Parse a raw event dict into a normalized dict.

    Handles both v1 (user_id) and v2 (actor_id) payloads for backward
    compatibility during the producer migration window.
    """
    # TODO: remove v1 compat once all producers migrate
    actor = raw.get("actor_id") or raw.get("user_id")
    if not actor:
        raise ValueError("Event missing actor_id / user_id")

    action = raw.get("action")
    if not action:
        raise ValueError("Event missing action")

    raw_ts = raw.get("ts")
    if raw_ts is None:
        ts = datetime.now(timezone.utc)
    elif isinstance(raw_ts, str):
        ts = datetime.fromisoformat(raw_ts)
    else:
        ts = raw_ts

    metadata = raw.get("metadata") or {}

    return {
        "actor_id": actor,
        "action": action,
        "ts": ts,
        "metadata": metadata,
    }
