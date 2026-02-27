---

title: Preload Based on User Intent
impact: MEDIUM
impactDescription: reduces perceived latency
tags: bundle, preload, user-intent, hover
metadata:
  id: coding.ref.react.rules.bundle-preload
  version: "1"
  task_types:
    - coding
  trigger_phrases:
    - bundle preload
    - react
    - references
    - rules
    - references react rules bundle-preload
  priority: 72
  load_strategy: progressive
  activation_policy: both
  workflow_triggers:
  route_exclude: false

---


## Preload Based on User Intent

Preload heavy bundles before they're needed to reduce perceived latency.

**Example (preload on hover/focus):**

```tsx
function EditorButton({ onClick }: { onClick: () => void }) {
  const preload = () => {
    if (typeof window !== 'undefined') {
      void import('./monaco-editor')
    }
  }

  return (
    <button
      onMouseEnter={preload}
      onFocus={preload}
      onClick={onClick}
    >
      Open Editor
    </button>
  )
}
```

**Example (preload when feature flag is enabled):**

```tsx
function FlagsProvider({ children, flags }: Props) {
  useEffect(() => {
    if (flags.editorEnabled && typeof window !== 'undefined') {
      void import('./monaco-editor').then(mod => mod.init())
    }
  }, [flags.editorEnabled])

  return <FlagsContext.Provider value={flags}>
    {children}
  </FlagsContext.Provider>
}
```

The `typeof window !== 'undefined'` check prevents bundling preloaded modules for SSR, optimizing server bundle size and build speed.
