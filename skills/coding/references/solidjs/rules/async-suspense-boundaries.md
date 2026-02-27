---

title: Strategic Suspense Boundaries
impact: HIGH
impactDescription: faster initial paint
tags: async, suspense, streaming, layout-shift
metadata:
  id: coding.ref.solidjs.rules.async-suspense-boundaries
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - async suspense boundaries
    - references
    - rules
    - solidjs
    - references solidjs rules async-suspense-boundaries
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Strategic Suspense Boundaries

**Impact: HIGH (faster initial paint)**

Use Suspense boundaries to render the shell immediately while data loads in leaf components.

**Incorrect:**

```ts
function Page() {
  const [data] = createResource(fetchData)
  return (
    <div>
      <Header />
      <DataDisplay data={data()} />
      <Footer />
    </div>
  )
}
```

**Correct:**

```ts
function Page() {
  return (
    <div>
      <Header />
      <Suspense fallback={<Skeleton />}>
        <DataDisplay />
      </Suspense>
      <Footer />
    </div>
  )
}

function DataDisplay() {
  const [data] = createResource(fetchData)
  return <div>{data()?.content}</div>
}
```
