"""Data models for the import pipeline."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date


@dataclass
class Record:
    id: str
    name: str
    email: str
    department: str
    start_date: date
    salary: float
