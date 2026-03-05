"""Event ingestion pipeline.

Reads a JSON stream of events and passes each through the parser
to the downstream handler.
"""

from __future__ import annotations

import json
import logging
from typing import TextIO

from .parse import parse_event
from .handlers import handle_event

logger = logging.getLogger(__name__)


def ingest_stream(stream: TextIO) -> int:
    """Read JSON events from a stream and dispatch to the handler.

    Returns the count of successfully ingested events.
    """
    count = 0
    for line in stream:
        line = line.strip()
        if not line:
            continue
        raw = json.loads(line)
        event = parse_event(raw)
        handle_event(event)
        count += 1
    logger.info("Ingested %d events", count)
    return count
