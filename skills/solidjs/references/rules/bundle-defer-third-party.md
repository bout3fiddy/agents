---
title: Defer Non-Critical Third-Party Libraries
impact: CRITICAL
impactDescription: loads after hydration
tags: bundle, third-party, analytics, defer
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
