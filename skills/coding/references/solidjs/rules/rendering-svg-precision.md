---
title: Optimize SVG Precision
impact: MEDIUM
impactDescription: reduces file size
tags: rendering, svg, optimization, svgo
---

## Optimize SVG Precision

**Impact: MEDIUM (reduces file size)**

Reduce SVG coordinate precision to cut payload size.

**Incorrect:**

```ts
<path d="M 10.293847 20.847362 L 30.938472 40.192837" />
```

**Correct:**

```ts
<path d="M 10.3 20.8 L 30.9 40.2" />
```
