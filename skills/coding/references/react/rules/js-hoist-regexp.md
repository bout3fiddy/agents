---

title: Hoist RegExp Creation
impact: LOW-MEDIUM
impactDescription: avoids recreation
tags: javascript, regexp, optimization, memoization
metadata:
  id: coding.ref.react.rules.js-hoist-regexp
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - js hoist regexp
    - react
    - references
    - rules
    - references react rules js-hoist-regexp
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Hoist RegExp Creation

Don't create RegExp inside render. Hoist to module scope or memoize with `useMemo()`.

**Incorrect (new RegExp every render):**

```tsx
function Highlighter({ text, query }: Props) {
  const regex = new RegExp(`(${query})`, 'gi')
  const parts = text.split(regex)
  return <>{parts.map((part, i) => ...)}</>
}
```

**Correct (memoize or hoist):**

```tsx
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function Highlighter({ text, query }: Props) {
  const regex = useMemo(
    () => new RegExp(`(${escapeRegex(query)})`, 'gi'),
    [query]
  )
  const parts = text.split(regex)
  return <>{parts.map((part, i) => ...)}</>
}
```

**Warning (global regex has mutable state):**

Global regex (`/g`) has mutable `lastIndex` state:

```typescript
const regex = /foo/g
regex.test('foo')  // true, lastIndex = 3
regex.test('foo')  // false, lastIndex = 0
```
