"""Downstream event handlers.

Currently expects dict-based events from the parser.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def handle_event(event: dict) -> None:
    """Process a single parsed event dict.

    Dispatches based on the 'action' key.
    """
    action = event["action"]
    actor = event["actor_id"]
    metadata = event.get("metadata", {})

    if action == "signup":
        logger.info("New signup: actor=%s", actor)
        _on_signup(actor, metadata)
    elif action == "purchase":
        logger.info("Purchase: actor=%s amount=%s", actor, metadata.get("amount"))
        _on_purchase(actor, metadata)
    else:
        logger.debug("Unhandled action=%s actor=%s", action, actor)


def _on_signup(actor: str, metadata: dict) -> None:
    """Handle signup events."""
    # Would typically enqueue a welcome email, update analytics, etc.
    pass


def _on_purchase(actor: str, metadata: dict) -> None:
    """Handle purchase events."""
    # Would typically update billing, trigger fulfillment, etc.
    pass
