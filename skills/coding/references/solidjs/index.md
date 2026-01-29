---
description: Index of reference files for references/solidjs.
---
# SolidJS Best Practices (Reference)

Performance-focused guidelines for SolidJS apps, ordered by impact. Apply these patterns when writing or reviewing Solid components, data fetching, and UI performance.

## When to Apply

Reference these guidelines when:
- Writing or refactoring Solid components
- Implementing async data fetching
- Reviewing code for performance issues
- Optimizing bundle size or load time

## Priority-Ordered Guidelines

| Priority | Category | Impact |
|----------|----------|--------|
| 1 | Eliminating Waterfalls | CRITICAL |
| 2 | Bundle Size Optimization | CRITICAL |
| 3 | Server-Side Performance | HIGH |
| 4 | Client-Side Data Fetching | MEDIUM-HIGH |
| 5 | Reactive Invalidation Optimization | MEDIUM |
| 6 | Rendering Performance | MEDIUM |
| 7 | Advanced Patterns | LOW |

## Quick Reference (Critical First)

**Eliminate Waterfalls:**
- Start promises early, await late
- Use `Promise.all()` for independent work
- Parallelize partial dependencies
- Use `<Suspense>` for data-bound leaves

**Reduce Bundle Size:**
- Avoid barrel imports
- Lazy-load heavy components
- Defer non-critical third-party libs
- Preload on user intent

## References
- `references/solidjs/solid-performance-guidelines.md` - complete guide with rule index
- `references/solidjs/solidjs-full.md` - full SolidJS development reference
## Rule Categories in `references/solidjs/rules/`

- `async-*` — waterfall elimination
- `bundle-*` — bundle size optimization
- `server-*` — server-side performance
- `client-*` — client-side data fetching
- `rerender-*` — reactive invalidation optimization
- `rendering-*` — DOM rendering performance
- `advanced-*` — advanced patterns
