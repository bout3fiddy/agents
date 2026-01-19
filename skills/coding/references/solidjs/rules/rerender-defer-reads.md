---
title: Defer Reactive Reads to Usage Point
impact: MEDIUM
impactDescription: avoids unnecessary subscriptions
tags: reactivity, searchParams, localStorage, optimization
---

## Defer Reactive Reads to Usage Point

**Impact: MEDIUM (avoids unnecessary subscriptions)**

Defer reactive reads until the moment of use to avoid unnecessary subscriptions. Keep browser-only reads inside event handlers or `onMount` to avoid SSR issues.

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
