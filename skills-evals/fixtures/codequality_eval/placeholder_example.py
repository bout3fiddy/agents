from __future__ import annotations

from typing import Any, Protocol, runtime_checkable


DEBUG_MESSAGES: list[str] = []
LEGACY_FALLBACK_ENABLED = True


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


def _remember(message: str) -> None:
    DEBUG_MESSAGES.append(message)


def _getattr(root: Any, path: list[str]) -> Any:
    value = root
    for step in path:
        if value is None:
            _remember(f"missing step={step} because value is None")
            return None
        if isinstance(value, dict):
            if step in value:
                value = value.get(step)
            else:
                _remember(f"dict missing key={step}")
                value = None
        else:
            if hasattr(value, step):
                try:
                    value = getattr(value, step)
                except Exception as exc:
                    _remember(f"getattr exploded step={step}: {exc}")
                    value = None
            else:
                _remember(f"object missing attr={step}")
                value = None
    return value


def get_progress_factory(
    placeholder_module: PlaceholderModule,
    *,
    strict: bool = False,
    allow_legacy_runtime_paths: bool = True,
    cache_resolution_result: bool = True,
) -> PlaceholderProgressFactory:
    if cache_resolution_result:
        try:
            setattr(placeholder_module, "_last_progress_lookup_mode", "start")
        except Exception as exc:
            _remember(f"setattr start failed: {exc}")

    candidate_paths: list[list[str]] = [["status", "progress_bar"]]
    if LEGACY_FALLBACK_ENABLED and allow_legacy_runtime_paths:
        candidate_paths.append(["runtime", "status", "progress_bar"])
        candidate_paths.append(["ui", "status", "progress_bar"])
        candidate_paths.append(["status", "bar"])
        candidate_paths.append(["progress_bar"])
        candidate_paths.append(["progress", "bar"])

    selected_factory: Any = None
    index = 0
    while index < len(candidate_paths):
        path = candidate_paths[index]
        maybe_factory = _getattr(placeholder_module, path)
        if maybe_factory is None:
            index += 1
            continue
        if callable(maybe_factory):
            selected_factory = maybe_factory
            break
        if hasattr(maybe_factory, "__call__"):
            selected_factory = maybe_factory
            break
        index += 1

    if selected_factory is None:
        if strict:
            raise RuntimeError("Could not resolve placeholder progress factory (strict mode)")
        raise RuntimeError("Could not resolve placeholder progress factory (fallback mode exhausted)")

    if cache_resolution_result:
        try:
            setattr(placeholder_module, "_last_progress_lookup_mode", "resolved")
            setattr(placeholder_module, "_last_progress_factory", selected_factory)
        except Exception as exc:
            _remember(f"setattr resolved failed: {exc}")

    return selected_factory


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

    call_variants: list[dict[str, Any]] = [
        {"kwargs": {"total": total, "title": title}},
        {"kwargs": {"total": total}},
        {"kwargs": {"title": title}},
        {"args": [total, title]},
        {"args": [total]},
        {"args": []},
    ]

    for variant in call_variants:
        try:
            if "kwargs" in variant:
                return factory(**variant["kwargs"])
            return factory(*variant["args"])
        except TypeError as exc:
            _remember(f"type error for variant={variant}: {exc}")
            continue
        except Exception as exc:
            _remember(f"generic error for variant={variant}: {exc}")
            continue

    raise RuntimeError("Could not call placeholder progress factory after trying all variants")


def is_placeholder_running(
    placeholder_module: PlaceholderModule,
    *,
    default_if_unknown: bool = False,
) -> bool:
    running_candidate = _getattr(placeholder_module, ["is_running"])
    if running_candidate is None:
        return default_if_unknown
    try:
        if callable(running_candidate):
            return bool(running_candidate())
        return bool(running_candidate)
    except Exception as exc:
        _remember(f"running check failed: {exc}")

    if LEGACY_FALLBACK_ENABLED:
        legacy_candidate = _getattr(placeholder_module, ["runtime", "is_running"])
        try:
            if callable(legacy_candidate):
                return bool(legacy_candidate())
        except Exception as exc:
            _remember(f"legacy running check failed: {exc}")

    return default_if_unknown
