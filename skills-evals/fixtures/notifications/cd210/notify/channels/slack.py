"""Slack channel adapter."""

from __future__ import annotations

from notify.types import Channel, DeliveryResult, DeliveryStatus, Notification


def send_slack(notification: Notification) -> DeliveryResult:
    """Send a notification via Slack webhook.

    In production this would POST to a Slack incoming webhook URL.
    Returns a DeliveryResult with delivery status.
    """
    if not notification.recipient.startswith("#"):
        return DeliveryResult(
            notification_id=notification.id,
            channel=Channel.SLACK,
            status=DeliveryStatus.FAILED,
            error="Slack recipient must be a channel name (start with #)",
        )

    # In real implementation: requests.post(webhook_url, json=payload)
    return DeliveryResult(
        notification_id=notification.id,
        channel=Channel.SLACK,
        status=DeliveryStatus.DELIVERED,
    )
