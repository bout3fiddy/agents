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
   - Minimize serialization boundaries
   - Parallel data fetching via composition
   - Per-request deduplication (request-scope cache)
4. Client-Side Data Fetching — **MEDIUM-HIGH**
   - Deduplicate global event listeners
   - Shared request cache/dedup
5. Re-render Optimization — **MEDIUM**
   - Defer reactive reads to usage point
   - Extract memoized computations
   - Narrow effect dependencies
   - Subscribe to derived state
   - Use transitions for non-urgent updates
6. Rendering Performance — **MEDIUM**
   - content-visibility for long lists
   - Hoist static JSX/templates
   - Optimize SVG precision
   - Preserve DOM for show/hide
   - Explicit conditional rendering
7. JavaScript Performance — **LOW-MEDIUM**
   - Index maps for repeated lookups
   - Cache property access in loops
   - Cache storage API calls
   - Combine iterations
   - Early returns
   - Hoist RegExp creation
   - Set/Map for O(1) lookups
8. Advanced Patterns — **LOW**
   - Store event handlers in refs
   - useLatest-style stable callback refs

---

## References

- `references/rules/` — individual rule files organized by category
- `references/rules/_sections.md` — ordering and impact levels
- `references/rules/_template.md` — rule template
