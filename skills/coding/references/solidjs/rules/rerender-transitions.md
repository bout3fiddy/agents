---
title: Use Transitions for Non-Urgent Updates
impact: MEDIUM
impactDescription: maintains UI responsiveness
tags: rerender, transitions, startTransition, performance
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
