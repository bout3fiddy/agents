---

title: Promise.all() for Independent Operations
impact: CRITICAL
impactDescription: 2-10× improvement
tags: async, parallelization, promises, waterfalls
metadata:
  id: coding.ref.solidjs.rules.async-parallel
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - async parallel
    - references
    - rules
    - solidjs
    - references solidjs rules async-parallel
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Promise.all() for Independent Operations

**Impact: CRITICAL (2-10× improvement)**

Use Promise.all for independent async operations to avoid sequential latency.

**Incorrect:**

```ts
const user = await fetchUser()
const posts = await fetchPosts()
const comments = await fetchComments()
```

**Correct:**

```ts
const [user, posts, comments] = await Promise.all([
  fetchUser(),
  fetchPosts(),
  fetchComments()
])
```
