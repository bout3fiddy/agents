# Long Method

Category: Bloaters

## Signals
- Methods are very long and blend multiple responsibilities.
- Control flow is deeply nested or hard to follow.
- Large inline branches hide intent.

## Common patterns to flag (anonymized)

Note: these snippets are examples. Real code often differs in syntax/structure; match on behavior and intent, not exact text.

### Multi-responsibility transaction script

```pseudo
function checkout(order):
    validate_cart(order)
    if has_invalid_coupon(order):
        recalculate_prices(order)
    reserve_inventory(order)
    charge_payment(order)
    write_order_rows(order)
    publish_order_events(order)
    send_receipt_email(order)
```

Reviewer heuristic: one method performing validation, pricing, persistence, and side effects is usually multiple methods fused together.

## Typical refactor directions
- Extract Method.
- Replace Temp with Query.
- Decompose Conditional.
