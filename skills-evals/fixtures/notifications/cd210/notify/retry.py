"""Retry logic for notification delivery."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable

from notify.types import DeliveryResult, DeliveryStatus


@dataclass(frozen=True)
class RetryConfig:
    max_attempts: int = 3
    base_delay: float = 1.0
    backoff_factor: float = 2.0
    retryable_statuses: tuple[DeliveryStatus, ...] = (DeliveryStatus.FAILED,)


def retry_with_backoff(
    fn: Callable[[], DeliveryResult],
    config: RetryConfig | None = None,
) -> DeliveryResult:
    """Retry a delivery function with exponential backoff.

    Calls fn() up to max_attempts times. Returns immediately on success
    or non-retryable status. Sleeps between retries with exponential delay.
    """
    cfg = config or RetryConfig()
    last_result: DeliveryResult | None = None

    for attempt in range(1, cfg.max_attempts + 1):
        result = fn()
        last_result = result

        if result.status == DeliveryStatus.DELIVERED:
            return result

        if result.status not in cfg.retryable_statuses:
            return result

        if attempt < cfg.max_attempts:
            delay = cfg.base_delay * (cfg.backoff_factor ** (attempt - 1))
            time.sleep(delay)

    assert last_result is not None
    return DeliveryResult(
        notification_id=last_result.notification_id,
        channel=last_result.channel,
        status=DeliveryStatus.FAILED,
        error=f"Failed after {cfg.max_attempts} attempts: {last_result.error}",
        attempts=cfg.max_attempts,
    )
