"""Notification router — sends notifications to configured channels."""

from __future__ import annotations

from notify.types import Channel, DeliveryResult, DeliveryStatus, Notification
from notify.channels.email import send_email
from notify.channels.slack import send_slack


def route_notification(notification: Notification) -> DeliveryResult:
    """Route a notification to its target channel.

    Current implementation: direct dispatch with no priority awareness
    and no idempotency handling. Sends to whichever channel is specified
    on the notification object.
    """
    if notification.channel == Channel.EMAIL:
        return send_email(notification)
    elif notification.channel == Channel.SLACK:
        return send_slack(notification)
    else:
        return DeliveryResult(
            notification_id=notification.id,
            channel=notification.channel,
            status=DeliveryStatus.FAILED,
            error=f"Unsupported channel: {notification.channel.value}",
        )


def route_batch(notifications: list[Notification]) -> list[DeliveryResult]:
    """Send a batch of notifications. No deduplication."""
    return [route_notification(n) for n in notifications]
