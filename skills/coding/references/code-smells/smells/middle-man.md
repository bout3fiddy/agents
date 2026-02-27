---

description: Signals and refactoring directions for Middle Man.
metadata:
  id: coding.ref.code-smells.smells.middle-man
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - middle man
    - references
    - smells
    - references code-smells smells middle-man
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Middle Man

Category: Couplers

## Signals
- A class mostly forwards calls to another class.
- Wrapper adds little domain value.
- Indirection increases call depth without benefit.

## Common patterns to flag (anonymized)

Note: these snippets are examples. Real code often differs in syntax/structure; match on behavior and intent, not exact text.

### Pass-through facade

```pseudo
class OrderFacade:
    function total():
        return order.total()

    function items():
        return order.items()
```

Reviewer heuristic: if nearly every method only delegates without policy, remove or merge the wrapper.

## Typical refactor directions
- Remove Middle Man.
- Inline simple delegation.
