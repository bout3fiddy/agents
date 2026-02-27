---

title: Dependency-Based Parallelization
impact: CRITICAL
impactDescription: 2-10× improvement
tags: async, parallelization, dependencies, better-all
metadata:
  id: coding.ref.solidjs.rules.async-dependencies
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - async dependencies
    - references
    - rules
    - solidjs
    - references solidjs rules async-dependencies
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Dependency-Based Parallelization

**Impact: CRITICAL (2-10× improvement)**

For partial dependencies, begin upstream work early and await only what is required for each task.

**Incorrect:**

```ts
const [user, config] = await Promise.all([
  fetchUser(),
  fetchConfig()
])
const profile = await fetchProfile(user.id)
```

**Correct:**

```ts
const userPromise = fetchUser()
const configPromise = fetchConfig()
const profilePromise = userPromise.then(u => fetchProfile(u.id))
const [user, config, profile] = await Promise.all([
  userPromise,
  configPromise,
  profilePromise
])
```
