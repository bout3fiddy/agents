---

title: Use Explicit Conditional Rendering
impact: MEDIUM
impactDescription: prevents rendering 0 or NaN
tags: rendering, conditional, jsx, falsy-values
metadata:
  id: coding.ref.solidjs.rules.rendering-conditional-render
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - references
    - rendering conditional render
    - rules
    - solidjs
    - references solidjs rules rendering-conditional-render
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Use Explicit Conditional Rendering

**Impact: MEDIUM (prevents rendering 0 or NaN)**

Use explicit conditionals when falsy values like 0 should not render.

**Incorrect:**

```ts
<div>{count() && <span>{count()}</span>}</div>
```

**Correct:**

```ts
<Show when={count() > 0}>
  <span>{count()}</span>
</Show>
```
