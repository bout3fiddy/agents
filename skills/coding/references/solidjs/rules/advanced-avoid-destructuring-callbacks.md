---

title: Avoid Destructuring Callback Props When You Need the Latest Function
impact: LOW
impactDescription: prevents stale callbacks
tags: advanced, callbacks, props, reactivity
metadata:
  id: coding.ref.solidjs.rules.advanced-avoid-destructuring-callbacks
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - advanced avoid destructuring callbacks
    - references
    - rules
    - solidjs
    - references solidjs rules advanced-avoid-destructuring-callbacks
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Avoid Destructuring Callback Props When You Need the Latest Function

If you destructure a callback prop, you can capture a stale function reference. Prefer calling via `props` at the usage site so it stays reactive.

```ts
import { createEffect, createSignal, onCleanup } from "solid-js";

function SearchInput(props: { onSearch: (q: string) => void }) {
  const [q, setQ] = createSignal("");

  createEffect(() => {
    const id = setTimeout(() => props.onSearch(q()), 300);
    onCleanup(() => clearTimeout(id));
  });
}
```
