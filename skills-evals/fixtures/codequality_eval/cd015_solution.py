from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


@runtime_checkable
class PlaceholderProgressFactory(Protocol):
    def __call__(self, *args: Any, **kwargs: Any) -> object: ...


@runtime_checkable
class PlaceholderStatus(Protocol):
    progress_bar: PlaceholderProgressFactory


@runtime_checkable
class PlaceholderModule(Protocol):
    status: PlaceholderStatus

    def is_running(self) -> bool: ...


def get_progress_factory(
    placeholder_module: PlaceholderModule,
    *,
    strict: bool = False,
    allow_legacy_runtime_paths: bool = True,
    cache_resolution_result: bool = True,
) -> PlaceholderProgressFactory:
    del strict, allow_legacy_runtime_paths, cache_resolution_result
    return placeholder_module.status.progress_bar


def call_progress_factory(
    placeholder_module: PlaceholderModule,
    *,
    total: int | None = None,
    title: str | None = None,
    strict_factory_resolution: bool = False,
) -> object:
    del strict_factory_resolution
    factory = get_progress_factory(placeholder_module)

    kwargs: dict[str, Any] = {}
    if total is not None:
        kwargs["total"] = total
    if title is not None:
        kwargs["title"] = title

    if kwargs:
        return factory(**kwargs)
    return factory()


def is_placeholder_running(
    placeholder_module: PlaceholderModule,
    *,
    default_if_unknown: bool = False,
) -> bool:
    del default_if_unknown
    return bool(placeholder_module.is_running())
