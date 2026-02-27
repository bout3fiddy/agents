---

title: Hoist Static JSX Elements
impact: LOW
impactDescription: avoids re-creation
tags: rendering, jsx, static, optimization
metadata:
  id: coding.ref.react.rules.rendering-hoist-jsx
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - react
    - references
    - rendering hoist jsx
    - rules
    - references react rules rendering-hoist-jsx
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Hoist Static JSX Elements

Extract static JSX outside components to avoid re-creation.

**Incorrect (recreates element every render):**

```tsx
function LoadingSkeleton() {
  return <div className="animate-pulse h-20 bg-gray-200" />
}

function Container() {
  return (
    <div>
      {loading && <LoadingSkeleton />}
    </div>
  )
}
```

**Correct (reuses same element):**

```tsx
const loadingSkeleton = (
  <div className="animate-pulse h-20 bg-gray-200" />
)

function Container() {
  return (
    <div>
      {loading && loadingSkeleton}
    </div>
  )
}
```

This is especially helpful for large and static SVG nodes, which can be expensive to recreate on every render.

**Note:** If your project has [React Compiler](https://react.dev/learn/react-compiler) enabled, the compiler automatically hoists static JSX elements and optimizes component re-renders, making manual hoisting unnecessary.
