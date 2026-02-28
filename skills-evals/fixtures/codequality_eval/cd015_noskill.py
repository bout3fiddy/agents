from __future__ import annotations

import time
import traceback
from typing import Any, Callable


def _to_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except Exception:
        return int(default)


def normalize_items(items: Any) -> list[Any]:
    if items is None:
        return []
    if isinstance(items, list):
        return items
    if isinstance(items, (str, bytes, bytearray)):
        return [items]
    try:
        return list(items)
    except Exception:
        return [items]


def validate_run_config(
    *,
    retries: int = 1,
    batch_size: int = 10,
    max_errors: int | None = None,
    stop_on_error: bool = False,
    include_error_trace: bool = False,
    emit_metrics: bool = True,
) -> dict[str, Any]:
    normalized_retries = max(0, _to_int(retries, 1))
    normalized_batch_size = max(1, _to_int(batch_size, 10))

    if max_errors is None:
        normalized_max_errors: int | None = None
    else:
        normalized_max_errors = max(0, _to_int(max_errors, 0))

    return {
        "retries": normalized_retries,
        "batch_size": normalized_batch_size,
        "max_errors": normalized_max_errors,
        "stop_on_error": bool(stop_on_error),
        "include_error_trace": bool(include_error_trace),
        "emit_metrics": bool(emit_metrics),
    }


def format_error_record(
    index: int,
    item: Any,
    error: Exception,
    *,
    include_trace: bool = False,
) -> dict[str, Any]:
    record: dict[str, Any] = {
        "index": int(index),
        "item": item,
        "error_type": type(error).__name__,
        "error_message": str(error),
    }
    if include_trace:
        record["trace"] = "".join(traceback.format_exception(type(error), error, error.__traceback__))
    return record


def start_progress(placeholder_module: Any, total_items: int, *, title: str | None = None) -> Any:
    return placeholder_module.status.progress_bar(total=total_items, title=title)


def _safe_callback(callback: Callable[..., Any] | None, *args: Any, **kwargs: Any) -> None:
    if callback is None:
        return
    try:
        callback(*args, **kwargs)
    except Exception:
        return


def run_worker_with_retry(
    worker: Callable[[Any], Any],
    item: Any,
    *,
    retries: int = 1,
    on_error: Callable[..., None] | None = None,
    config: dict[str, Any] | None = None,
) -> tuple[bool, Any]:
    effective_retries = retries if config is None else config.get("retries", retries)
    attempts = max(0, _to_int(effective_retries, 1)) + 1

    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            return True, worker(item)
        except Exception as error:  # noqa: BLE001
            last_error = error
            _safe_callback(on_error, item, error, attempt, attempts)

    return False, last_error


def build_summary(
    *,
    total_items: int,
    processed_items: int,
    success_count: int,
    error_count: int,
    stopped_early: bool,
    start_index: int,
    next_index: int,
) -> dict[str, Any]:
    return {
        "total_items": int(total_items),
        "start_index": int(start_index),
        "next_index": int(next_index),
        "processed_items": int(processed_items),
        "remaining_items": max(int(total_items) - int(next_index), 0),
        "success_count": int(success_count),
        "error_count": int(error_count),
        "stopped_early": bool(stopped_early),
    }


def _compute_metrics(*, started_at: float, ended_at: float, processed_items: int) -> dict[str, Any]:
    duration_sec = max(float(ended_at) - float(started_at), 0.0)
    duration_ms = duration_sec * 1000.0
    throughput = (processed_items / duration_sec) if duration_sec > 0 else 0.0
    return {
        "duration_ms": duration_ms,
        "throughput_items_per_sec": throughput,
    }


def _finalize_return(
    *,
    return_mode: str,
    results: list[Any],
    errors: list[dict[str, Any]],
    summary: dict[str, Any],
    metrics: dict[str, Any],
    next_index: int,
) -> dict[str, Any]:
    mode = (return_mode or "full").strip().lower()
    if mode in {"summary", "summary-only", "summary_only"}:
        return {"summary": summary}
    if mode in {"results", "results-only", "results_only"}:
        return {"results": results}
    return {
        "results": results,
        "errors": errors,
        "summary": summary,
        "metrics": metrics,
        "next_index": int(next_index),
    }


def map_with_progress(
    placeholder_module: Any,
    items: Any,
    worker: Callable[[Any], Any],
    *,
    title: str | None = None,
    config: dict[str, Any] | None = None,
    on_start: Callable[..., None] | None = None,
    on_item_start: Callable[..., None] | None = None,
    on_item_success: Callable[..., None] | None = None,
    on_item_error: Callable[..., None] | None = None,
    on_stop: Callable[..., None] | None = None,
    start_index: int = 0,
    return_mode: str = "full",
) -> dict[str, Any]:
    normalized_items = normalize_items(items)
    total_items = len(normalized_items)
    normalized_start_index = min(max(0, _to_int(start_index, 0)), total_items)
    run_config = validate_run_config(**(config or {}))

    start_progress(placeholder_module, total_items, title=title)
    _safe_callback(on_start, total_items, normalized_start_index, run_config)

    started_at = time.perf_counter()

    results: list[Any] = []
    errors: list[dict[str, Any]] = []
    stopped_early = False
    next_index = normalized_start_index

    for index in range(normalized_start_index, total_items):
        if not placeholder_module.is_running():
            stopped_early = True
            break

        item = normalized_items[index]
        _safe_callback(on_item_start, index, item)

        success, value_or_error = run_worker_with_retry(
            worker,
            item,
            retries=run_config["retries"],
            config=run_config,
        )

        next_index = index + 1

        if success:
            results.append(value_or_error)
            _safe_callback(on_item_success, index, item, value_or_error)
            continue

        error_record = format_error_record(
            index,
            item,
            value_or_error,
            include_trace=run_config["include_error_trace"],
        )
        errors.append(error_record)
        _safe_callback(on_item_error, error_record)

        if run_config["stop_on_error"]:
            stopped_early = True
            break

        max_errors = run_config["max_errors"]
        if max_errors is not None and len(errors) >= max_errors:
            stopped_early = True
            break

    processed_items = max(next_index - normalized_start_index, 0)
    summary = build_summary(
        total_items=total_items,
        processed_items=processed_items,
        success_count=len(results),
        error_count=len(errors),
        stopped_early=stopped_early,
        start_index=normalized_start_index,
        next_index=next_index,
    )

    _safe_callback(on_stop, summary)

    ended_at = time.perf_counter()
    metrics = (
        _compute_metrics(started_at=started_at, ended_at=ended_at, processed_items=processed_items)
        if run_config["emit_metrics"]
        else {}
    )

    return _finalize_return(
        return_mode=return_mode,
        results=results,
        errors=errors,
        summary=summary,
        metrics=metrics,
        next_index=next_index,
    )


def process_batch(
    placeholder_module: Any,
    batch_items: Any,
    worker: Callable[[Any], Any],
    *,
    config: dict[str, Any] | None = None,
    on_item_start: Callable[..., None] | None = None,
    on_item_success: Callable[..., None] | None = None,
    on_item_error: Callable[..., None] | None = None,
    base_index: int = 0,
) -> dict[str, Any]:
    normalized_batch = normalize_items(batch_items)
    run_config = validate_run_config(**(config or {}))

    results: list[Any] = []
    errors: list[dict[str, Any]] = []
    stopped_early = False
    base = _to_int(base_index, 0)
    next_index = base

    for offset, item in enumerate(normalized_batch):
        index = base + offset
        if not placeholder_module.is_running():
            stopped_early = True
            next_index = index
            break

        _safe_callback(on_item_start, index, item)

        success, value_or_error = run_worker_with_retry(
            worker,
            item,
            retries=run_config["retries"],
            config=run_config,
        )

        next_index = index + 1

        if success:
            results.append(value_or_error)
            _safe_callback(on_item_success, index, item, value_or_error)
            continue

        error_record = format_error_record(
            index,
            item,
            value_or_error,
            include_trace=run_config["include_error_trace"],
        )
        errors.append(error_record)
        _safe_callback(on_item_error, error_record)

        if run_config["stop_on_error"]:
            stopped_early = True
            break

        max_errors = run_config["max_errors"]
        if max_errors is not None and len(errors) >= max_errors:
            stopped_early = True
            break

    return {
        "results": results,
        "errors": errors,
        "processed_items": len(results) + len(errors),
        "stopped_early": stopped_early,
        "next_index": next_index,
    }


def map_with_progress_batched(
    placeholder_module: Any,
    items: Any,
    worker: Callable[[Any], Any],
    *,
    title: str | None = None,
    config: dict[str, Any] | None = None,
    on_start: Callable[..., None] | None = None,
    on_item_start: Callable[..., None] | None = None,
    on_item_success: Callable[..., None] | None = None,
    on_item_error: Callable[..., None] | None = None,
    on_stop: Callable[..., None] | None = None,
    start_index: int = 0,
    return_mode: str = "full",
) -> dict[str, Any]:
    normalized_items = normalize_items(items)
    total_items = len(normalized_items)
    normalized_start_index = min(max(0, _to_int(start_index, 0)), total_items)
    run_config = validate_run_config(**(config or {}))

    start_progress(placeholder_module, total_items, title=title)
    _safe_callback(on_start, total_items, normalized_start_index, run_config)

    started_at = time.perf_counter()

    all_results: list[Any] = []
    all_errors: list[dict[str, Any]] = []
    stopped_early = False
    next_index = normalized_start_index

    cursor = normalized_start_index
    batch_size = run_config["batch_size"]

    while cursor < total_items:
        if not placeholder_module.is_running():
            stopped_early = True
            break

        if run_config["max_errors"] is None:
            remaining_errors = None
        else:
            remaining_errors = run_config["max_errors"] - len(all_errors)
            if remaining_errors <= 0:
                stopped_early = True
                break

        batch_end = min(cursor + batch_size, total_items)
        batch_items = normalized_items[cursor:batch_end]

        batch_config = dict(run_config)
        batch_config["max_errors"] = remaining_errors

        batch_outcome = process_batch(
            placeholder_module,
            batch_items,
            worker,
            config=batch_config,
            on_item_start=on_item_start,
            on_item_success=on_item_success,
            on_item_error=on_item_error,
            base_index=cursor,
        )

        all_results.extend(batch_outcome["results"])
        all_errors.extend(batch_outcome["errors"])

        next_index = batch_outcome["next_index"]
        cursor = next_index

        if batch_outcome["stopped_early"]:
            stopped_early = True
            break

        if run_config["stop_on_error"] and all_errors:
            stopped_early = True
            break

        if run_config["max_errors"] is not None and len(all_errors) >= run_config["max_errors"]:
            stopped_early = True
            break

    processed_items = max(next_index - normalized_start_index, 0)
    summary = build_summary(
        total_items=total_items,
        processed_items=processed_items,
        success_count=len(all_results),
        error_count=len(all_errors),
        stopped_early=stopped_early,
        start_index=normalized_start_index,
        next_index=next_index,
    )

    _safe_callback(on_stop, summary)

    ended_at = time.perf_counter()
    metrics = (
        _compute_metrics(started_at=started_at, ended_at=ended_at, processed_items=processed_items)
        if run_config["emit_metrics"]
        else {}
    )

    return _finalize_return(
        return_mode=return_mode,
        results=all_results,
        errors=all_errors,
        summary=summary,
        metrics=metrics,
        next_index=next_index,
    )
