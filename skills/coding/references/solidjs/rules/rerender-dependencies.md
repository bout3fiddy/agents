---

title: Narrow Reactive Dependencies
impact: MEDIUM
impactDescription: minimizes recomputation
tags: reactivity, dependencies, optimization
metadata:
  id: coding.ref.solidjs.rules.rerender-dependencies
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - references
    - rerender dependencies
    - rules
    - solidjs
    - references solidjs rules rerender-dependencies
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Narrow Reactive Dependencies

**Impact: MEDIUM (minimizes recomputation)**

Narrow reactive dependencies by deriving booleans or primitives before effects.

**Incorrect:**

```ts
createEffect(() => { if (width() < 768) enableMobile() })
```

**Correct:**

```ts
const isMobile = createMemo(() => width() < 768)
createEffect(() => isMobile() && enableMobile())
```
