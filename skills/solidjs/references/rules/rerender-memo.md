---
title: Extract to Memoized Components
impact: MEDIUM
impactDescription: enables early returns
tags: rerender, memo, useMemo, optimization
---

## Extract to Memoized Components

**Impact: MEDIUM (enables early returns)**

Isolate expensive work in memoized computations or child components.

**Incorrect:**

```ts
const avatar = createMemo(() => computeAvatar(user()))
return loading() ? <Skeleton/> : <Avatar id={avatar()} />
```

**Correct:**

```ts
const UserAvatar = (props) => {
  const id = createMemo(() => computeAvatar(props.user))
  return <Avatar id={id()} />
}
return loading() ? <Skeleton/> : <UserAvatar user={user()} />
```
