"""Database loader for the import pipeline."""

from __future__ import annotations

import logging

from .models import Record

logger = logging.getLogger(__name__)

# In-memory store (simulates DB writes for this module)
_store: list[Record] = []


def load(record: Record) -> None:
    """Write a single record to the database.

    Raises ConnectionError if the write fails.
    """
    # Simulate a DB insert
    _store.append(record)
    logger.debug("Loaded record id=%s", record.id)


def get_store() -> list[Record]:
    """Return all loaded records (testing helper)."""
    return list(_store)


def reset_store() -> None:
    """Clear the in-memory store (testing helper)."""
    _store.clear()
