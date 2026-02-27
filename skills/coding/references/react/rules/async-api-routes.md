---

title: Prevent Waterfall Chains in API Routes
impact: CRITICAL
impactDescription: 2-10× improvement
tags: api-routes, server-actions, waterfalls, parallelization
metadata:
  id: coding.ref.react.rules.async-api-routes
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - async api routes
    - react
    - references
    - rules
    - references react rules async-api-routes
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Prevent Waterfall Chains in API Routes

In API routes and Server Actions, start independent operations immediately, even if you don't await them yet.

**Incorrect (config waits for auth, data waits for both):**

```typescript
export async function GET(request: Request) {
  const session = await auth()
  const config = await fetchConfig()
  const data = await fetchData(session.user.id)
  return Response.json({ data, config })
}
```

**Correct (auth and config start immediately):**

```typescript
export async function GET(request: Request) {
  const sessionPromise = auth()
  const configPromise = fetchConfig()
  const session = await sessionPromise
  const [config, data] = await Promise.all([
    configPromise,
    fetchData(session.user.id)
  ])
  return Response.json({ data, config })
}
```

For operations with more complex dependency chains, use `better-all` to automatically maximize parallelism (see Dependency-Based Parallelization).
