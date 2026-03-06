"""Warehouse inventory system.

Handles stock tracking, allocation, reservations, and basic reporting.
This module is the single entry point for all inventory operations.
"""

from __future__ import annotations

import time
import json
import hashlib
from datetime import datetime, timedelta

# ── Global state ──────────────────────────────────────────────────
_inventory: dict[str, dict] = {}
# key: sku, value: {"qty": int, "warehouse": str, "last_updated": float, "meta": dict}

_reservations: dict[str, dict] = {}
# key: reservation_id, value: {"sku": str, "qty": int, "status": str, "customer": str,
#   "created": float, "expires": float, "notes": str}

_allocation_log: list[dict] = []
# each entry: {"ts": float, "action": str, "sku": str, "qty": int, "detail": str}

_RESERVATION_TTL = 3600  # seconds
_LOW_STOCK_THRESHOLD = 10
_AUDIT_ENABLED = True


def _log(action: str, sku: str, qty: int, detail: str = "") -> None:
    if _AUDIT_ENABLED:
        _allocation_log.append({
            "ts": time.time(),
            "action": action,
            "sku": sku,
            "qty": qty,
            "detail": detail,
        })


def add_stock(sku: str, qty: int, warehouse: str, **meta) -> dict:
    """Add stock for a SKU. Returns the updated inventory record."""
    if qty <= 0:
        return {"error": "qty must be positive", "sku": sku}
    if sku in _inventory:
        _inventory[sku]["qty"] += qty
        _inventory[sku]["last_updated"] = time.time()
        _inventory[sku]["meta"].update(meta)
    else:
        _inventory[sku] = {
            "qty": qty,
            "warehouse": warehouse,
            "last_updated": time.time(),
            "meta": meta,
        }
    _log("add_stock", sku, qty, f"warehouse={warehouse}")
    return {"ok": True, "sku": sku, "qty": _inventory[sku]["qty"]}


def get_stock(sku: str) -> dict:
    """Return current stock info or error dict."""
    if sku not in _inventory:
        return {"error": "unknown sku", "sku": sku}
    rec = _inventory[sku]
    return {
        "sku": sku,
        "qty": rec["qty"],
        "warehouse": rec["warehouse"],
        "low_stock": rec["qty"] < _LOW_STOCK_THRESHOLD,
        "last_updated": rec["last_updated"],
    }


def reserve_stock(sku: str, qty: int, customer: str, notes: str = "") -> dict:
    """Create a reservation. Returns reservation dict or error dict."""
    if sku not in _inventory:
        return {"error": "unknown sku", "sku": sku}
    if _inventory[sku]["qty"] < qty:
        return {"error": "insufficient stock", "sku": sku, "available": _inventory[sku]["qty"]}
    if qty <= 0:
        return {"error": "qty must be positive"}

    reservation_id = hashlib.sha256(
        f"{sku}:{customer}:{time.time()}".encode()
    ).hexdigest()[:12]

    _inventory[sku]["qty"] -= qty
    _inventory[sku]["last_updated"] = time.time()

    _reservations[reservation_id] = {
        "sku": sku,
        "qty": qty,
        "status": "active",
        "customer": customer,
        "created": time.time(),
        "expires": time.time() + _RESERVATION_TTL,
        "notes": notes,
    }
    _log("reserve", sku, qty, f"customer={customer} res_id={reservation_id}")
    return {"ok": True, "reservation_id": reservation_id, "expires_in": _RESERVATION_TTL}


def confirm_reservation(reservation_id: str) -> dict:
    """Confirm a reservation, marking it fulfilled."""
    if reservation_id not in _reservations:
        return {"error": "unknown reservation", "reservation_id": reservation_id}
    res = _reservations[reservation_id]
    if res["status"] != "active":
        return {"error": f"reservation is {res['status']}", "reservation_id": reservation_id}
    if time.time() > res["expires"]:
        # expired — return stock
        _inventory[res["sku"]]["qty"] += res["qty"]
        res["status"] = "expired"
        _log("expire", res["sku"], res["qty"], f"res_id={reservation_id}")
        return {"error": "reservation expired", "reservation_id": reservation_id}
    res["status"] = "confirmed"
    _log("confirm", res["sku"], res["qty"], f"res_id={reservation_id}")
    return {"ok": True, "reservation_id": reservation_id}


def cancel_reservation(reservation_id: str) -> dict:
    """Cancel a reservation and return stock."""
    if reservation_id not in _reservations:
        return {"error": "unknown reservation", "reservation_id": reservation_id}
    res = _reservations[reservation_id]
    if res["status"] not in ("active",):
        return {"error": f"cannot cancel reservation in state {res['status']}"}
    _inventory[res["sku"]]["qty"] += res["qty"]
    _inventory[res["sku"]]["last_updated"] = time.time()
    res["status"] = "cancelled"
    _log("cancel", res["sku"], res["qty"], f"res_id={reservation_id}")
    return {"ok": True, "reservation_id": reservation_id}


def cleanup_expired_reservations() -> dict:
    """Expire stale reservations and return stock."""
    now = time.time()
    expired_count = 0
    returned_qty = 0
    for rid, res in _reservations.items():
        if res["status"] == "active" and now > res["expires"]:
            _inventory[res["sku"]]["qty"] += res["qty"]
            res["status"] = "expired"
            expired_count += 1
            returned_qty += res["qty"]
            _log("expire", res["sku"], res["qty"], f"res_id={rid} auto-cleanup")
    return {"expired": expired_count, "returned_qty": returned_qty}


def allocate_and_report(sku: str, qty: int, customer: str) -> str:
    """All-in-one: try to reserve, and produce a human-readable report.

    This is the main entry point used by the fulfillment service.
    Returns a formatted report string.
    """
    # Check stock
    stock = get_stock(sku)
    if "error" in stock:
        report_lines = [
            f"ALLOCATION REPORT — {datetime.now().isoformat()}",
            f"SKU: {sku}",
            f"Status: FAILED",
            f"Reason: {stock['error']}",
        ]
        return "\n".join(report_lines)

    # Try reservation
    result = reserve_stock(sku, qty, customer)
    if "error" in result:
        report_lines = [
            f"ALLOCATION REPORT — {datetime.now().isoformat()}",
            f"SKU: {sku}",
            f"Requested: {qty}",
            f"Available: {stock['qty']}",
            f"Status: FAILED",
            f"Reason: {result['error']}",
        ]
        if stock.get("low_stock"):
            report_lines.append("⚠ LOW STOCK WARNING")
        return "\n".join(report_lines)

    # Check post-allocation stock level
    post_stock = get_stock(sku)
    report_lines = [
        f"ALLOCATION REPORT — {datetime.now().isoformat()}",
        f"SKU: {sku}",
        f"Customer: {customer}",
        f"Reserved: {qty}",
        f"Reservation ID: {result['reservation_id']}",
        f"Expires in: {result['expires_in']}s",
        f"Remaining stock: {post_stock['qty']}",
        f"Status: SUCCESS",
    ]
    if post_stock.get("low_stock"):
        report_lines.append("⚠ LOW STOCK — reorder recommended")

    # Append recent log entries for this SKU
    recent = [e for e in _allocation_log if e["sku"] == sku][-5:]
    if recent:
        report_lines.append("")
        report_lines.append("Recent activity:")
        for entry in recent:
            ts = datetime.fromtimestamp(entry["ts"]).strftime("%H:%M:%S")
            report_lines.append(f"  [{ts}] {entry['action']}: qty={entry['qty']} {entry['detail']}")

    return "\n".join(report_lines)


def generate_inventory_summary() -> str:
    """Produce a full inventory + reservations summary report."""
    lines = [
        f"INVENTORY SUMMARY — {datetime.now().isoformat()}",
        f"{'SKU':<20} {'QTY':>6} {'WAREHOUSE':<15} {'LOW?':<5}",
        "-" * 50,
    ]
    for sku, rec in sorted(_inventory.items()):
        low = "YES" if rec["qty"] < _LOW_STOCK_THRESHOLD else ""
        lines.append(f"{sku:<20} {rec['qty']:>6} {rec['warehouse']:<15} {low:<5}")

    lines.append("")
    lines.append(f"ACTIVE RESERVATIONS")
    lines.append(f"{'ID':<14} {'SKU':<15} {'QTY':>5} {'CUSTOMER':<20} {'STATUS':<10}")
    lines.append("-" * 70)
    for rid, res in _reservations.items():
        if res["status"] == "active":
            lines.append(
                f"{rid:<14} {res['sku']:<15} {res['qty']:>5} {res['customer']:<20} {res['status']:<10}"
            )

    active_count = sum(1 for r in _reservations.values() if r["status"] == "active")
    total_reserved = sum(r["qty"] for r in _reservations.values() if r["status"] == "active")
    lines.append("")
    lines.append(f"Total active reservations: {active_count}")
    lines.append(f"Total reserved quantity: {total_reserved}")

    return "\n".join(lines)


def bulk_allocate(orders: list[dict]) -> list[dict]:
    """Process multiple allocation requests.

    Each order: {"sku": str, "qty": int, "customer": str}
    Returns list of result dicts.
    """
    results = []
    for order in orders:
        try:
            sku = order.get("sku", "")
            qty = order.get("qty", 0)
            customer = order.get("customer", "unknown")
            if not sku:
                results.append({"error": "missing sku", "order": order})
                continue
            result = reserve_stock(sku, qty, customer)
            results.append(result)
        except Exception:
            results.append({"error": "unexpected error", "order": order})
    return results


def reset_state() -> None:
    """Clear all state — used in tests."""
    _inventory.clear()
    _reservations.clear()
    _allocation_log.clear()
