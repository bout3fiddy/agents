from __future__ import annotations

from time import perf_counter
from traceback import format_exception


def normalize_items(items):
    if items is None:
        return []
    if isinstance(items, list):
        return items
    return list(items)


def validate_run_config(
    *,
    retries=1,
    batch_size=10,
    max_errors=None,
    stop_on_error=False,
    include_error_trace=False,
    emit_metrics=True,
):
    retries = int(retries)
    batch_size = int(batch_size)

    if retries < 0:
        raise ValueError("retries must be >= 0")
    if batch_size <= 0:
        raise ValueError("batch_size must be > 0")

    if max_errors is not None:
        max_errors = int(max_errors)
        if max_errors < 0:
            raise ValueError("max_errors must be >= 0 when provided")

    return {
        "retries": retries,
        "batch_size": batch_size,
        "max_errors": max_errors,
        "stop_on_error": bool(stop_on_error),
        "include_error_trace": bool(include_error_trace),
        "emit_metrics": bool(emit_metrics),
    }


def format_error_record(index, item, error, *, include_trace=False):
    record = {
        "index": index,
        "item": item,
        "error": str(error),
        "error_type": type(error).__name__,
    }
    if include_trace:
        record["trace"] = "".join(format_exception(type(error), error, error.__traceback__))
    return record


def start_progress(placeholder_module, total_items, *, title=None):
    return placeholder_module.status.progress_bar(total=total_items, title=title)


def run_worker_with_retry(worker, item, *, retries=1, on_error=None, config=None):
    cfg = validate_run_config(retries=retries) if config is None else validate_run_config(**config)

    for attempt in range(cfg["retries"] + 1):
        try:
            return True, worker(item), None
        except Exception as error:  # noqa: BLE001
            if attempt == cfg["retries"]:
                if on_error is not None:
                    on_error(item, error)
                return False, None, error

    return False, None, RuntimeError("unreachable retry loop state")


def build_summary(
    *,
    total_items,
    processed_items,
    success_count,
    error_count,
    stopped_early,
    start_index,
    next_index,
):
    return {
        "total_items": total_items,
        "processed_items": processed_items,
        "remaining_items": max(0, total_items - next_index),
        "success_count": success_count,
        "error_count": error_count,
        "stopped_early": bool(stopped_early),
        "start_index": start_index,
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
    cfg = validate_run_config() if config is None else validate_run_config(**config)

    results = []
    errors = []
    processed_items = 0
    success_count = 0
    error_count = 0
    stopped_early = False
    next_index = base_index

    for offset, item in enumerate(batch_items):
        index = base_index + offset

        if not placeholder_module.is_running():
            stopped_early = True
            next_index = index
            break

        if on_item_start is not None:
            on_item_start(index, item)

        ok, value, error = run_worker_with_retry(
            worker,
            item,
            retries=cfg["retries"],
            config=cfg,
        )

        processed_items += 1
        next_index = index + 1

        if ok:
            success_count += 1
            results.append(value)
            if on_item_success is not None:
                on_item_success(index, item, value)
            continue

        error_count += 1
        record = format_error_record(index, item, error, include_trace=cfg["include_error_trace"])
        errors.append(record)

        if on_item_error is not None:
            on_item_error(record)

        if cfg["stop_on_error"]:
            stopped_early = True
            break

        if cfg["max_errors"] is not None and error_count >= cfg["max_errors"]:
            stopped_early = True
            break

    return {
        "results": results,
        "errors": errors,
        "processed_items": processed_items,
        "success_count": success_count,
        "error_count": error_count,
        "stopped_early": stopped_early,
        "next_index": next_index,
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
    cfg = validate_run_config() if config is None else validate_run_config(**config)
    items_list = normalize_items(items)
    total_items = len(items_list)

    if start_index < 0 or start_index > total_items:
        raise ValueError("start_index must be within [0, len(items)]")

    remaining_items = items_list[start_index:]
    start_progress(placeholder_module, len(remaining_items), title=title)

    if on_start is not None:
        on_start(total_items=total_items, start_index=start_index)

    started_at = perf_counter()
    batch_result = process_batch(
        placeholder_module,
        remaining_items,
        worker,
        config=cfg,
        on_item_start=on_item_start,
        on_item_success=on_item_success,
        on_item_error=on_item_error,
        base_index=start_index,
    )
    duration_s = perf_counter() - started_at

    next_index = batch_result["next_index"]
    stopped_early = batch_result["stopped_early"] or next_index < total_items

    summary = build_summary(
        total_items=total_items,
        processed_items=batch_result["processed_items"],
        success_count=batch_result["success_count"],
        error_count=batch_result["error_count"],
        stopped_early=stopped_early,
        start_index=start_index,
        next_index=next_index,
    )

    metrics = {
        "duration_ms": round(duration_s * 1000, 3),
        "throughput_items_per_sec": 0.0 if duration_s <= 0 else round(batch_result["processed_items"] / duration_s, 3),
    }

    if stopped_early and on_stop is not None:
        on_stop(summary)

    if return_mode in {"summary", "summary-only"}:
        return summary
    if return_mode in {"results", "results-only"}:
        return batch_result["results"]

    return {
        "results": batch_result["results"],
        "errors": batch_result["errors"],
        "summary": summary,
        "metrics": metrics if cfg["emit_metrics"] else {},
        "next_index": next_index,
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
    cfg = validate_run_config() if config is None else validate_run_config(**config)
    items_list = normalize_items(items)
    total_items = len(items_list)

    if start_index < 0 or start_index > total_items:
        raise ValueError("start_index must be within [0, len(items)]")

    start_progress(placeholder_module, total_items - start_index, title=title)

    if on_start is not None:
        on_start(total_items=total_items, start_index=start_index)

    started_at = perf_counter()

    results = []
    errors = []
    processed_items = 0
    success_count = 0
    error_count = 0
    stopped_early = False
    next_index = start_index

    while next_index < total_items:
        if not placeholder_module.is_running():
            stopped_early = True
            break

        batch_end = min(next_index + cfg["batch_size"], total_items)
        batch_items = items_list[next_index:batch_end]

        batch_max_errors = None
        if cfg["max_errors"] is not None:
            batch_max_errors = max(0, cfg["max_errors"] - error_count)

        batch_cfg = {
            **cfg,
            "max_errors": batch_max_errors,
        }

        batch_result = process_batch(
            placeholder_module,
            batch_items,
            worker,
            config=batch_cfg,
            on_item_start=on_item_start,
            on_item_success=on_item_success,
            on_item_error=on_item_error,
            base_index=next_index,
        )

        results.extend(batch_result["results"])
        errors.extend(batch_result["errors"])
        processed_items += batch_result["processed_items"]
        success_count += batch_result["success_count"]
        error_count += batch_result["error_count"]
        next_index = batch_result["next_index"]

        if batch_result["stopped_early"]:
            stopped_early = True
            break

        if cfg["max_errors"] is not None and error_count >= cfg["max_errors"]:
            stopped_early = True
            break

    duration_s = perf_counter() - started_at
    stopped_early = stopped_early or next_index < total_items

    summary = build_summary(
        total_items=total_items,
        processed_items=processed_items,
        success_count=success_count,
        error_count=error_count,
        stopped_early=stopped_early,
        start_index=start_index,
        next_index=next_index,
    )

    metrics = {
        "duration_ms": round(duration_s * 1000, 3),
        "throughput_items_per_sec": 0.0 if duration_s <= 0 else round(processed_items / duration_s, 3),
    }

    if stopped_early and on_stop is not None:
        on_stop(summary)

    if return_mode in {"summary", "summary-only"}:
        return summary
    if return_mode in {"results", "results-only"}:
        return results

    return {
        "results": results,
        "errors": errors,
        "summary": summary,
        "metrics": metrics if cfg["emit_metrics"] else {},
        "next_index": next_index,
    }
