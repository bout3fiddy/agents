---

title: CSS content-visibility for Long Lists
impact: HIGH
impactDescription: faster initial render
tags: rendering, css, content-visibility, long-lists
metadata:
  id: coding.ref.react.rules.rendering-content-visibility
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - react
    - references
    - rendering content visibility
    - rules
    - references react rules rendering-content-visibility
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## CSS content-visibility for Long Lists

Apply `content-visibility: auto` to defer off-screen rendering.

**CSS:**

```css
.message-item {
  content-visibility: auto;
  contain-intrinsic-size: 0 80px;
}
```

**Example:**

```tsx
function MessageList({ messages }: { messages: Message[] }) {
  return (
    <div className="overflow-y-auto h-screen">
      {messages.map(msg => (
        <div key={msg.id} className="message-item">
          <Avatar user={msg.author} />
          <div>{msg.content}</div>
        </div>
      ))}
    </div>
  )
}
```

For 1000 messages, browser skips layout/paint for ~990 off-screen items (10× faster initial render).
