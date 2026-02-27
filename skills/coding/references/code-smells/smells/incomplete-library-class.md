---

description: Signals and refactoring directions for Incomplete Library Class.
metadata:
  id: coding.ref.code-smells.smells.incomplete-library-class
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - incomplete library class
    - references
    - smells
    - references code-smells smells incomplete-library-class
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

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
