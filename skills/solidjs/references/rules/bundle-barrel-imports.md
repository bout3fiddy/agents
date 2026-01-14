---
title: Avoid Barrel File Imports
impact: CRITICAL
impactDescription: 200-800ms import cost, slow builds
tags: bundle, imports, tree-shaking, barrel-files, performance
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
