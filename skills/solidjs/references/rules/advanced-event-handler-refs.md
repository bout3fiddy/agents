---
title: Store Event Handlers in Refs
impact: LOW
impactDescription: stable subscriptions
tags: advanced, hooks, refs, event-handlers, optimization
---

## Store Event Handlers in Refs

**Impact: LOW (stable subscriptions)**

Keep event listeners stable by storing the latest handler in a mutable ref or signal, so subscriptions don’t re‑attach on every render/update.

**Incorrect:**

```ts
function useWindowEvent(event, handler) {
  createEffect(() => {
    window.addEventListener(event, handler)
    onCleanup(() => window.removeEventListener(event, handler))
  })
}
```

**Correct:**

```ts
function useWindowEvent(event, handler) {
  let latest = handler
  createEffect(() => { latest = handler })

  const listener = (e) => latest(e)
  createEffect(() => {
    window.addEventListener(event, listener)
    onCleanup(() => window.removeEventListener(event, listener))
  })
}
```
