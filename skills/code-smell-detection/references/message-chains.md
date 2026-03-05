# Message Chains

Category: Couplers

## Signals
- Call sites contain long chained access (`a.b().c().d()`).
- Clients traverse object graphs directly.
- Structural changes ripple across consumers.

## Common patterns to flag (anonymized)

Note: these snippets are examples. Real code often differs in syntax/structure; match on behavior and intent, not exact text.

### Deep object graph traversal from callers

```pseudo
country = order.customer.profile.address.country.code
timezone = order.customer.profile.preferences.timezone
```

Reviewer heuristic: repeated deep chains from clients suggest missing facade/delegate methods near the data owner.

## Typical refactor directions
- Hide Delegate.
- Move Method to reduce traversal leakage.
