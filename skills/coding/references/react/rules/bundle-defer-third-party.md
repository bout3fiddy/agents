---

title: Defer Non-Critical Third-Party Libraries
impact: MEDIUM
impactDescription: loads after hydration
tags: bundle, third-party, analytics, defer
metadata:
  id: coding.ref.react.rules.bundle-defer-third-party
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - bundle defer third party
    - react
    - references
    - rules
    - references react rules bundle-defer-third-party
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Defer Non-Critical Third-Party Libraries

Analytics, logging, and error tracking don't block user interaction. Load them after hydration.

**Incorrect (blocks initial bundle):**

```tsx
import { Analytics } from '@vercel/analytics/react'

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  )
}
```

**Correct (loads after hydration):**

```tsx
import dynamic from 'next/dynamic'

const Analytics = dynamic(
  () => import('@vercel/analytics/react').then(m => m.Analytics),
  { ssr: false }
)

export default function RootLayout({ children }) {
  return (
    <html>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  )
}
```
