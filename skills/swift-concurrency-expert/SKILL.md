---
name: swift-concurrency-expert
description: Swift Concurrency review and remediation for Swift 6.2+. Use when asked to review Swift Concurrency usage, improve concurrency compliance, or fix Swift concurrency compiler errors in a feature or file.
metadata:
  version: "1.0.0"
---

# Swift Concurrency Expert

## Overview

Review and fix Swift Concurrency issues in Swift 6.2+ codebases by applying actor isolation, Sendable safety, and modern concurrency patterns with minimal behavior changes.

## Workflow

### 1. Triage the issue

- Capture the exact compiler diagnostics and the offending symbol(s).
- Identify the current actor context (`@MainActor`, `actor`, `nonisolated`) and whether a default actor isolation mode is enabled.
- Confirm whether the code is UI-bound or intended to run off the main actor.

### 2. Apply the smallest safe fix

Prefer edits that preserve existing behavior while satisfying data-race safety.

Common fixes:
- **UI-bound types**: annotate the type or relevant members with `@MainActor`.
- **Protocol conformance on main actor types**: make the conformance isolated (e.g., `extension Foo: @MainActor SomeProtocol`).
- **Global/static state**: protect with `@MainActor` or move into an actor.
- **Background work**: move expensive work into a `@concurrent` async function on a `nonisolated` type or use an `actor` to guard mutable state.
- **Sendable errors**: prefer immutable/value types; add `Sendable` conformance only when correct; avoid `@unchecked Sendable` unless you can prove thread safety.

---

## Common Patterns

### UI-bound types

```swift
@MainActor
class ViewModel: ObservableObject {
    @Published var items: [Item] = []
    
    func loadItems() async {
        items = await fetchItems()
    }
}
```

### Protocol conformance on main actor types

```swift
extension ViewModel: @MainActor SomeDelegate {
    func delegateCallback() {
        // Safe to access @MainActor state
    }
}
```

### Actor for mutable state

```swift
actor DataStore {
    private var cache: [String: Data] = [:]
    
    func get(_ key: String) -> Data? {
        cache[key]
    }
    
    func set(_ key: String, value: Data) {
        cache[key] = value
    }
}
```

### Background work with nonisolated

```swift
class ImageProcessor {
    nonisolated func processImage(_ data: Data) async -> UIImage? {
        // Heavy computation runs off main actor
        await Task.detached {
            // Process image data
        }.value
    }
}
```

### Sendable conformance

```swift
// Prefer value types for Sendable
struct Configuration: Sendable {
    let apiKey: String
    let timeout: TimeInterval
}

// Use @unchecked only when you can prove thread safety
final class ThreadSafeCache: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [String: Any] = [:]
    
    func get(_ key: String) -> Any? {
        lock.lock()
        defer { lock.unlock() }
        return storage[key]
    }
}
```

---

## Swift 6.2 Key Changes

### Default Actor Isolation

Swift 6.2 allows setting a default actor isolation mode at the module level:

```swift
// In Package.swift or build settings
// -default-isolation MainActor
```

### @concurrent attribute

Use `@concurrent` to explicitly mark async functions that should run concurrently:

```swift
@concurrent
func fetchData() async -> Data {
    // Runs on a background executor
}
```

### Improved Sendable inference

Swift 6.2 has better inference for:
- Frozen structs with Sendable fields
- Final classes with immutable Sendable properties
- Actor-isolated closures

---

## Checklist

Before fixing concurrency issues:

1. **Identify the actor context** - What actor (if any) is the code isolated to?
2. **Check Sendable requirements** - Are values crossing actor boundaries Sendable?
3. **Preserve behavior** - Will the fix change when/where code executes?
4. **Minimal changes** - Apply the smallest fix that satisfies the compiler
5. **Avoid @unchecked** - Only use when thread safety is proven

---

## Anti-patterns to Avoid

### Overusing @unchecked Sendable

```swift
// BAD: Hiding real concurrency issues
class NotSafe: @unchecked Sendable {
    var mutableState: Int = 0 // Data race!
}

// GOOD: Use proper synchronization
actor SafeCounter: Sendable {
    var count: Int = 0
}
```

### Blocking the main actor

```swift
// BAD: Blocking main thread
@MainActor
func loadData() {
    let data = URLSession.shared.data(from: url) // Blocks!
}

// GOOD: Use async
@MainActor
func loadData() async {
    let data = try await URLSession.shared.data(from: url)
}
```

### Unnecessary actor hopping

```swift
// BAD: Hopping to main actor just to hop back
func process() async {
    await MainActor.run {
        // Nothing UI-related here
    }
}

// GOOD: Stay on current executor unless needed
nonisolated func process() async {
    // Runs on caller's executor
}
```
