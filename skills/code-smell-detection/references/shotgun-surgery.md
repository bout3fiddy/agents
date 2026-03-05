# Shotgun Surgery

Category: Change Preventers

## Signals
- A single logical change requires edits across many files.
- Small related tweaks are scattered and hard to track.
- Regression risk rises from broad change surfaces.

## Common patterns to flag (anonymized)

Note: these snippets are examples. Real code often differs in syntax/structure; match on behavior and intent, not exact text.

### Single concept rename touches many layers

```pseudo
change customer_tier -> segment:
    update db schema + ORM mapping
    update API request/response contracts
    update validation rules
    update analytics event payloads
    update UI labels and filters
```

Reviewer heuristic: if one concept update needs scattered edits in many modules, ownership is fragmented.

## Typical refactor directions
- Move Method or Move Field.
- Inline Class.
- Consolidate ownership of related behavior.
