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
    factory = placeholder_module.status.progress_bar
    if not callable(factory):
        raise RuntimeError("placeholder_module.status.progress_bar is not callable")
    return factory


def call_progress_factory(
    placeholder_module: PlaceholderModule,
    *,
    total: int | None = None,
    title: str | None = None,
    strict_factory_resolution: bool = False,
) -> object:
    factory = get_progress_factory(
        placeholder_module,
        strict=strict_factory_resolution,
        allow_legacy_runtime_paths=True,
        cache_resolution_result=True,
    )

    kwargs: dict[str, Any] = {}
    if total is not None:
        kwargs["total"] = total
    if title is not None:
        kwargs["title"] = title
    return factory(**kwargs)


def is_placeholder_running(
    placeholder_module: PlaceholderModule,
    *,
    default_if_unknown: bool = False,
) -> bool:
    try:
        return bool(placeholder_module.is_running())
    except Exception:
        return default_if_unknown
