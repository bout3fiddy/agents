---

title: Use Activity Component for Show/Hide
impact: MEDIUM
impactDescription: preserves state/DOM
tags: rendering, activity, visibility, state-preservation
metadata:
  id: coding.ref.react.rules.rendering-activity
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - react
    - references
    - rendering activity
    - rules
    - references react rules rendering-activity
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Use Activity Component for Show/Hide

Use React's `<Activity>` to preserve state/DOM for expensive components that frequently toggle visibility.

**Usage:**

```tsx
import { Activity } from 'react'

function Dropdown({ isOpen }: Props) {
  return (
    <Activity mode={isOpen ? 'visible' : 'hidden'}>
      <ExpensiveMenu />
    </Activity>
  )
}
```

Avoids expensive re-renders and state loss.
