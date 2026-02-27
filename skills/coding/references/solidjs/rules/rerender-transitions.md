---

title: Use Transitions for Non-Urgent Updates
impact: MEDIUM
impactDescription: maintains UI responsiveness
tags: reactivity, transitions, startTransition, performance
metadata:
  id: coding.ref.solidjs.rules.rerender-transitions
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - references
    - rerender transitions
    - rules
    - solidjs
    - references solidjs rules rerender-transitions
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Use Transitions for Non-Urgent Updates

**Impact: MEDIUM (maintains UI responsiveness)**

Use transitions for non‑urgent updates to keep the UI responsive.

**Incorrect:**

```ts
const onScroll = () => setScrollY(window.scrollY)
```

**Correct:**

```ts
const onScroll = () => startTransition(() => setScrollY(window.scrollY))
```
