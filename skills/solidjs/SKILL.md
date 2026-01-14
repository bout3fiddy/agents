---
name: solidjs
description: SolidJS reactive UI framework development. Use when building interactive frontends, creating reactive components, managing state with signals/stores, handling async data fetching, or implementing fine-grained reactivity. Covers best practices, DRY/SOLID principles, control flow components, and production patterns.
metadata:
  version: "1.0.0"
---

# SolidJS Best Practices

## Overview

Performance‑focused guidelines for SolidJS apps, ordered by impact. Apply these patterns when writing or reviewing Solid components, data fetching, and UI performance.

## When to Apply

Reference these guidelines when:
- Writing or refactoring Solid components
- Implementing async data fetching
- Reviewing code for performance issues
- Optimizing bundle size or load time

## Priority‑Ordered Guidelines

| Priority | Category | Impact |
|----------|----------|--------|
| 1 | Eliminating Waterfalls | CRITICAL |
| 2 | Bundle Size Optimization | CRITICAL |
| 3 | Server‑Side Performance | HIGH |
| 4 | Client‑Side Data Fetching | MEDIUM‑HIGH |
| 5 | Re‑render Optimization | MEDIUM |
| 6 | Rendering Performance | MEDIUM |
| 7 | JavaScript Performance | LOW‑MEDIUM |
| 8 | Advanced Patterns | LOW |

## Quick Reference (Critical First)

**Eliminate Waterfalls:**
- Start promises early, await late
- Use `Promise.all()` for independent work
- Parallelize partial dependencies
- Use `<Suspense>` for data‑bound leaves

**Reduce Bundle Size:**
- Avoid barrel imports
- Lazy‑load heavy components
- Defer non‑critical third‑party libs
- Preload on user intent

## References

Full documentation with code examples:

- `references/solid-performance-guidelines.md` — complete guide with rule index
- `references/rules/` — individual rules organized by category

To find a specific rule:
```
rg -n "suspense" references/rules/
rg -n "barrel" references/rules/
rg -n "lru" references/rules/
```

## Rule Categories in `references/rules/`

- `async-*` — waterfall elimination
- `bundle-*` — bundle size optimization
- `server-*` — server‑side performance
- `client-*` — client‑side data fetching
- `rerender-*` — re‑render optimization
- `rendering-*` — DOM rendering performance
- `js-*` — JavaScript micro‑optimizations
- `advanced-*` — advanced patterns
