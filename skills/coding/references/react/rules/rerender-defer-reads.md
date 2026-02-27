---

title: Defer State Reads to Usage Point
impact: MEDIUM
impactDescription: avoids unnecessary subscriptions
tags: rerender, searchParams, localStorage, optimization
metadata:
  id: coding.ref.react.rules.rerender-defer-reads
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - react
    - references
    - rerender defer reads
    - rules
    - references react rules rerender-defer-reads
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Defer State Reads to Usage Point

Don't subscribe to dynamic state (searchParams, localStorage) if you only read it inside callbacks.

**Incorrect (subscribes to all searchParams changes):**

```tsx
function ShareButton({ chatId }: { chatId: string }) {
  const searchParams = useSearchParams()

  const handleShare = () => {
    const ref = searchParams.get('ref')
    shareChat(chatId, { ref })
  }

  return <button onClick={handleShare}>Share</button>
}
```

**Correct (reads on demand, no subscription):**

```tsx
function ShareButton({ chatId }: { chatId: string }) {
  const handleShare = () => {
    const params = new URLSearchParams(window.location.search)
    const ref = params.get('ref')
    shareChat(chatId, { ref })
  }

  return <button onClick={handleShare}>Share</button>
}
```
