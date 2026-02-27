---

title: Use Explicit Conditional Rendering
impact: LOW
impactDescription: prevents rendering 0 or NaN
tags: rendering, conditional, jsx, falsy-values
metadata:
  id: coding.ref.react.rules.rendering-conditional-render
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - react
    - references
    - rendering conditional render
    - rules
    - references react rules rendering-conditional-render
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Use Explicit Conditional Rendering

Use explicit ternary operators (`? :`) instead of `&&` for conditional rendering when the condition can be `0`, `NaN`, or other falsy values that render.

**Incorrect (renders "0" when count is 0):**

```tsx
function Badge({ count }: { count: number }) {
  return (
    <div>
      {count && <span className="badge">{count}</span>}
    </div>
  )
}

// When count = 0, renders: <div>0</div>
// When count = 5, renders: <div><span class="badge">5</span></div>
```

**Correct (renders nothing when count is 0):**

```tsx
function Badge({ count }: { count: number }) {
  return (
    <div>
      {count > 0 ? <span className="badge">{count}</span> : null}
    </div>
  )
}

// When count = 0, renders: <div></div>
// When count = 5, renders: <div><span class="badge">5</span></div>
```
