# Duplicate Code

Category: Dispensables

## Signals
- Similar logic is copied across modules or services.
- Bug fixes must be repeated in multiple places.
- Slightly diverged copies hide shared intent.

## Common patterns to flag (anonymized)

Note: these snippets are examples. Real code often differs in syntax/structure; match on behavior and intent, not exact text.

### Near-copy business logic in two services

```pseudo
function price_for_checkout(cart):
    subtotal = sum(item.price * item.qty for item in cart.items)
    tax = subtotal * 0.0825
    return subtotal + tax

function price_for_quote(cart):
    subtotal = sum(line.price * line.qty for line in cart.lines)
    tax = subtotal * 0.0825
    return subtotal + tax
```

Reviewer heuristic: similar structure with only variable renames usually means behavior should be extracted once.

## Typical refactor directions
- Extract Method.
- Pull Up Method.
- Consolidate shared utilities or core primitives.
