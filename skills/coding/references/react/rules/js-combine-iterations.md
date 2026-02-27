---

title: Combine Multiple Array Iterations
impact: LOW-MEDIUM
impactDescription: reduces iterations
tags: javascript, arrays, loops, performance
metadata:
  id: coding.ref.react.rules.js-combine-iterations
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - js combine iterations
    - react
    - references
    - rules
    - references react rules js-combine-iterations
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Combine Multiple Array Iterations

Multiple `.filter()` or `.map()` calls iterate the array multiple times. Combine into one loop.

**Incorrect (3 iterations):**

```typescript
const admins = users.filter(u => u.isAdmin)
const testers = users.filter(u => u.isTester)
const inactive = users.filter(u => !u.isActive)
```

**Correct (1 iteration):**

```typescript
const admins: User[] = []
const testers: User[] = []
const inactive: User[] = []

for (const user of users) {
  if (user.isAdmin) admins.push(user)
  if (user.isTester) testers.push(user)
  if (!user.isActive) inactive.push(user)
}
```
