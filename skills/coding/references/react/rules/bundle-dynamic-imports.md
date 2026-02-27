---

title: Dynamic Imports for Heavy Components
impact: CRITICAL
impactDescription: directly affects TTI and LCP
tags: bundle, dynamic-import, code-splitting, next-dynamic
metadata:
  id: coding.ref.react.rules.bundle-dynamic-imports
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - bundle dynamic imports
    - react
    - references
    - rules
    - references react rules bundle-dynamic-imports
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Dynamic Imports for Heavy Components

Use `next/dynamic` to lazy-load large components not needed on initial render.

**Incorrect (Monaco bundles with main chunk ~300KB):**

```tsx
import { MonacoEditor } from './monaco-editor'

function CodePanel({ code }: { code: string }) {
  return <MonacoEditor value={code} />
}
```

**Correct (Monaco loads on demand):**

```tsx
import dynamic from 'next/dynamic'

const MonacoEditor = dynamic(
  () => import('./monaco-editor').then(m => m.MonacoEditor),
  { ssr: false }
)

function CodePanel({ code }: { code: string }) {
  return <MonacoEditor value={code} />
}
```
