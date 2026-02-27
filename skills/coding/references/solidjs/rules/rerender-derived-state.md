---

title: Subscribe to Derived State
impact: MEDIUM
impactDescription: reduces reactive notifications
tags: reactivity, derived-state, media-query, optimization
metadata:
  id: coding.ref.solidjs.rules.rerender-derived-state
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - references
    - rerender derived state
    - rules
    - solidjs
    - references solidjs rules rerender-derived-state
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Subscribe to Derived State

**Impact: MEDIUM (reduces reactive notifications)**

Subscribe to derived state instead of raw values to reduce update frequency.

**Incorrect:**

```ts
const isMobile = width() < 768
```

**Correct:**

```ts
const isMobile = createMemo(() => width() < 768)
```
