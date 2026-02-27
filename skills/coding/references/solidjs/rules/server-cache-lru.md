---

title: Cross-Request LRU Caching
impact: HIGH
impactDescription: caches across requests
tags: server, cache, lru, cross-request
metadata:
  id: coding.ref.solidjs.rules.server-cache-lru
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - references
    - rules
    - server cache lru
    - solidjs
    - references solidjs rules server-cache-lru
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Cross-Request LRU Caching

**Impact: HIGH (caches across requests)**

Use cross‑request caches (LRU/Redis) for hot data shared across requests.

**Incorrect:**

```ts
async function getUser(id) { return db.user.find(id) }
```

**Correct:**

```ts
const cache = new LRUCache({ max: 1000, ttl: 300_000 })
async function getUser(id) {
  const hit = cache.get(id)
  if (hit) return hit
  const user = await db.user.find(id)
  cache.set(id, user)
  return user
}
```
