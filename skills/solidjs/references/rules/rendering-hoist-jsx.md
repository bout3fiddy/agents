---
title: Hoist Static JSX Elements
impact: MEDIUM
impactDescription: avoids re-creation
tags: rendering, jsx, static, optimization
---

## Hoist Static JSX Elements

**Impact: MEDIUM (avoids re-creation)**

Hoist static templates so they’re not re‑created in reactive scopes.

**Incorrect:**

```ts
function Loading() {
  return <div class="skeleton" />
}
function Container() { return <Show when={loading()}>{Loading()}</Show> }
```

**Correct:**

```ts
const LoadingSkeleton = <div class="skeleton" />
function Container() { return <Show when={loading()}>{LoadingSkeleton}</Show> }
```
