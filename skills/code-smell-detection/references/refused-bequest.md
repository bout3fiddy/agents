# Refused Bequest

Category: Object-Orientation Abusers

## Signals
- Subclasses inherit members they do not use.
- Overrides exist mainly to disable base behavior.
- Inheritance relationship does not model reality.

## Common patterns to flag (anonymized)

Note: these snippets are examples. Real code often differs in syntax/structure; match on behavior and intent, not exact text.

### Subclass disabling parent contract

```pseudo
class Bird:
    function fly():
        ...

class Penguin extends Bird:
    function fly():
        raise UnsupportedOperationError
```

Reviewer heuristic: if subclasses override base behavior mainly to reject it, inheritance is likely the wrong model.

## Typical refactor directions
- Replace Inheritance with Delegation.
- Push Down Method or Push Down Field.
