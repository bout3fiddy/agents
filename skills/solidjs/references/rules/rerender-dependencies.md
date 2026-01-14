---
title: Narrow Effect Dependencies
impact: MEDIUM
impactDescription: minimizes effect re-runs
tags: rerender, useEffect, dependencies, optimization
---

## Narrow Effect Dependencies

**Impact: MEDIUM (minimizes effect re-runs)**

Narrow reactive dependencies by deriving booleans or primitives before effects.

**Incorrect:**

```ts
createEffect(() => { if (width() < 768) enableMobile() })
```

**Correct:**

```ts
const isMobile = createMemo(() => width() < 768)
createEffect(() => isMobile() && enableMobile())
```
