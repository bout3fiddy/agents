---
title: Conditional Module Loading
impact: CRITICAL
impactDescription: loads large data only when needed
tags: bundle, conditional-loading, lazy-loading
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
