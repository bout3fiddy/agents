---
title: Minimize Serialization at RSC Boundaries
impact: HIGH
impactDescription: reduces data transfer size
tags: server, rsc, serialization, props
---

## Minimize Serialization at RSC Boundaries

**Impact: HIGH (reduces data transfer size)**

Serialize only the fields the client needs to minimize payloads.

**Incorrect:**

```ts
return <Profile user={user} />
```

**Correct:**

```ts
return <Profile name={user.name} />
```
