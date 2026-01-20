# React/Next.js Best Practices (Reference)

Use this reference for React or Next.js performance, data fetching, rendering, and UI quality reviews.

## When to Apply
- Writing or refactoring React components or Next.js pages/routes
- Reviewing performance (waterfalls, bundle size, rendering)
- Auditing UI quality or accessibility issues

## References
- `references/react/react-best-practices.md` — full Vercel React/Next.js guide
- `references/react/rules/` — individual rule files (by category)
- `references/react/web-interface-guidelines.md` — UI review checklist source and workflow

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
rg -n "async-" references/react/rules/
rg -n "bundle-" references/react/rules/
rg -n "server-" references/react/rules/
rg -n "rendering-" references/react/rules/
```
