# Incomplete Library Class

Category: Couplers

## Signals
- Repeated library wrappers appear across the codebase.
- Missing library capabilities require scattered workarounds.
- Usage inconsistencies increase maintenance risk.

## Common patterns to flag (anonymized)

Note: these snippets are examples. Real code often differs in syntax/structure; match on behavior and intent, not exact text.

### Same library workaround copied at call sites

```pseudo
parsed = csv_lib.parse(raw)
if parsed.headers is null:
    parsed.headers = DEFAULT_HEADERS
if parsed.timeout is null:
    parsed.timeout = 30
```

Reviewer heuristic: repeated post-processing around third-party APIs should be centralized in a dedicated adapter or extension layer.

## Typical refactor directions
- Introduce a focused extension/adapter layer.
- Centralize library workarounds in one module.
