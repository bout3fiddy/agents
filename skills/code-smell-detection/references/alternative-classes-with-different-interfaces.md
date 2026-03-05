# Alternative Classes with Different Interfaces

Category: Object-Orientation Abusers

## Signals
- Classes provide similar capabilities with incompatible APIs.
- Callers need adapter-like glue at many call sites.
- Teams duplicate logic per implementation due to naming mismatch.

## Common patterns to flag (anonymized)

Note: these snippets are examples. Real code often differs in syntax/structure; match on behavior and intent, not exact text.

### Equivalent capability, incompatible signatures

```pseudo
stripe.charge(amount_cents, currency)
adyen.capture(amount_minor, iso_currency, merchant_ref)
```

Reviewer heuristic: when callers branch on provider just to map argument shape/naming, normalize behind one interface.

## Typical refactor directions
- Rename Method.
- Move Method.
- Introduce Adapter.
