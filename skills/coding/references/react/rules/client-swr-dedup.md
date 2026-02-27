---

title: Use SWR for Automatic Deduplication
impact: MEDIUM-HIGH
impactDescription: automatic deduplication
tags: client, swr, deduplication, data-fetching
metadata:
  id: coding.ref.react.rules.client-swr-dedup
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - client swr dedup
    - react
    - references
    - rules
    - references react rules client-swr-dedup
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Use SWR for Automatic Deduplication

SWR enables request deduplication, caching, and revalidation across component instances.

**Incorrect (no deduplication, each instance fetches):**

```tsx
function UserList() {
  const [users, setUsers] = useState([])
  useEffect(() => {
    fetch('/api/users')
      .then(r => r.json())
      .then(setUsers)
  }, [])
}
```

**Correct (multiple instances share one request):**

```tsx
import useSWR from 'swr'

function UserList() {
  const { data: users } = useSWR('/api/users', fetcher)
}
```

**For immutable data:**

```tsx
import { useImmutableSWR } from '@/lib/swr'

function StaticContent() {
  const { data } = useImmutableSWR('/api/config', fetcher)
}
```

**For mutations:**

```tsx
import { useSWRMutation } from 'swr/mutation'

function UpdateButton() {
  const { trigger } = useSWRMutation('/api/user', updateUser)
  return <button onClick={() => trigger()}>Update</button>
}
```

Reference: [https://swr.vercel.app](https://swr.vercel.app)
