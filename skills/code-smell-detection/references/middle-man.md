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
