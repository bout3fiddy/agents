"""Sort specification parsing and validation."""

from __future__ import annotations

from db.contracts import (
    SortDirection,
    SortSpec,
    TableSchema,
    ValidationError,
    ValidationResult,
)


def validate_sort(spec: SortSpec, schema: TableSchema) -> ValidationResult:
    """Validate a single sort spec against a table schema."""
    field_schema = schema.get_field(spec.field)
    if field_schema is None:
        return ValidationResult.fail([
            ValidationError(
                field=spec.field,
                message=f"Cannot sort by unknown field: {spec.field}",
                code="unknown_field",
            )
        ])
    return ValidationResult.ok()


def validate_sorts(
    specs: list[SortSpec], schema: TableSchema
) -> ValidationResult:
    """Validate a list of sort specs."""
    errors: list[ValidationError] = []
    seen: set[str] = set()
    for spec in specs:
        if spec.field in seen:
            errors.append(
                ValidationError(
                    field=spec.field,
                    message=f"Duplicate sort field: {spec.field}",
                    code="duplicate_sort",
                )
            )
            continue
        seen.add(spec.field)
        result = validate_sort(spec, schema)
        errors.extend(result.errors)
    if errors:
        return ValidationResult.fail(errors)
    return ValidationResult.ok()


def parse_sort_string(raw: str) -> list[SortSpec]:
    """Parse a comma-separated sort string like 'name:asc,created_at:desc'."""
    specs: list[SortSpec] = []
    for part in raw.split(","):
        part = part.strip()
        if not part:
            continue
        if ":" in part:
            field, direction_str = part.rsplit(":", 1)
            direction = SortDirection(direction_str.lower())
        else:
            field = part
            direction = SortDirection.ASC
        specs.append(SortSpec(field=field.strip(), direction=direction))
    return specs
