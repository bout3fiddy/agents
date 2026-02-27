---

title: Cache Property Access in Loops
impact: LOW-MEDIUM
impactDescription: reduces lookups
tags: javascript, loops, optimization, caching
metadata:
  id: coding.ref.react.rules.js-cache-property-access
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - js cache property access
    - react
    - references
    - rules
    - references react rules js-cache-property-access
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Cache Property Access in Loops

Cache object property lookups in hot paths.

**Incorrect (3 lookups × N iterations):**

```typescript
for (let i = 0; i < arr.length; i++) {
  process(obj.config.settings.value)
}
```

**Correct (1 lookup total):**

```typescript
const value = obj.config.settings.value
const len = arr.length
for (let i = 0; i < len; i++) {
  process(value)
}
```
