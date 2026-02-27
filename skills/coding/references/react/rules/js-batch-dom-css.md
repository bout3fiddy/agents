---

title: Batch DOM CSS Changes
impact: MEDIUM
impactDescription: reduces reflows/repaints
tags: javascript, dom, css, performance, reflow
metadata:
  id: coding.ref.react.rules.js-batch-dom-css
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - js batch dom css
    - react
    - references
    - rules
    - references react rules js-batch-dom-css
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Batch DOM CSS Changes

Avoid interleaving style writes with layout reads. When you read a layout property (like `offsetWidth`, `getBoundingClientRect()`, or `getComputedStyle()`) between style changes, the browser is forced to trigger a synchronous reflow.

**Incorrect (interleaved reads and writes force reflows):**

```typescript
function updateElementStyles(element: HTMLElement) {
  element.style.width = '100px'
  const width = element.offsetWidth  // Forces reflow
  element.style.height = '200px'
  const height = element.offsetHeight  // Forces another reflow
}
```

**Correct (batch writes, then read once):**

```typescript
function updateElementStyles(element: HTMLElement) {
  // Batch all writes together
  element.style.width = '100px'
  element.style.height = '200px'
  element.style.backgroundColor = 'blue'
  element.style.border = '1px solid black'
  
  // Read after all writes are done (single reflow)
  const { width, height } = element.getBoundingClientRect()
}
```

**Better: use CSS classes**

```css
.highlighted-box {
  width: 100px;
  height: 200px;
  background-color: blue;
  border: 1px solid black;
}
```

```typescript
function updateElementStyles(element: HTMLElement) {
  element.classList.add('highlighted-box')

  const { width, height } = element.getBoundingClientRect()
}
```

Prefer CSS classes over inline styles when possible. CSS files are cached by the browser, and classes provide better separation of concerns and are easier to maintain.