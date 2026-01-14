---
title: Use SWR for Automatic Deduplication
impact: MEDIUM-HIGH
impactDescription: automatic deduplication
tags: client, swr, deduplication, data-fetching
---

## Use SWR for Automatic Deduplication

**Impact: MEDIUM-HIGH (automatic deduplication)**

Use a shared request cache/dedup layer so multiple components don’t refetch the same data.

**Incorrect:**

```ts
function UserList() {
  const [users, setUsers] = createSignal([])
  createEffect(() => { fetch('/api/users').then(r => r.json()).then(setUsers) })
}
```

**Correct:**

```ts
const inflight = new Map()
function fetchOnce(key, fn) {
  if (!inflight.has(key)) inflight.set(key, fn())
  return inflight.get(key)
}

createEffect(async () => {
  const users = await fetchOnce('users', () => fetch('/api/users').then(r => r.json()))
  setUsers(users)
})
```
