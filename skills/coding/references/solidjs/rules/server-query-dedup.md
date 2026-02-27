---

title: Use query() + createAsync() for request dedupe and shared caching
impact: HIGH
impactDescription: deduplicates and shares server fetches
tags: server, query, createAsync, cache, solidstart
metadata:
  id: coding.ref.solidjs.rules.server-query-dedup
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - references
    - rules
    - server query dedup
    - solidjs
    - references solidjs rules server-query-dedup
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Use `query()` + `createAsync()` for request dedupe and shared caching

**Impact: HIGH (deduplicates and shares server fetches)**

In SolidStart, define data fetchers with `query()` and read them with `createAsync()`. This integrates with SSR, Suspense, error handling, and route preloading. The older `cache()` helper is deprecated in favor of `query()`.

```ts
import { For } from "solid-js";
import { query, createAsync } from "@solidjs/router";

const getPosts = query(async () => {
  const res = await fetch("https://my-api.com/posts");
  return res.json();
}, "posts");

export default function Page() {
  const posts = createAsync(() => getPosts());
  return <For each={posts()}>{(p) => <li>{p.title}</li>}</For>;
}
```

When requests are independent, start them in parallel with multiple queries instead of chaining `await`s.
