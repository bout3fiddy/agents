---
title: Prevent Waterfall Chains in API Routes
impact: CRITICAL
impactDescription: 2-10× improvement
tags: api-routes, server-actions, waterfalls, parallelization
---

## Prevent Waterfall Chains in API Routes

**Impact: CRITICAL (2-10× improvement)**

Start independent async work immediately inside API handlers to avoid request waterfalls.

**Incorrect:**

```ts
export async function GET(req) {
  const session = await auth()
  const config = await fetchConfig()
  const data = await fetchData(session.userId)
  return json({ data, config })
}
```

**Correct:**

```ts
export async function GET(req) {
  const sessionPromise = auth()
  const configPromise = fetchConfig()
  const session = await sessionPromise
  const [config, data] = await Promise.all([
    configPromise,
    fetchData(session.userId)
  ])
  return json({ data, config })
}
```
