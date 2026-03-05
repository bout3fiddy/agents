"""Shared type contracts for the query subsystem."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class FieldType(Enum):
    STRING = "string"
    INTEGER = "integer"
    FLOAT = "float"
    BOOLEAN = "boolean"
    TIMESTAMP = "timestamp"


@dataclass(frozen=True)
class FieldSchema:
    name: str
    field_type: FieldType
    nullable: bool = False
    indexed: bool = False


@dataclass(frozen=True)
class TableSchema:
    name: str
    fields: tuple[FieldSchema, ...] = ()

    def get_field(self, name: str) -> FieldSchema | None:
        return next((f for f in self.fields if f.name == name), None)

    @property
    def indexed_fields(self) -> tuple[FieldSchema, ...]:
        return tuple(f for f in self.fields if f.indexed)


class FilterOperator(Enum):
    EQ = "eq"
    NEQ = "neq"
    GT = "gt"
    GTE = "gte"
    LT = "lt"
    LTE = "lte"
    IN = "in"
    LIKE = "like"
    IS_NULL = "is_null"


class SortDirection(Enum):
    ASC = "asc"
    DESC = "desc"


@dataclass(frozen=True)
class FilterSpec:
    field: str
    operator: FilterOperator
    value: Any


@dataclass(frozen=True)
class SortSpec:
    field: str
    direction: SortDirection = SortDirection.ASC


@dataclass
class ValidationError:
    field: str
    message: str
    code: str = "invalid"


@dataclass
class ValidationResult:
    valid: bool
    errors: list[ValidationError] = field(default_factory=list)

    @staticmethod
    def ok() -> ValidationResult:
        return ValidationResult(valid=True)

    @staticmethod
    def fail(errors: list[ValidationError]) -> ValidationResult:
        return ValidationResult(valid=False, errors=errors)
