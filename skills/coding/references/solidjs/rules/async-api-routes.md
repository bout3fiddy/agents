---
title: Prevent Waterfall Chains in API Routes
impact: CRITICAL
impactDescription: avoids request waterfalls
tags: api-routes, waterfalls, parallelization
---

## Prevent Waterfall Chains in API Routes

**Impact: CRITICAL (avoids request waterfalls)**

Start independent async work immediately inside API handlers to avoid request waterfalls.

**Incorrect:**

```ts
import type { APIEvent } from "@solidjs/start/server";
import { json } from "@solidjs/router";
import { getCookie } from "vinxi/http";

export async function GET(event: APIEvent) {
  const userId = getCookie("userId");
  if (!userId) return new Response("Not logged in", { status: 401 });

  const targetId = event.params.userId;
  const session = await auth(userId);
  const config = await fetchConfig();
  const data = await fetchData(targetId);
  return json({ data, config });
}
```

**Correct:**

```ts
import type { APIEvent } from "@solidjs/start/server";
import { json } from "@solidjs/router";
import { getCookie } from "vinxi/http";

export async function GET(event: APIEvent) {
  const userId = getCookie("userId");
  if (!userId) return new Response("Not logged in", { status: 401 });

  const targetId = event.params.userId;
  const sessionPromise = auth(userId);
  const configPromise = fetchConfig();
  const session = await sessionPromise;
  const [config, data] = await Promise.all([
    configPromise,
    fetchData(targetId),
  ]);
  return json({ data, config });
}
```
