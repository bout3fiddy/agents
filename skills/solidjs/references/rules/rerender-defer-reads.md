---
title: Defer State Reads to Usage Point
impact: MEDIUM
impactDescription: avoids unnecessary subscriptions
tags: rerender, searchParams, localStorage, optimization
---

## Defer State Reads to Usage Point

**Impact: MEDIUM (avoids unnecessary subscriptions)**

Defer reactive reads until the moment of use; avoid unnecessary subscriptions.

**Incorrect:**

```ts
const params = searchParams()
const handle = () => share({ ref: params.get('ref') })
```

**Correct:**

```ts
const handle = () => {
  const ref = new URLSearchParams(window.location.search).get('ref')
  share({ ref })
}
```
