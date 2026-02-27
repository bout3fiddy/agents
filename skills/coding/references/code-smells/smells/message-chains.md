---

description: Signals and refactoring directions for Message Chains.
metadata:
  id: coding.ref.code-smells.smells.message-chains
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - message chains
    - references
    - smells
    - references code-smells smells message-chains
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

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
