# Large Class

Category: Bloaters

## Signals
- A class owns too many fields or methods.
- Responsibilities are unrelated but co-located.
- Frequent changes touch unrelated class regions.

## Common patterns to flag (anonymized)

Note: these snippets are examples. Real code often differs in syntax/structure; match on behavior and intent, not exact text.

### God object with unrelated domains

```pseudo
class WorkspaceManager:
    # auth
    function issue_access_token(...)
    # billing
    function charge_invoice(...)
    # notifications
    function send_digest(...)
    # reporting
    function export_usage_csv(...)
```

Reviewer heuristic: if one class spans multiple business domains, it likely violates cohesion and should be split.

## Typical refactor directions
- Extract Class.
- Extract Interface.
- Move Method and Move Field.
