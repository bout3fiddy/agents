---
title: Use Explicit Conditional Rendering
impact: MEDIUM
impactDescription: prevents rendering 0 or NaN
tags: rendering, conditional, jsx, falsy-values
---

## Use Explicit Conditional Rendering

**Impact: MEDIUM (prevents rendering 0 or NaN)**

Use explicit conditionals when falsy values like 0 should not render.

**Incorrect:**

```ts
<div>{count() && <span>{count()}</span>}</div>
```

**Correct:**

```ts
<Show when={count() > 0}>
  <span>{count()}</span>
</Show>
```
