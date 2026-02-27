---

title: Avoid Barrel File Imports
impact: CRITICAL
impactDescription: 200-800ms import cost, slow builds
tags: bundle, imports, tree-shaking, barrel-files, performance
metadata:
  id: coding.ref.solidjs.rules.bundle-barrel-imports
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - bundle barrel imports
    - references
    - rules
    - solidjs
    - references solidjs rules bundle-barrel-imports
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Avoid Barrel File Imports

**Impact: CRITICAL (200-800ms import cost, slow builds)**

Avoid barrel imports for large libraries; import only the modules you use.

**Incorrect:**

```ts
import { IconA, IconB } from 'big-icons'
import { Button } from 'ui-kit' 
```

**Correct:**

```ts
import IconA from 'big-icons/dist/icon-a'
import IconB from 'big-icons/dist/icon-b'
import Button from 'ui-kit/Button' 
```
