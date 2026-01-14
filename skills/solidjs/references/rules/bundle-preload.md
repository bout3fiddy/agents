---
title: Preload Based on User Intent
impact: CRITICAL
impactDescription: reduces perceived latency
tags: bundle, preload, user-intent, hover
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
