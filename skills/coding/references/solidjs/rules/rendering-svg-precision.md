---

title: Optimize SVG Precision
impact: MEDIUM
impactDescription: reduces file size
tags: rendering, svg, optimization, svgo
metadata:
  id: coding.ref.solidjs.rules.rendering-svg-precision
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - references
    - rendering svg precision
    - rules
    - solidjs
    - references solidjs rules rendering-svg-precision
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Optimize SVG Precision

**Impact: MEDIUM (reduces file size)**

Reduce SVG coordinate precision to cut payload size.

**Incorrect:**

```ts
<path d="M 10.293847 20.847362 L 30.938472 40.192837" />
```

**Correct:**

```ts
<path d="M 10.3 20.8 L 30.9 40.2" />
```
