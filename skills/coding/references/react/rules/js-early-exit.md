---

title: Early Return from Functions
impact: LOW-MEDIUM
impactDescription: avoids unnecessary computation
tags: javascript, functions, optimization, early-return
metadata:
  id: coding.ref.react.rules.js-early-exit
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - js early exit
    - react
    - references
    - rules
    - references react rules js-early-exit
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Early Return from Functions

Return early when result is determined to skip unnecessary processing.

**Incorrect (processes all items even after finding answer):**

```typescript
function validateUsers(users: User[]) {
  let hasError = false
  let errorMessage = ''
  
  for (const user of users) {
    if (!user.email) {
      hasError = true
      errorMessage = 'Email required'
    }
    if (!user.name) {
      hasError = true
      errorMessage = 'Name required'
    }
    // Continues checking all users even after error found
  }
  
  return hasError ? { valid: false, error: errorMessage } : { valid: true }
}
```

**Correct (returns immediately on first error):**

```typescript
function validateUsers(users: User[]) {
  for (const user of users) {
    if (!user.email) {
      return { valid: false, error: 'Email required' }
    }
    if (!user.name) {
      return { valid: false, error: 'Name required' }
    }
  }

  return { valid: true }
}
```
