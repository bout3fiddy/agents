---

title: Dynamic Imports for Heavy Components
impact: CRITICAL
impactDescription: directly affects TTI and LCP
tags: bundle, dynamic-import, code-splitting, lazy-load
metadata:
  id: coding.ref.solidjs.rules.bundle-dynamic-imports
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - bundle dynamic imports
    - references
    - rules
    - solidjs
    - references solidjs rules bundle-dynamic-imports
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Dynamic Imports for Heavy Components

**Impact: CRITICAL (directly affects TTI and LCP)**

Lazy‑load heavy components so the initial bundle stays small.

**Incorrect:**

```ts
import { MonacoEditor } from './monaco-editor'
const Panel = () => <MonacoEditor />
```

**Correct:**

```ts
const MonacoEditor = lazy(() => import('./monaco-editor'))
const Panel = () => <MonacoEditor />
```
