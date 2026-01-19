# SolidJS Performance Guidelines

**Version 0.1.0**

Performance optimization guide for SolidJS applications, ordered by impact. Rules are prioritized from highest to lowest impact, focusing first on eliminating waterfalls and reducing bundle size for maximum gains.

---

## Table of Contents

1. Eliminating Waterfalls — **CRITICAL**
   - Dependency-based parallelization
   - Prevent waterfall chains in API handlers
   - Promise.all for independent operations
   - Strategic Suspense boundaries
2. Bundle Size Optimization — **CRITICAL**
   - Avoid barrel imports
   - Conditional module loading
   - Defer non-critical third-party libraries
   - Dynamic imports for heavy components
   - Preload based on user intent
3. Server-Side Performance — **HIGH**
   - Cross-request LRU caching
   - `query()` + `createAsync()` for request dedupe and shared caching
   - Parallel data fetching with independent queries
4. Client-Side Data Fetching — **MEDIUM-HIGH**
   - Deduplicate global event listeners
5. Reactive Invalidation Optimization — **MEDIUM**
   - Defer reactive reads to usage point
   - Extract memoized computations
   - Narrow reactive dependencies
   - Subscribe to derived state
   - Use transitions for non-urgent updates
6. Rendering Performance — **MEDIUM**
   - content-visibility for long lists
   - Optimize SVG precision
   - Preserve DOM for show/hide
   - Explicit conditional rendering
7. Advanced Patterns — **LOW**
   - Avoid destructuring callback props when you need the latest function

---

## References

- `references/solidjs/rules/` - individual rule files organized by category
- `references/solidjs/rules/_sections.md` - ordering and impact levels
- `references/solidjs/rules/_template.md` - rule template
