---

description: Index of reference files for skills/coding/references/react.
metadata:
  id: coding.ref.react.index
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - index
    - react
    - references
    - references react index
    - reference index
  priority: 30
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: true

---

# React/Next.js Best Practices (Reference)

Use this reference for React or Next.js performance, data fetching, rendering, and UI quality reviews.

## When to Apply
- Writing or refactoring React components or Next.js pages/routes
- Reviewing performance (waterfalls, bundle size, rendering)
- Auditing UI quality or accessibility issues

## References
- `skills/coding/references/react/react-best-practices.md` - full Vercel React/Next.js guide
- `skills/coding/references/react/rules/index.md` - rule-level React/Next.js index
- `skills/coding/references/react/web-interface-guidelines.md` - UI review checklist source and workflow
## Rule Categories (by prefix)
- `async-` — eliminating waterfalls
- `bundle-` — bundle size optimization
- `server-` — server-side performance
- `client-` — client-side data fetching
- `rerender-` — re-render optimization
- `rendering-` — rendering performance
- `js-` — JavaScript performance
- `advanced-` — advanced patterns

## Quick lookup
```
rg -n "async-" skills/coding/references/react/rules/
rg -n "bundle-" skills/coding/references/react/rules/
rg -n "server-" skills/coding/references/react/rules/
rg -n "rendering-" skills/coding/references/react/rules/
```
