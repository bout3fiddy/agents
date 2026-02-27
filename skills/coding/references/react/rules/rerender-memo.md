---

title: Extract to Memoized Components
impact: MEDIUM
impactDescription: enables early returns
tags: rerender, memo, useMemo, optimization
metadata:
  id: coding.ref.react.rules.rerender-memo
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - react
    - references
    - rerender memo
    - rules
    - references react rules rerender-memo
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Extract to Memoized Components

Extract expensive work into memoized components to enable early returns before computation.

**Incorrect (computes avatar even when loading):**

```tsx
function Profile({ user, loading }: Props) {
  const avatar = useMemo(() => {
    const id = computeAvatarId(user)
    return <Avatar id={id} />
  }, [user])

  if (loading) return <Skeleton />
  return <div>{avatar}</div>
}
```

**Correct (skips computation when loading):**

```tsx
const UserAvatar = memo(function UserAvatar({ user }: { user: User }) {
  const id = useMemo(() => computeAvatarId(user), [user])
  return <Avatar id={id} />
})

function Profile({ user, loading }: Props) {
  if (loading) return <Skeleton />
  return (
    <div>
      <UserAvatar user={user} />
    </div>
  )
}
```

**Note:** If your project has [React Compiler](https://react.dev/learn/react-compiler) enabled, manual memoization with `memo()` and `useMemo()` is not necessary. The compiler automatically optimizes re-renders.
