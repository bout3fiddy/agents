---

title: Conditional Module Loading
impact: CRITICAL
impactDescription: loads large data only when needed
tags: bundle, conditional-loading, lazy-loading
metadata:
  id: coding.ref.solidjs.rules.bundle-conditional
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - bundle conditional
    - references
    - rules
    - solidjs
    - references solidjs rules bundle-conditional
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Conditional Module Loading

**Impact: CRITICAL (loads large data only when needed)**

Load large modules or datasets only when a feature is actually enabled.

**Incorrect:**

```ts
import frames from './animation-frames.json'
const player = new Player(frames)
```

**Correct:**

```ts
createEffect(async () => {
  if (enabled()) {
    const mod = await import('./animation-frames.js')
    setFrames(mod.frames)
  }
})
```
