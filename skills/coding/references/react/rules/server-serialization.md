---

title: Minimize Serialization at RSC Boundaries
impact: HIGH
impactDescription: reduces data transfer size
tags: server, rsc, serialization, props
metadata:
  id: coding.ref.react.rules.server-serialization
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - react
    - references
    - rules
    - server serialization
    - references react rules server-serialization
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Minimize Serialization at RSC Boundaries

The React Server/Client boundary serializes all object properties into strings and embeds them in the HTML response and subsequent RSC requests. This serialized data directly impacts page weight and load time, so **size matters a lot**. Only pass fields that the client actually uses.

**Incorrect (serializes all 50 fields):**

```tsx
async function Page() {
  const user = await fetchUser()  // 50 fields
  return <Profile user={user} />
}

'use client'
function Profile({ user }: { user: User }) {
  return <div>{user.name}</div>  // uses 1 field
}
```

**Correct (serializes only 1 field):**

```tsx
async function Page() {
  const user = await fetchUser()
  return <Profile name={user.name} />
}

'use client'
function Profile({ name }: { name: string }) {
  return <div>{name}</div>
}
```
