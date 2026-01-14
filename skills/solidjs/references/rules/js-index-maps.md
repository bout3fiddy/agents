---
title: Build Index Maps for Repeated Lookups
impact: LOW-MEDIUM
impactDescription: 1M ops to 2K ops
tags: javascript, map, indexing, optimization, performance
---

## Build Index Maps for Repeated Lookups

**Impact: LOW-MEDIUM (1M ops to 2K ops)**

Build index maps for repeated lookups to reduce O(n) scans.

**Incorrect:**

```ts
orders.map(o => ({...o, user: users.find(u => u.id === o.userId)}))
```

**Correct:**

```ts
const userById = new Map(users.map(u => [u.id, u]))
orders.map(o => ({...o, user: userById.get(o.userId)}))
```
