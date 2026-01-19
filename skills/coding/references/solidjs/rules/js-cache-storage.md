---
title: Cache Storage API Calls
impact: LOW-MEDIUM
impactDescription: reduces expensive I/O
tags: javascript, localStorage, storage, caching, performance
---

## Cache Storage API Calls

**Impact: LOW-MEDIUM (reduces expensive I/O)**

Cache storage API reads to avoid repeated sync I/O.

**Incorrect:**

```ts
function getTheme() {
  return localStorage.getItem('theme') ?? 'light'
}
```

**Correct:**

```ts
const cache = new Map()
function getTheme() {
  if (!cache.has('theme')) cache.set('theme', localStorage.getItem('theme'))
  return cache.get('theme') ?? 'light'
}
```
