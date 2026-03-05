"""CSV reader for the import pipeline."""

from __future__ import annotations

import csv
from typing import Iterator


def read_csv(csv_path: str) -> Iterator[dict[str, str]]:
    """Yield each row from a CSV file as a dict."""
    with open(csv_path, newline="", encoding="utf-8") as fh:
        reader = csv.DictReader(fh)
        for row in reader:
            yield dict(row)
