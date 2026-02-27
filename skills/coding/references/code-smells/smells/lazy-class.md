---

description: Signals and refactoring directions for Lazy Class.
metadata:
  id: coding.ref.code-smells.smells.lazy-class
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - lazy class
    - references
    - smells
    - references code-smells smells lazy-class
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

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
