---
title: Parallel Data Fetching with Component Composition
impact: HIGH
impactDescription: eliminates server-side waterfalls
tags: server, rsc, parallel-fetching, composition
---

## Parallel Data Fetching with Component Composition

**Impact: HIGH (eliminates server-side waterfalls)**

Parallelize server data fetching by composing independent fetches.

**Incorrect:**

```ts
async function Page() {
  const header = await fetchHeader()
  const sidebar = await fetchSidebar()
  return render(header, sidebar)
}
```

**Correct:**

```ts
async function Header() { return fetchHeader() }
async function Sidebar() { return fetchSidebar() }
function Page() { return render(Header(), Sidebar()) }
```
