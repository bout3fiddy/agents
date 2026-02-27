---

title: Narrow Effect Dependencies
impact: LOW
impactDescription: minimizes effect re-runs
tags: rerender, useEffect, dependencies, optimization
metadata:
  id: coding.ref.react.rules.rerender-dependencies
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - react
    - references
    - rerender dependencies
    - rules
    - references react rules rerender-dependencies
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Narrow Effect Dependencies

Specify primitive dependencies instead of objects to minimize effect re-runs.

**Incorrect (re-runs on any user field change):**

```tsx
useEffect(() => {
  console.log(user.id)
}, [user])
```

**Correct (re-runs only when id changes):**

```tsx
useEffect(() => {
  console.log(user.id)
}, [user.id])
```

**For derived state, compute outside effect:**

```tsx
// Incorrect: runs on width=767, 766, 765...
useEffect(() => {
  if (width < 768) {
    enableMobileMode()
  }
}, [width])

// Correct: runs only on boolean transition
const isMobile = width < 768
useEffect(() => {
  if (isMobile) {
    enableMobileMode()
  }
}, [isMobile])
```
