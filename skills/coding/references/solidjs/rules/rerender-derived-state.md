---
title: Subscribe to Derived State
impact: MEDIUM
impactDescription: reduces reactive notifications
tags: reactivity, derived-state, media-query, optimization
---

## Subscribe to Derived State

**Impact: MEDIUM (reduces reactive notifications)**

Subscribe to derived state instead of raw values to reduce update frequency.

**Incorrect:**

```ts
const isMobile = width() < 768
```

**Correct:**

```ts
const isMobile = createMemo(() => width() < 768)
```
