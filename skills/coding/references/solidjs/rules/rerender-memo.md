---

title: Extract to Memoized Computations or Components
impact: MEDIUM
impactDescription: reduces reactive work
tags: reactivity, memo, optimization
metadata:
  id: coding.ref.solidjs.rules.rerender-memo
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - references
    - rerender memo
    - rules
    - solidjs
    - references solidjs rules rerender-memo
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

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
