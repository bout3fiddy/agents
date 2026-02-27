---

description: Signals and refactoring directions for Dead Code.
metadata:
  id: coding.ref.code-smells.smells.dead-code
  version: "1"
  task_types:
    - coding
    - code-smell
  trigger_phrases:
    - code smells
    - dead code
    - references
    - smells
    - references code-smells smells dead-code
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---

# Dead Code

Category: Dispensables

## Signals
- Unreachable branches or unused functions remain in the codebase.
- Old flags and paths are never executed.
- Dead paths create noise and mislead reviewers.

## Common patterns to flag (anonymized)

Note: these snippets are examples. Real code often differs in syntax/structure; match on behavior and intent, not exact text.

### Branch that can never run

```pseudo
if feature_enabled("legacy_checkout") and ENV == "production":
    return legacy_checkout(order)

# feature flag is permanently false in all active environments
```

Reviewer heuristic: permanently disabled flags and unreferenced paths should be removed once rollout is complete.

## Typical refactor directions
- Remove unused code with tests and dependency checks.
- Delete obsolete flags and stale pathways.
