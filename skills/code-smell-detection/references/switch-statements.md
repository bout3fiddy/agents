# Switch Statements

Category: Object-Orientation Abusers

## Signals
- Similar switch or if/else type dispatch appears across files.
- Branches grow when new types are added.
- Behavior is selected by codes instead of object behavior.

## Common patterns to flag (anonymized)

Note: these snippets are examples. Real code often differs in syntax/structure; match on behavior and intent, not exact text.

### Repeated type dispatch

```pseudo
if report_type == "pdf":
    return render_pdf(report)
elif report_type == "csv":
    return render_csv(report)
elif report_type == "json":
    return render_json(report)
```

Reviewer heuristic: when the same type code drives behavior in multiple locations, polymorphism or strategy is usually clearer.

## Typical refactor directions
- Replace Conditional with Polymorphism.
- Replace Type Code with Subclasses, State, or Strategy.
