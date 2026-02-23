from __future__ import annotations


def calc_total_with_tax(price: float, tax_rate: float, discount: float) -> float:
    total = price
    if discount > 0:
        total = total - discount
    tax = total * tax_rate
    result = total + tax
    if result < 0:
        return 0.0
    return round(result, 2)


def calc_total_with_fee(price: float, fee_rate: float, discount: float) -> float:
    total = price
    if discount > 0:
        total = total - discount
    fee = total * fee_rate
    result = total + fee
    if result < 0:
        return 0.0
    return round(result, 2)


def update_order_shipping(order: dict, new_address: str) -> dict:
    order["shipping_address"] = new_address
    order["shipping_updated"] = True
    order["timeline"] = order.get("timeline", [])
    order["timeline"].append("shipping_updated")
    order["needs_reindex"] = True
    order["send_notification"] = True
    order["audit_reason"] = "shipping update"
    return order


def update_order_billing(order: dict, new_address: str) -> dict:
    order["billing_address"] = new_address
    order["billing_updated"] = True
    order["timeline"] = order.get("timeline", [])
    order["timeline"].append("billing_updated")
    order["needs_reindex"] = True
    order["send_notification"] = True
    order["audit_reason"] = "billing update"
    return order
