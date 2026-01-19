---
title: Per-Request Deduplication with React.cache()
impact: HIGH
impactDescription: deduplicates within request
tags: server, cache, react-cache, deduplication
---

## Per-Request Deduplication with React.cache()

**Impact: HIGH (deduplicates within request)**

Deduplicate within a request using request‑scoped memoization.

**Incorrect:**

```ts
async function getCurrentUser() { return db.user.find(session.userId) }
```

**Correct:**

```ts
const requestCache = new Map()
async function getCurrentUser(session) {
  if (requestCache.has(session.id)) return requestCache.get(session.id)
  const user = await db.user.find(session.userId)
  requestCache.set(session.id, user)
  return user
}
```
