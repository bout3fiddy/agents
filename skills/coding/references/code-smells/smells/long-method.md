---

description: Signals and refactoring directions for Long Method.
metadata:
  id: coding.ref.code-smells.smells.long-method
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - long method
    - references
    - smells
    - references code-smells smells long-method
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

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
