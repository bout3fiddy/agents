---
title: Use Set/Map for O(1) Lookups
impact: LOW-MEDIUM
impactDescription: O(n) to O(1)
tags: javascript, set, map, data-structures, performance
---

## Use Set/Map for O(1) Lookups

**Impact: LOW-MEDIUM (O(n) to O(1))**

Use Set/Map for O(1) membership checks instead of array includes().

**Incorrect:**

```ts
const allowed = ['a','b','c']
items.filter(i => allowed.includes(i.id))
```

**Correct:**

```ts
const allowed = new Set(['a','b','c'])
items.filter(i => allowed.has(i.id))
```
