---

title: Use Set/Map for O(1) Lookups
impact: LOW-MEDIUM
impactDescription: O(n) to O(1)
tags: javascript, set, map, data-structures, performance
metadata:
  id: coding.ref.react.rules.js-set-map-lookups
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - js set map lookups
    - react
    - references
    - rules
    - references react rules js-set-map-lookups
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Use Set/Map for O(1) Lookups

Convert arrays to Set/Map for repeated membership checks.

**Incorrect (O(n) per check):**

```typescript
const allowedIds = ['a', 'b', 'c', ...]
items.filter(item => allowedIds.includes(item.id))
```

**Correct (O(1) per check):**

```typescript
const allowedIds = new Set(['a', 'b', 'c', ...])
items.filter(item => allowedIds.has(item.id))
```
