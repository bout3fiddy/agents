---

title: Defer Reactive Reads to Usage Point
impact: MEDIUM
impactDescription: avoids unnecessary subscriptions
tags: reactivity, searchParams, localStorage, optimization
metadata:
  id: coding.ref.solidjs.rules.rerender-defer-reads
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - references
    - rerender defer reads
    - rules
    - solidjs
    - references solidjs rules rerender-defer-reads
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Defer Reactive Reads to Usage Point

**Impact: MEDIUM (avoids unnecessary subscriptions)**

Defer reactive reads until the moment of use to avoid unnecessary subscriptions. Keep browser-only reads inside event handlers or `onMount` to avoid SSR issues.

**Incorrect:**

```ts
const params = searchParams()
const handle = () => share({ ref: params.get('ref') })
```

**Correct:**

```ts
const handle = () => {
  const ref = new URLSearchParams(window.location.search).get('ref')
  share({ ref })
}
```
