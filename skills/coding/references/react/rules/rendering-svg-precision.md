---

title: Optimize SVG Precision
impact: LOW
impactDescription: reduces file size
tags: rendering, svg, optimization, svgo
metadata:
  id: coding.ref.react.rules.rendering-svg-precision
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - react
    - references
    - rendering svg precision
    - rules
    - references react rules rendering-svg-precision
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Optimize SVG Precision

Reduce SVG coordinate precision to decrease file size. The optimal precision depends on the viewBox size, but in general reducing precision should be considered.

**Incorrect (excessive precision):**

```svg
<path d="M 10.293847 20.847362 L 30.938472 40.192837" />
```

**Correct (1 decimal place):**

```svg
<path d="M 10.3 20.8 L 30.9 40.2" />
```

**Automate with SVGO:**

```bash
npx svgo --precision=1 --multipass icon.svg
```
