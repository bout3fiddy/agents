---

title: Subscribe to Derived State
impact: MEDIUM
impactDescription: reduces re-render frequency
tags: rerender, derived-state, media-query, optimization
metadata:
  id: coding.ref.react.rules.rerender-derived-state
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - react
    - references
    - rerender derived state
    - rules
    - references react rules rerender-derived-state
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Subscribe to Derived State

Subscribe to derived boolean state instead of continuous values to reduce re-render frequency.

**Incorrect (re-renders on every pixel change):**

```tsx
function Sidebar() {
  const width = useWindowWidth()  // updates continuously
  const isMobile = width < 768
  return <nav className={isMobile ? 'mobile' : 'desktop'} />
}
```

**Correct (re-renders only when boolean changes):**

```tsx
function Sidebar() {
  const isMobile = useMediaQuery('(max-width: 767px)')
  return <nav className={isMobile ? 'mobile' : 'desktop'} />
}
```
