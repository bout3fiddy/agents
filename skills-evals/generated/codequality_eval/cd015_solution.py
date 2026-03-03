from __future__ import annotations

import time
import traceback
from typing import Any


def normalize_items(items: Any) -> list[Any]:
    if items is None:
        return []
    if isinstance(items, list):
        return items
    try:
        return list(items)
    except TypeError as exc:
        raise TypeError("items must be an iterable or None") from exc


def validate_run_config(
    *,
    retries: int = 1,
    batch_size: int = 10,
    max_errors: int | None = None,
    stop_on_error: bool = False,
    include_error_trace: bool = False,
    emit_metrics: bool = True,
) -> dict[str, Any]:
    if not isinstance(retries, int) or retries < 1:
        raise ValueError("retries must be an integer >= 1")
    if not isinstance(batch_size, int) or batch_size < 1:
        raise ValueError("batch_size must be an integer >= 1")
    if max_errors is not None and (not isinstance(max_errors, int) or max_errors < 0):
        raise ValueError("max_errors must be None or an integer >= 0")

    return {
        "retries": retries,
        "batch_size": batch_size,
        "max_errors": max_errors,
        "stop_on_error": bool(stop_on_error),
        "include_error_trace": bool(include_error_trace),
        "emit_metrics": bool(emit_metrics),
    }


def format_error_record(index: int, item: Any, error: Exception, *, include_trace: bool = False) -> dict[str, Any]:
    record: dict[str, Any] = {
        "index": index,
        "item": item,
        "error_type": type(error).__name__,
        "error_message": str(error),
    }
    if include_trace:
        record["traceback"] = "".join(traceback.format_exception(type(error), error, error.__traceback__))
    return record


def start_progress(placeholder_module: Any, total_items: int, *, title: str | None = None) -> Any:
    return placeholder_module.status.progress_bar(total=total_items, title=title)


def run_worker_with_retry(
    worker,
    item,
    *,
    retries: int = 1,
    on_error=None,
    config: dict[str, Any] | None = None,
):
    if config and retries == 1 and "retries" in config:
        retries = config["retries"]

    last_error: Exception | None = None
    for attempt in range(1, retries + 1):
        try:
            return worker(item), None, attempt
        except Exception as exc:  # noqa: BLE001
            last_error = exc
            if on_error is not None:
                on_error(exc, attempt)
            if attempt >= retries:
                break
    return None, last_error, retries


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
        "total_items": total_items,
        "processed_items": processed_items,
        "success_count": success_count,
        "error_count": error_count,
        "stopped_early": stopped_early,
        "start_index": start_index,
        "next_index": next_index,
    }


def _should_stop_after_error(config: dict[str, Any], error_count: int) -> bool:
    if config["stop_on_error"] and error_count > 0:
        return True
    max_errors = config["max_errors"]
    if max_errors is not None and error_count >= max_errors:
        return True
    return False


def _metrics(start_time: float, processed_items: int, emit_metrics: bool) -> dict[str, Any] | None:
    if not emit_metrics:
        return None
    elapsed_sec = max(0.0, time.perf_counter() - start_time)
    duration_ms = elapsed_sec * 1000.0
    throughput = (processed_items / elapsed_sec) if elapsed_sec > 0 else 0.0
    return {
        "duration_ms": duration_ms,
        "throughput_items_per_sec": throughput,
    }


def map_with_progress(
    placeholder_module,
    items,
    worker,
    *,
    title=None,
    config=None,
    on_start=None,
    on_item_start=None,
    on_item_success=None,
    on_item_error=None,
    on_stop=None,
    start_index=0,
    return_mode="full",
):
    run_config = validate_run_config(**(config or {}))
    items_list = normalize_items(items)
    total_items = len(items_list)
    start_index = max(0, min(start_index, total_items))

    if on_start is not None:
        on_start(total_items, start_index)

    start_time = time.perf_counter()
    start_progress(placeholder_module, total_items, title=title)

    results: list[Any] = []
    errors: list[dict[str, Any]] = []
    processed_items = 0
    stopped_early = False

    index = start_index
    while index < total_items:
        if not placeholder_module.is_running():
            stopped_early = True
            break

        item = items_list[index]
        if on_item_start is not None:
            on_item_start(index, item)

        result, error, _attempts = run_worker_with_retry(
            worker,
            item,
            retries=run_config["retries"],
            config=run_config,
        )

        processed_items += 1

        if error is None:
            results.append(result)
            if on_item_success is not None:
                on_item_success(index, item, result)
        else:
            error_record = format_error_record(
                index,
                item,
                error,
                include_trace=run_config["include_error_trace"],
            )
            errors.append(error_record)
            if on_item_error is not None:
                on_item_error(index, item, error_record)
            if _should_stop_after_error(run_config, len(errors)):
                stopped_early = True
                index += 1
                break

        index += 1

    next_index = index
    success_count = len(results)
    error_count = len(errors)
    summary = build_summary(
        total_items=total_items,
        processed_items=processed_items,
        success_count=success_count,
        error_count=error_count,
        stopped_early=stopped_early,
        start_index=start_index,
        next_index=next_index,
    )
    metrics = _metrics(start_time, processed_items, run_config["emit_metrics"])

    if on_stop is not None:
        on_stop(summary)

    if return_mode == "summary-only":
        return summary
    if return_mode == "results-only":
        return results

    return {
        "results": results,
        "errors": errors,
        "summary": summary,
        "metrics": metrics,
        "next_index": next_index,
    }


def process_batch(
    placeholder_module,
    batch_items,
    worker,
    *,
    config=None,
    on_item_start=None,
    on_item_success=None,
    on_item_error=None,
    base_index=0,
):
    run_config = validate_run_config(**(config or {}))
    batch_list = normalize_items(batch_items)

    results: list[Any] = []
    errors: list[dict[str, Any]] = []
    processed_items = 0
    stopped_early = False

    offset = 0
    while offset < len(batch_list):
        if not placeholder_module.is_running():
            stopped_early = True
            break

        index = base_index + offset
        item = batch_list[offset]

        if on_item_start is not None:
            on_item_start(index, item)

        result, error, _attempts = run_worker_with_retry(
            worker,
            item,
            retries=run_config["retries"],
            config=run_config,
        )

        processed_items += 1

        if error is None:
            results.append(result)
            if on_item_success is not None:
                on_item_success(index, item, result)
        else:
            error_record = format_error_record(
                index,
                item,
                error,
                include_trace=run_config["include_error_trace"],
            )
            errors.append(error_record)
            if on_item_error is not None:
                on_item_error(index, item, error_record)
            if _should_stop_after_error(run_config, len(errors)):
                stopped_early = True
                offset += 1
                break

        offset += 1

    return {
        "results": results,
        "errors": errors,
        "processed_items": processed_items,
        "success_count": len(results),
        "error_count": len(errors),
        "stopped_early": stopped_early,
        "next_index": base_index + offset,
    }


def map_with_progress_batched(
    placeholder_module,
    items,
    worker,
    *,
    title=None,
    config=None,
    on_start=None,
    on_item_start=None,
    on_item_success=None,
    on_item_error=None,
    on_stop=None,
    start_index=0,
    return_mode="full",
):
    run_config = validate_run_config(**(config or {}))
    items_list = normalize_items(items)
    total_items = len(items_list)
    start_index = max(0, min(start_index, total_items))

    if on_start is not None:
        on_start(total_items, start_index)

    start_time = time.perf_counter()
    start_progress(placeholder_module, total_items, title=title)

    results: list[Any] = []
    errors: list[dict[str, Any]] = []
    processed_items = 0
    stopped_early = False

    index = start_index
    while index < total_items:
        if not placeholder_module.is_running():
            stopped_early = True
            break

        batch_end = min(total_items, index + run_config["batch_size"])
        batch_outcome = process_batch(
            placeholder_module,
            items_list[index:batch_end],
            worker,
            config=run_config,
            on_item_start=on_item_start,
            on_item_success=on_item_success,
            on_item_error=on_item_error,
            base_index=index,
        )

        results.extend(batch_outcome["results"])
        errors.extend(batch_outcome["errors"])
        processed_items += batch_outcome["processed_items"]

        if batch_outcome["stopped_early"]:
            stopped_early = True
            index = batch_outcome["next_index"]
            break

        if _should_stop_after_error(run_config, len(errors)):
            stopped_early = True
            index = batch_outcome["next_index"]
            break

        index = batch_end

    next_index = index
    summary = build_summary(
        total_items=total_items,
        processed_items=processed_items,
        success_count=len(results),
        error_count=len(errors),
        stopped_early=stopped_early,
        start_index=start_index,
        next_index=next_index,
    )
    metrics = _metrics(start_time, processed_items, run_config["emit_metrics"])

    if on_stop is not None:
        on_stop(summary)

    if return_mode == "summary-only":
        return summary
    if return_mode == "results-only":
        return results

    return {
        "results": results,
        "errors": errors,
        "summary": summary,
        "metrics": metrics,
        "next_index": next_index,
    }
