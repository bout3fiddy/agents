---

title: Preload Based on User Intent
impact: CRITICAL
impactDescription: reduces perceived latency
tags: bundle, preload, user-intent, hover
metadata:
  id: coding.ref.solidjs.rules.bundle-preload
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - bundle preload
    - references
    - rules
    - solidjs
    - references solidjs rules bundle-preload
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Preload Based on User Intent

**Impact: CRITICAL (reduces perceived latency)**

Preload heavy bundles based on user intent (hover/focus) to reduce perceived latency.

**Incorrect:**

```ts
const openEditor = async () => {
  const mod = await import('./editor')
  setEditor(mod.default)
}
```

**Correct:**

```ts
const preload = () => { void import('./editor') }
<button onMouseEnter={preload} onFocus={preload} onClick={openEditor}>Open</button>
```
