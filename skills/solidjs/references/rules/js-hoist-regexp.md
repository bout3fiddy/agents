---
title: Hoist RegExp Creation
impact: LOW-MEDIUM
impactDescription: avoids recreation
tags: javascript, regexp, optimization, memoization
---

## Hoist RegExp Creation

**Impact: LOW-MEDIUM (avoids recreation)**

Hoist RegExp creation out of hot paths and avoid re‑creating on every render.

**Incorrect:**

```ts
function match(text, query) {
  const re = new RegExp(query, 'i')
  return re.test(text)
}
```

**Correct:**

```ts
const re = /foo/i
function match(text) {
  return re.test(text)
}
```
