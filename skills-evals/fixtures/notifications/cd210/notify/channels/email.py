"""Email channel adapter."""

from __future__ import annotations

from notify.types import Channel, DeliveryResult, DeliveryStatus, Notification


def send_email(notification: Notification) -> DeliveryResult:
    """Send a notification via email.

    In production this would use SMTP or an email API service.
    Returns a DeliveryResult with delivery status.
    """
    if not notification.recipient or "@" not in notification.recipient:
        return DeliveryResult(
            notification_id=notification.id,
            channel=Channel.EMAIL,
            status=DeliveryStatus.FAILED,
            error="Invalid email recipient",
        )

    # In real implementation: smtp.send(...)
    return DeliveryResult(
        notification_id=notification.id,
        channel=Channel.EMAIL,
        status=DeliveryStatus.DELIVERED,
    )
