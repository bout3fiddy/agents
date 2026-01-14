---
title: Deduplicate Global Event Listeners
impact: MEDIUM-HIGH
impactDescription: single listener for N components
tags: client, swr, event-listeners, subscription
---

## Deduplicate Global Event Listeners

**Impact: MEDIUM-HIGH (single listener for N components)**

Deduplicate global event listeners by sharing one listener across subscribers.

**Incorrect:**

```ts
function Shortcut(props) {
  createEffect(() => {
    const handler = (e) => e.key === 'k' && props.onTrigger()
    window.addEventListener('keydown', handler)
    onCleanup(() => window.removeEventListener('keydown', handler))
  })
}
```

**Correct:**

```ts
const subscribers = new Set()
let attached = false
const handler = (e) => subscribers.forEach(fn => fn(e))

function subscribe(fn) {
  subscribers.add(fn)
  if (!attached) {
    window.addEventListener('keydown', handler)
    attached = true
  }
  return () => {
    subscribers.delete(fn)
    if (!subscribers.size) {
      window.removeEventListener('keydown', handler)
      attached = false
    }
  }
}

function Shortcut(props) {
  createEffect(() => {
    const off = subscribe((e) => e.key === 'k' && props.onTrigger())
    onCleanup(off)
  })
}
```
