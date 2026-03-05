# Temporary Field

Category: Object-Orientation Abusers

## Signals
- Some fields are only meaningful in rare execution paths.
- Many methods must guard against null or unset state.
- Class invariants are unclear outside narrow contexts.

## Common patterns to flag (anonymized)

Note: these snippets are examples. Real code often differs in syntax/structure; match on behavior and intent, not exact text.

### Field used only in one workflow branch

```pseudo
class ReportBuilder:
    temp_csv_buffer = null

    function build_pdf(data):
        return render_pdf(data)

    function build_csv(data):
        temp_csv_buffer = transform_to_rows(data)
        return write_csv(temp_csv_buffer)
```

Reviewer heuristic: fields that exist only for one mode/branch often indicate missing extracted object for that workflow.

## Typical refactor directions
- Extract Class.
- Introduce Null Object.
