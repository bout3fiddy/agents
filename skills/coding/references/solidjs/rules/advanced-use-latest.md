---
title: useLatest for Stable Callback Refs
impact: LOW
impactDescription: prevents effect re-runs
tags: advanced, hooks, useLatest, refs, optimization
---

## useLatest for Stable Callback Refs

**Impact: LOW (prevents effect re-runs)**

Access the latest value inside callbacks without forcing re‑subscriptions or re‑effects.

**Incorrect:**

```ts
function SearchInput(props) {
  const [query, setQuery] = createSignal('')
  createEffect(() => {
    const id = setTimeout(() => props.onSearch(query()), 300)
    onCleanup(() => clearTimeout(id))
  })
}
```

**Correct:**

```ts
function useLatest(value) {
  const [latest, setLatest] = createSignal(value)
  createEffect(() => setLatest(value))
  return latest
}

function SearchInput(props) {
  const [query, setQuery] = createSignal('')
  const onSearch = useLatest(props.onSearch)
  createEffect(() => {
    const id = setTimeout(() => onSearch()(query()), 300)
    onCleanup(() => clearTimeout(id))
  })
}
```
