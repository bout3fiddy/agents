---
title: Dependency-Based Parallelization
impact: CRITICAL
impactDescription: 2-10× improvement
tags: async, parallelization, dependencies, better-all
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
