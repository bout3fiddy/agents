"""Shared types for the notification system."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class Channel(Enum):
    EMAIL = "email"
    SLACK = "slack"
    SMS = "sms"
    WEBHOOK = "webhook"


class Priority(Enum):
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    CRITICAL = "critical"


class DeliveryStatus(Enum):
    PENDING = "pending"
    DELIVERED = "delivered"
    FAILED = "failed"
    RETRYING = "retrying"


@dataclass(frozen=True)
class Notification:
    id: str
    recipient: str
    subject: str
    body: str
    channel: Channel = Channel.EMAIL
    priority: Priority = Priority.NORMAL
    metadata: dict[str, Any] = field(default_factory=dict)


@dataclass
class DeliveryResult:
    notification_id: str
    channel: Channel
    status: DeliveryStatus
    error: str | None = None
    attempts: int = 1
