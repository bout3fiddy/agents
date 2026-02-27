---

description: Index of reference files for skills/coding/references/react/rules.
metadata:
  id: coding.ref.react.rules.index
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - index
    - react
    - references
    - rules
    - references react rules index
    - reference index
  priority: 30
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: true

---

# React Rules References

## References
- `skills/coding/references/react/rules/advanced-event-handler-refs.md` - stable subscriptions
- `skills/coding/references/react/rules/advanced-use-latest.md` - prevents effect re-runs
- `skills/coding/references/react/rules/async-api-routes.md` - 2-10× improvement
- `skills/coding/references/react/rules/async-defer-await.md` - avoids blocking unused code paths
- `skills/coding/references/react/rules/async-dependencies.md` - 2-10× improvement
- `skills/coding/references/react/rules/async-parallel.md` - 2-10× improvement
- `skills/coding/references/react/rules/async-suspense-boundaries.md` - faster initial paint
- `skills/coding/references/react/rules/bundle-barrel-imports.md` - 200-800ms import cost, slow builds
- `skills/coding/references/react/rules/bundle-conditional.md` - loads large data only when needed
- `skills/coding/references/react/rules/bundle-defer-third-party.md` - loads after hydration
- `skills/coding/references/react/rules/bundle-dynamic-imports.md` - directly affects TTI and LCP
- `skills/coding/references/react/rules/bundle-preload.md` - reduces perceived latency
- `skills/coding/references/react/rules/client-event-listeners.md` - single listener for N components
- `skills/coding/references/react/rules/client-localstorage-schema.md` - prevents schema conflicts, reduces storage size
- `skills/coding/references/react/rules/client-passive-event-listeners.md` - eliminates scroll delay caused by event listeners
- `skills/coding/references/react/rules/client-swr-dedup.md` - automatic deduplication
- `skills/coding/references/react/rules/js-batch-dom-css.md` - reduces reflows/repaints
- `skills/coding/references/react/rules/js-cache-function-results.md` - avoid redundant computation
- `skills/coding/references/react/rules/js-cache-property-access.md` - reduces lookups
- `skills/coding/references/react/rules/js-cache-storage.md` - reduces expensive I/O
- `skills/coding/references/react/rules/js-combine-iterations.md` - reduces iterations
- `skills/coding/references/react/rules/js-early-exit.md` - avoids unnecessary computation
- `skills/coding/references/react/rules/js-hoist-regexp.md` - avoids recreation
- `skills/coding/references/react/rules/js-index-maps.md` - 1M ops to 2K ops
- `skills/coding/references/react/rules/js-length-check-first.md` - avoids expensive operations when lengths differ
- `skills/coding/references/react/rules/js-min-max-loop.md` - O(n) instead of O(n log n)
- `skills/coding/references/react/rules/js-set-map-lookups.md` - O(n) to O(1)
- `skills/coding/references/react/rules/js-tosorted-immutable.md` - prevents mutation bugs in React state
- `skills/coding/references/react/rules/rendering-activity.md` - preserves state/DOM
- `skills/coding/references/react/rules/rendering-animate-svg-wrapper.md` - enables hardware acceleration
- `skills/coding/references/react/rules/rendering-conditional-render.md` - prevents rendering 0 or NaN
- `skills/coding/references/react/rules/rendering-content-visibility.md` - faster initial render
- `skills/coding/references/react/rules/rendering-hoist-jsx.md` - avoids re-creation
- `skills/coding/references/react/rules/rendering-hydration-no-flicker.md` - avoids visual flicker and hydration errors
- `skills/coding/references/react/rules/rendering-svg-precision.md` - reduces file size
- `skills/coding/references/react/rules/rerender-defer-reads.md` - avoids unnecessary subscriptions
- `skills/coding/references/react/rules/rerender-dependencies.md` - minimizes effect re-runs
- `skills/coding/references/react/rules/rerender-derived-state.md` - reduces re-render frequency
- `skills/coding/references/react/rules/rerender-functional-setstate.md` - prevents stale closures and unnecessary callback recreations
- `skills/coding/references/react/rules/rerender-lazy-state-init.md` - wasted computation on every render
- `skills/coding/references/react/rules/rerender-memo.md` - enables early returns
- `skills/coding/references/react/rules/rerender-transitions.md` - maintains UI responsiveness
- `skills/coding/references/react/rules/server-after-nonblocking.md` - faster response times
- `skills/coding/references/react/rules/server-cache-lru.md` - caches across requests
- `skills/coding/references/react/rules/server-cache-react.md` - deduplicates within request
- `skills/coding/references/react/rules/server-parallel-fetching.md` - eliminates server-side waterfalls
- `skills/coding/references/react/rules/server-serialization.md` - reduces data transfer size
