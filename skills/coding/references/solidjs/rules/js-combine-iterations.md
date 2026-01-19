---
title: Combine Multiple Array Iterations
impact: LOW-MEDIUM
impactDescription: reduces iterations
tags: javascript, arrays, loops, performance
---

## Combine Multiple Array Iterations

**Impact: LOW-MEDIUM (reduces iterations)**

Combine multiple array passes into a single loop.

**Incorrect:**

```ts
const admins = users.filter(u => u.isAdmin)
const testers = users.filter(u => u.isTester)
```

**Correct:**

```ts
const admins = []
const testers = []
for (const u of users) {
  if (u.isAdmin) admins.push(u)
  if (u.isTester) testers.push(u)
}
```
