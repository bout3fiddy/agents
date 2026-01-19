---
title: CSS content-visibility for Long Lists
impact: MEDIUM
impactDescription: 10× faster initial render
tags: rendering, css, content-visibility, long-lists
---

## CSS content-visibility for Long Lists

**Impact: MEDIUM (10× faster initial render)**

Use content-visibility to defer off‑screen rendering for long lists.

**Incorrect:**

```ts
.row { }
```

**Correct:**

```ts
.row { content-visibility: auto; contain-intrinsic-size: 0 80px; }
```
