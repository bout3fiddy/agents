# Lazy Class

Category: Dispensables

## Signals
- A class adds little behavior beyond indirection.
- Type boundaries exist without meaningful responsibility.
- Maintenance overhead exceeds its value.

## Common patterns to flag (anonymized)

Note: these snippets are examples. Real code often differs in syntax/structure; match on behavior and intent, not exact text.

### Wrapper with almost no value

```pseudo
class UsernameFormatter:
    function format(name):
        return NameFormatter.format(name)
```

Reviewer heuristic: classes that mostly pass through to another type without adding policy or invariants are often removable.

## Typical refactor directions
- Inline Class.
- Collapse Hierarchy.
