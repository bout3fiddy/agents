"""Event schema definitions.

EventV2 is the canonical contract — all upstream producers have migrated.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


# Deprecated — v2 is canonical. All producers now emit v2 events.
@dataclass
class EventV1:
    user_id: str
    action: str
    ts: str


@dataclass
class EventV2:
    actor_id: str
    action: str
    ts: datetime
    metadata: dict[str, str] = field(default_factory=dict)
