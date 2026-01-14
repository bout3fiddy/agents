---
title: Early Return from Functions
impact: LOW-MEDIUM
impactDescription: avoids unnecessary computation
tags: javascript, functions, optimization, early-return
---

## Early Return from Functions

**Impact: LOW-MEDIUM (avoids unnecessary computation)**

Return early once the result is determined to skip unnecessary work.

**Incorrect:**

```ts
function validate(users) {
  let error = null
  for (const u of users) {
    if (!u.email) error = 'Email required'
  }
  return error
}
```

**Correct:**

```ts
function validate(users) {
  for (const u of users) {
    if (!u.email) return 'Email required'
  }
  return null
}
```
