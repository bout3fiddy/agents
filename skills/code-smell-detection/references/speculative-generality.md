# Speculative Generality

Category: Dispensables

## Signals
- Abstractions exist for hypothetical future use only.
- Hooks and extension points are unused over time.
- Complexity is paid now for uncertain value later.

## Common patterns to flag (anonymized)

Note: these snippets are examples. Real code often differs in syntax/structure; match on behavior and intent, not exact text.

### Extension framework with no real consumers

```pseudo
interface CheckoutPlugin:
    before_validate(order)
    after_validate(order)
    before_charge(order)
    after_charge(order)

# only one implementation uses one hook
```

Reviewer heuristic: when generic extension points remain mostly unused, concrete implementations are often clearer.

## Typical refactor directions
- Inline Class or Inline Method.
- Remove unused abstraction and simplify.
