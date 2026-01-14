---
title: Cache Property Access in Loops
impact: LOW-MEDIUM
impactDescription: reduces lookups
tags: javascript, loops, optimization, caching
---

## Cache Property Access in Loops

**Impact: LOW-MEDIUM (reduces lookups)**

Cache repeated property access in hot loops to reduce lookups.

**Incorrect:**

```ts
for (let i = 0; i < arr.length; i++) {
  process(obj.config.settings.value)
}
```

**Correct:**

```ts
const value = obj.config.settings.value
const len = arr.length
for (let i = 0; i < len; i++) {
  process(value)
}
```
