from __future__ import annotations

import time
import traceback
from typing import Any, Callable


def normalize_items(items):
    if items is None:
        return []
    if isinstance(items, list):
        return items
    try:
        return list(items)
    except TypeError:
        return [items]


def validate_run_config(
    *,
    retries=1,
    batch_size=10,
    max_errors=None,
    stop_on_error=False,
    include_error_trace=False,
    emit_metrics=True,
):
    if not isinstance(retries, int) or retries < 0:
        raise ValueError("retries must be a non-negative integer")
    if not isinstance(batch_size, int) or batch_size <= 0:
        raise ValueError("batch_size must be a positive integer")
    if max_errors is not None and (not isinstance(max_errors, int) or max_errors < 0):
        raise ValueError("max_errors must be None or a non-negative integer")
    if not isinstance(stop_on_error, bool):
        raise ValueError("stop_on_error must be a bool")
    if not isinstance(include_error_trace, bool):
        raise ValueError("include_error_trace must be a bool")
    if not isinstance(emit_metrics, bool):
        raise ValueError("emit_metrics must be a bool")

    return {
        "retries": retries,
        "batch_size": batch_size,
        "max_errors": max_errors,
        "stop_on_error": stop_on_error,
        "include_error_trace": include_error_trace,
        "emit_metrics": emit_metrics,
    }


def format_error_record(index, item, error, *, include_trace=False):
    record = {
        "index": index,
        "item": item,
        "error_type": type(error).__name__,
        "error_message": str(error),
    }
    if include_trace:
        record["traceback"] = traceback.format_exc()
    return record


def start_progress(placeholder_module, total_items, *, title=None):
    return placeholder_module.status.progress_bar(total=total_items, title=title)


def _safe_callback(callback, *args, **kwargs):
    if callback is None:
        return None
    try:
        return callback(*args, **kwargs)
    except TypeError:
        try:
            return callback(*args)
        except Exception:
            return None
    except Exception:
        return None


def _advance_progress(progress, step=1):
    if progress is None:
        return
    for method_name in ("update", "advance", "increment", "step"):
        fn = getattr(progress, method_name, None)
        if callable(fn):
            try:
                fn(step)
                return
            except TypeError:
                try:
                    fn()
                    return
                except Exception:
                    pass
            except Exception:
                pass


def run_worker_with_retry(worker, item, *, retries=1, on_error=None, config=None):
    cfg = validate_run_config() if config is None else validate_run_config(**config)
    retries = cfg["retries"] if retries is None else retries
    if not isinstance(retries, int) or retries < 0:
        raise ValueError("retries must be a non-negative integer")

    last_error = None
    attempts = retries + 1
    for attempt in range(1, attempts + 1):
        try:
            result = worker(item)
            return {"ok": True, "result": result, "error": None, "attempts": attempt}
        except Exception as exc:
            last_error = exc
            _safe_callback(on_error, exc, attempt, item)
            if attempt >= attempts:
                break

    return {"ok": False, "result": None, "error": last_error, "attempts": attempts}


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
        "success_count": success_count,
        "error_count": error_count,
        "stopped_early": bool(stopped_early),
        "start_index": start_index,
        "next_index": next_index,
    }


def _compute_metrics(start_time, end_time, processed_items):
    duration_ms = max(0.0, (end_time - start_time) * 1000.0)
    throughput = 0.0
    if duration_ms > 0:
        throughput = processed_items / (duration_ms / 1000.0)
    return {
        "duration_ms": duration_ms,
        "throughput_items_per_sec": throughput,
    }


def _should_stop_after_error(config, error_count):
    if config["stop_on_error"]:
        return True
    max_errors = config["max_errors"]
    if max_errors is not None and error_count >= max_errors:
        return True
    return False


def _finalize_return(return_mode, *, results, errors, summary, metrics, next_index):
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
    cfg = validate_run_config(**(config or {}))
    normalized = normalize_items(items)
    total_items = len(normalized)

    if start_index < 0:
        raise ValueError("start_index must be >= 0")
    next_index = min(start_index, total_items)

    progress = start_progress(placeholder_module, total_items, title=title)
    _safe_callback(on_start, {"total_items": total_items, "start_index": start_index, "progress": progress})

    results = []
    errors = []
    success_count = 0
    error_count = 0
    processed_items = 0
    stopped_early = False

    t0 = time.perf_counter()
    for index in range(start_index, total_items):
        if not placeholder_module.is_running():
            stopped_early = True
            break

        item = normalized[index]
        _safe_callback(on_item_start, index, item)

        run = run_worker_with_retry(worker, item, retries=cfg["retries"], config=cfg)
        if run["ok"]:
            results.append(run["result"])
            success_count += 1
            _safe_callback(on_item_success, index, item, run["result"])
        else:
            error_count += 1
            err = format_error_record(index, item, run["error"], include_trace=cfg["include_error_trace"])
            errors.append(err)
            _safe_callback(on_item_error, index, item, err)
            if _should_stop_after_error(cfg, error_count):
                processed_items += 1
                next_index = index + 1
                _advance_progress(progress, 1)
                stopped_early = True
                break

        processed_items += 1
        next_index = index + 1
        _advance_progress(progress, 1)

    t1 = time.perf_counter()

    summary = build_summary(
        total_items=total_items,
        processed_items=processed_items,
        success_count=success_count,
        error_count=error_count,
        stopped_early=stopped_early,
        start_index=start_index,
        next_index=next_index,
    )
    metrics = _compute_metrics(t0, t1, processed_items) if cfg["emit_metrics"] else {}

    _safe_callback(on_stop, summary)

    return _finalize_return(
        return_mode,
        results=results,
        errors=errors,
        summary=summary,
        metrics=metrics,
        next_index=next_index,
    )


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
    cfg = validate_run_config(**(config or {}))
    normalized = normalize_items(batch_items)

    results = []
    errors = []
    success_count = 0
    error_count = 0
    processed_items = 0
    stopped_early = False
    next_index = base_index

    for offset, item in enumerate(normalized):
        index = base_index + offset
        if not placeholder_module.is_running():
            stopped_early = True
            break

        _safe_callback(on_item_start, index, item)
        run = run_worker_with_retry(worker, item, retries=cfg["retries"], config=cfg)
        if run["ok"]:
            results.append(run["result"])
            success_count += 1
            _safe_callback(on_item_success, index, item, run["result"])
        else:
            error_count += 1
            err = format_error_record(index, item, run["error"], include_trace=cfg["include_error_trace"])
            errors.append(err)
            _safe_callback(on_item_error, index, item, err)
            if _should_stop_after_error(cfg, error_count):
                processed_items += 1
                next_index = index + 1
                stopped_early = True
                break

        processed_items += 1
        next_index = index + 1

    return {
        "results": results,
        "errors": errors,
        "processed_items": processed_items,
        "success_count": success_count,
        "error_count": error_count,
        "stopped_early": stopped_early,
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
    cfg = validate_run_config(**(config or {}))
    normalized = normalize_items(items)
    total_items = len(normalized)

    if start_index < 0:
        raise ValueError("start_index must be >= 0")
    next_index = min(start_index, total_items)

    progress = start_progress(placeholder_module, total_items, title=title)
    _safe_callback(on_start, {"total_items": total_items, "start_index": start_index, "progress": progress})

    results = []
    errors = []
    processed_items = 0
    success_count = 0
    error_count = 0
    stopped_early = False

    t0 = time.perf_counter()

    idx = start_index
    while idx < total_items:
        if not placeholder_module.is_running():
            stopped_early = True
            break

        batch_end = min(idx + cfg["batch_size"], total_items)
        batch = normalized[idx:batch_end]
        batch_result = process_batch(
            placeholder_module,
            batch,
            worker,
            config=cfg,
            on_item_start=on_item_start,
            on_item_success=on_item_success,
            on_item_error=on_item_error,
            base_index=idx,
        )

        results.extend(batch_result["results"])
        errors.extend(batch_result["errors"])
        processed_items += batch_result["processed_items"]
        success_count += batch_result["success_count"]
        error_count += batch_result["error_count"]
        next_index = batch_result["next_index"]

        _advance_progress(progress, batch_result["processed_items"])

        if batch_result["stopped_early"]:
            stopped_early = True
            break

        idx = batch_end

    t1 = time.perf_counter()

    summary = build_summary(
        total_items=total_items,
        processed_items=processed_items,
        success_count=success_count,
        error_count=error_count,
        stopped_early=stopped_early,
        start_index=start_index,
        next_index=next_index,
    )
    metrics = _compute_metrics(t0, t1, processed_items) if cfg["emit_metrics"] else {}

    _safe_callback(on_stop, summary)

    return _finalize_return(
        return_mode,
        results=results,
        errors=errors,
        summary=summary,
        metrics=metrics,
        next_index=next_index,
    )
