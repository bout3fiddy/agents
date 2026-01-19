---
title: Dynamic Imports for Heavy Components
impact: CRITICAL
impactDescription: directly affects TTI and LCP
tags: bundle, dynamic-import, code-splitting, next-dynamic
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
