---
title: Extract to Memoized Computations or Components
impact: MEDIUM
impactDescription: reduces reactive work
tags: reactivity, memo, optimization
---

## Extract to Memoized Computations or Components

**Impact: MEDIUM (reduces reactive work)**

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
