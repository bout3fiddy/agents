---

title: Use Transitions for Non-Urgent Updates
impact: MEDIUM
impactDescription: maintains UI responsiveness
tags: rerender, transitions, startTransition, performance
metadata:
  id: coding.ref.react.rules.rerender-transitions
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - react
    - references
    - rerender transitions
    - rules
    - references react rules rerender-transitions
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Use Transitions for Non-Urgent Updates

Mark frequent, non-urgent state updates as transitions to maintain UI responsiveness.

**Incorrect (blocks UI on every scroll):**

```tsx
function ScrollTracker() {
  const [scrollY, setScrollY] = useState(0)
  useEffect(() => {
    const handler = () => setScrollY(window.scrollY)
    window.addEventListener('scroll', handler, { passive: true })
    return () => window.removeEventListener('scroll', handler)
  }, [])
}
```

**Correct (non-blocking updates):**

```tsx
import { startTransition } from 'react'

function ScrollTracker() {
  const [scrollY, setScrollY] = useState(0)
  useEffect(() => {
    const handler = () => {
      startTransition(() => setScrollY(window.scrollY))
    }
    window.addEventListener('scroll', handler, { passive: true })
    return () => window.removeEventListener('scroll', handler)
  }, [])
}
```
