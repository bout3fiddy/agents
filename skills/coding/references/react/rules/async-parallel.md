---

title: Promise.all() for Independent Operations
impact: CRITICAL
impactDescription: 2-10× improvement
tags: async, parallelization, promises, waterfalls
metadata:
  id: coding.ref.react.rules.async-parallel
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - async parallel
    - react
    - references
    - rules
    - references react rules async-parallel
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Promise.all() for Independent Operations

When async operations have no interdependencies, execute them concurrently using `Promise.all()`.

**Incorrect (sequential execution, 3 round trips):**

```typescript
const user = await fetchUser()
const posts = await fetchPosts()
const comments = await fetchComments()
```

**Correct (parallel execution, 1 round trip):**

```typescript
const [user, posts, comments] = await Promise.all([
  fetchUser(),
  fetchPosts(),
  fetchComments()
])
```
