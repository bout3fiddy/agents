---

title: Dependency-Based Parallelization
impact: CRITICAL
impactDescription: 2-10× improvement
tags: async, parallelization, dependencies, better-all
metadata:
  id: coding.ref.react.rules.async-dependencies
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - async dependencies
    - react
    - references
    - rules
    - references react rules async-dependencies
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Dependency-Based Parallelization

For operations with partial dependencies, use `better-all` to maximize parallelism. It automatically starts each task at the earliest possible moment.

**Incorrect (profile waits for config unnecessarily):**

```typescript
const [user, config] = await Promise.all([
  fetchUser(),
  fetchConfig()
])
const profile = await fetchProfile(user.id)
```

**Correct (config and profile run in parallel):**

```typescript
import { all } from 'better-all'

const { user, config, profile } = await all({
  async user() { return fetchUser() },
  async config() { return fetchConfig() },
  async profile() {
    return fetchProfile((await this.$.user).id)
  }
})
```

Reference: [https://github.com/shuding/better-all](https://github.com/shuding/better-all)
