---
description: Index of reference files for references/rules.
---
# Solidjs Rules References

## References
- `references/solidjs/rules/_sections.md` - This file defines all sections, their ordering, impact levels, and descriptions. The section ID (in parentheses) is the filename prefix used to group rules.
- `references/solidjs/rules/_template.md` - Optional description of impact
- `references/solidjs/rules/advanced-avoid-destructuring-callbacks.md` - prevents stale callbacks
- `references/solidjs/rules/async-api-routes.md` - avoids request waterfalls
- `references/solidjs/rules/async-dependencies.md` - 2-10× improvement
- `references/solidjs/rules/async-parallel.md` - 2-10× improvement
- `references/solidjs/rules/async-suspense-boundaries.md` - faster initial paint
- `references/solidjs/rules/bundle-barrel-imports.md` - 200-800ms import cost, slow builds
- `references/solidjs/rules/bundle-conditional.md` - loads large data only when needed
- `references/solidjs/rules/bundle-defer-third-party.md` - loads after hydration
- `references/solidjs/rules/bundle-dynamic-imports.md` - directly affects TTI and LCP
- `references/solidjs/rules/bundle-preload.md` - reduces perceived latency
- `references/solidjs/rules/client-event-listeners.md` - single listener for N components
- `references/solidjs/rules/rendering-activity.md` - preserves state/DOM
- `references/solidjs/rules/rendering-conditional-render.md` - prevents rendering 0 or NaN
- `references/solidjs/rules/rendering-content-visibility.md` - 10× faster initial render
- `references/solidjs/rules/rendering-svg-precision.md` - reduces file size
- `references/solidjs/rules/rerender-defer-reads.md` - avoids unnecessary subscriptions
- `references/solidjs/rules/rerender-dependencies.md` - minimizes recomputation
- `references/solidjs/rules/rerender-derived-state.md` - reduces reactive notifications
- `references/solidjs/rules/rerender-memo.md` - reduces reactive work
- `references/solidjs/rules/rerender-transitions.md` - maintains UI responsiveness
- `references/solidjs/rules/server-cache-lru.md` - caches across requests
- `references/solidjs/rules/server-query-dedup.md` - deduplicates and shares server fetches
