---

title: Deduplicate Global Event Listeners
impact: MEDIUM-HIGH
impactDescription: single listener for N components
tags: client, event-listeners, subscription, dom-events
metadata:
  id: coding.ref.solidjs.rules.client-event-listeners
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - client event listeners
    - references
    - rules
    - solidjs
    - references solidjs rules client-event-listeners
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

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
