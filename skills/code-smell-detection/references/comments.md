# Comments

Category: Dispensables

## Signals
- Comments explain confusing code instead of intent.
- Stale comments disagree with actual behavior.
- Commented-out code accumulates as dead history.

## Common patterns to flag (anonymized)

Note: these snippets are examples. Real code often differs in syntax/structure; match on behavior and intent, not exact text.

### Comment and behavior drift

```pseudo
# sorts newest first
records = sort_by_created_at_ascending(records)
```

Reviewer heuristic: when the comment explains behavior incorrectly, the source of truth is unclear and reviews become error-prone.

## Typical refactor directions
- Rename symbols and extract expressive methods.
- Remove dead/commented-out code.
- Keep comments for intent and constraints, not patching unclear code.
