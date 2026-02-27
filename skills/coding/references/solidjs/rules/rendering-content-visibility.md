---

title: CSS content-visibility for Long Lists
impact: MEDIUM
impactDescription: 10× faster initial render
tags: rendering, css, content-visibility, long-lists
metadata:
  id: coding.ref.solidjs.rules.rendering-content-visibility
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - references
    - rendering content visibility
    - rules
    - solidjs
    - references solidjs rules rendering-content-visibility
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## CSS content-visibility for Long Lists

**Impact: MEDIUM (10× faster initial render)**

Use content-visibility to defer off‑screen rendering for long lists.

**Incorrect:**

```ts
.row { }
```

**Correct:**

```ts
.row { content-visibility: auto; contain-intrinsic-size: 0 80px; }
```
