# Data Class

Category: Dispensables

## Signals
- Class mostly contains fields with trivial getters/setters.
- Behavior that should live with data appears elsewhere.
- Invariants are enforced outside the owning type.

## Common patterns to flag (anonymized)

Note: these snippets are examples. Real code often differs in syntax/structure; match on behavior and intent, not exact text.

### Passive data holder with external business logic

```pseudo
class Invoice:
    amount
    currency
    status

function mark_paid(invoice):
    if invoice.amount <= 0:
        raise ValidationError
    invoice.status = "paid"
```

Reviewer heuristic: when data validation and state transitions live outside the data owner, the type is usually an anemic model.

## Typical refactor directions
- Move behavior to the data owner.
- Encapsulate field access and enforce invariants internally.
