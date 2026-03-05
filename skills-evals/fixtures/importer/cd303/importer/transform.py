"""Row validation and transformation."""

from __future__ import annotations

from datetime import date

from .models import Record


def transform(row: dict[str, str]) -> Record:
    """Validate a raw CSV row dict and return a typed Record.

    Raises ValueError with a descriptive message when validation fails.
    """
    row_id = row.get("id", "").strip()
    if not row_id:
        raise ValueError("Missing required field: id")

    name = row.get("name", "").strip()
    if not name:
        raise ValueError(f"Row {row_id}: missing required field: name")

    email = row.get("email", "").strip()
    if not email or "@" not in email:
        raise ValueError(f"Row {row_id}: invalid email: {email!r}")

    department = row.get("department", "").strip()
    if not department:
        raise ValueError(f"Row {row_id}: missing required field: department")

    raw_date = row.get("start_date", "").strip()
    try:
        start_date = date.fromisoformat(raw_date)
    except (ValueError, TypeError) as exc:
        raise ValueError(f"Row {row_id}: invalid start_date {raw_date!r}: {exc}") from exc

    raw_salary = row.get("salary", "").strip()
    try:
        salary = float(raw_salary)
    except (ValueError, TypeError) as exc:
        raise ValueError(f"Row {row_id}: invalid salary {raw_salary!r}: {exc}") from exc

    if salary < 0:
        raise ValueError(f"Row {row_id}: salary cannot be negative: {salary}")

    return Record(
        id=row_id,
        name=name,
        email=email,
        department=department,
        start_date=start_date,
        salary=salary,
    )
