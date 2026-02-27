---

title: Defer Non-Critical Third-Party Libraries
impact: CRITICAL
impactDescription: loads after hydration
tags: bundle, third-party, analytics, defer
metadata:
  id: coding.ref.solidjs.rules.bundle-defer-third-party
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - bundle defer third party
    - references
    - rules
    - solidjs
    - references solidjs rules bundle-defer-third-party
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Defer Non-Critical Third-Party Libraries

**Impact: CRITICAL (loads after hydration)**

Defer non‑critical third‑party libraries (analytics, logging) until after interaction.

**Incorrect:**

```ts
import analytics from 'analytics-sdk'
analytics.init()
```

**Correct:**

```ts
onMount(async () => {
  const analytics = await import('analytics-sdk')
  analytics.init()
})
```
