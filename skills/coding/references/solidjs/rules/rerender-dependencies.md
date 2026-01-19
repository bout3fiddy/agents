---
title: Narrow Reactive Dependencies
impact: MEDIUM
impactDescription: minimizes recomputation
tags: reactivity, dependencies, optimization
---

## Narrow Reactive Dependencies

**Impact: MEDIUM (minimizes recomputation)**

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
