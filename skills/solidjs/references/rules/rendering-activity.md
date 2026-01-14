---
title: Use Activity Component for Show/Hide
impact: MEDIUM
impactDescription: preserves state/DOM
tags: rendering, activity, visibility, state-preservation
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
