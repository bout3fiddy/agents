---

description: Signals and refactoring directions for Alternative Classes with Different Interfaces.
metadata:
  id: coding.ref.code-smells.smells.alternative-classes-with-different-interfaces
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - alternative classes with different interfaces
    - code smells
    - references
    - smells
    - references code-smells smells alternative-classes-with-different-interfaces
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

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
