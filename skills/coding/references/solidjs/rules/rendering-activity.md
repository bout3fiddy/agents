---

title: Use Activity Component for Show/Hide
impact: MEDIUM
impactDescription: preserves state/DOM
tags: rendering, activity, visibility, state-preservation
metadata:
  id: coding.ref.solidjs.rules.rendering-activity
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - references
    - rendering activity
    - rules
    - solidjs
    - references solidjs rules rendering-activity
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Use Activity Component for Show/Hide

**Impact: MEDIUM (preserves state/DOM)**

Preserve DOM/state for expensive components by hiding instead of unmounting.

**Incorrect:**

```ts
<Show when={isOpen()}>
  <ExpensiveMenu />
</Show>
```

**Correct:**

```ts
<div classList={{ hidden: !isOpen() }}>
  <ExpensiveMenu />
</div>
```
