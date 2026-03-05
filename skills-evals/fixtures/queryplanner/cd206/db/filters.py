"""Filter parsing and validation."""

from __future__ import annotations

from db.contracts import (
    FieldType,
    FilterOperator,
    FilterSpec,
    TableSchema,
    ValidationError,
    ValidationResult,
)

# Operators valid per field type
_TYPE_OPERATORS: dict[FieldType, set[FilterOperator]] = {
    FieldType.STRING: {
        FilterOperator.EQ,
        FilterOperator.NEQ,
        FilterOperator.IN,
        FilterOperator.LIKE,
        FilterOperator.IS_NULL,
    },
    FieldType.INTEGER: {
        FilterOperator.EQ,
        FilterOperator.NEQ,
        FilterOperator.GT,
        FilterOperator.GTE,
        FilterOperator.LT,
        FilterOperator.LTE,
        FilterOperator.IN,
        FilterOperator.IS_NULL,
    },
    FieldType.FLOAT: {
        FilterOperator.EQ,
        FilterOperator.NEQ,
        FilterOperator.GT,
        FilterOperator.GTE,
        FilterOperator.LT,
        FilterOperator.LTE,
        FilterOperator.IS_NULL,
    },
    FieldType.BOOLEAN: {
        FilterOperator.EQ,
        FilterOperator.NEQ,
        FilterOperator.IS_NULL,
    },
    FieldType.TIMESTAMP: {
        FilterOperator.EQ,
        FilterOperator.GT,
        FilterOperator.GTE,
        FilterOperator.LT,
        FilterOperator.LTE,
        FilterOperator.IS_NULL,
    },
}


def validate_filter(spec: FilterSpec, schema: TableSchema) -> ValidationResult:
    """Validate a single filter spec against a table schema."""
    field_schema = schema.get_field(spec.field)
    if field_schema is None:
        return ValidationResult.fail([
            ValidationError(
                field=spec.field,
                message=f"Unknown field: {spec.field}",
                code="unknown_field",
            )
        ])

    allowed = _TYPE_OPERATORS.get(field_schema.field_type, set())
    if spec.operator not in allowed:
        return ValidationResult.fail([
            ValidationError(
                field=spec.field,
                message=(
                    f"Operator {spec.operator.value} not supported "
                    f"for type {field_schema.field_type.value}"
                ),
                code="invalid_operator",
            )
        ])

    return ValidationResult.ok()


def validate_filters(
    specs: list[FilterSpec], schema: TableSchema
) -> ValidationResult:
    """Validate a list of filter specs, collecting all errors."""
    errors: list[ValidationError] = []
    for spec in specs:
        result = validate_filter(spec, schema)
        errors.extend(result.errors)
    if errors:
        return ValidationResult.fail(errors)
    return ValidationResult.ok()
