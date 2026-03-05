"""Batch import pipeline orchestrator."""

from __future__ import annotations

import logging

from .reader import read_csv
from .transform import transform
from .loader import load

logger = logging.getLogger(__name__)


def run_import(csv_path: str) -> int:
    """Import records from a CSV file.

    Returns the number of successfully imported rows.
    """
    imported = 0
    for row in read_csv(csv_path):
        try:
            record = transform(row)
            load(record)
            imported += 1
        except Exception:
            # keep going — we'd rather import most rows than crash
            logger.warning("Skipping row %s", row.get("id", "?"))
            continue
    logger.info("Imported %d rows", imported)
    return imported
