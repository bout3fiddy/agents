---
title: Strategic Suspense Boundaries
impact: HIGH
impactDescription: faster initial paint
tags: async, suspense, streaming, layout-shift
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
