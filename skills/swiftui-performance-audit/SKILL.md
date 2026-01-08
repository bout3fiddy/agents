---
name: swiftui-performance-audit
description: Audit and improve SwiftUI runtime performance from code review and architecture. Use for requests to diagnose slow rendering, janky scrolling, high CPU/memory usage, excessive view updates, or layout thrash in SwiftUI apps, and to provide guidance for user-run Instruments profiling when code review alone is insufficient.
metadata:
  version: "1.0.0"
---

# SwiftUI Performance Audit

## Overview

Audit SwiftUI view performance end-to-end, from instrumentation and baselining to root-cause analysis and concrete remediation steps.

---

## Workflow Decision Tree

- If the user provides code, start with "Code-First Review."
- If the user only describes symptoms, ask for minimal code/context, then do "Code-First Review."
- If code review is inconclusive, go to "Guide the User to Profile" and ask for a trace or screenshots.

---

## 1. Code-First Review

### Collect

- Target view/feature code.
- Data flow: state, environment, observable models.
- Symptoms and reproduction steps.

### Focus on

- View invalidation storms from broad state changes.
- Unstable identity in lists (`id` churn, `UUID()` per render).
- Heavy work in `body` (formatting, sorting, image decoding).
- Layout thrash (deep stacks, `GeometryReader`, preference chains).
- Large images without downsampling or resizing.
- Over-animated hierarchies (implicit animations on large trees).

### Provide

- Likely root causes with code references.
- Suggested fixes and refactors.
- If needed, a minimal repro or instrumentation suggestion.

---

## 2. Guide the User to Profile

Explain how to collect data with Instruments:

- Use the SwiftUI template in Instruments (Release build).
- Reproduce the exact interaction (scroll, navigation, animation).
- Capture SwiftUI timeline and Time Profiler.
- Export or screenshot the relevant lanes and the call tree.

### Ask for

- Trace export or screenshots of SwiftUI lanes + Time Profiler call tree.
- Device/OS/build configuration.

---

## 3. Analyze and Diagnose

Prioritize likely SwiftUI culprits:

- View invalidation storms from broad state changes.
- Unstable identity in lists (`id` churn, `UUID()` per render).
- Heavy work in `body` (formatting, sorting, image decoding).
- Layout thrash (deep stacks, `GeometryReader`, preference chains).
- Large images without downsampling or resizing.
- Over-animated hierarchies (implicit animations on large trees).

Summarize findings with evidence from traces/logs.

---

## 4. Remediate

Apply targeted fixes:

- Narrow state scope (`@State`/`@Observable` closer to leaf views).
- Stabilize identities for `ForEach` and lists.
- Move heavy work out of `body` (precompute, cache, `@State`).
- Use `equatable()` or value wrappers for expensive subtrees.
- Downsample images before rendering.
- Reduce layout complexity or use fixed sizing where possible.

---

## Common Code Smells (and Fixes)

### Expensive formatters in `body`

```swift
// BAD: Slow allocation every render
var body: some View {
    let number = NumberFormatter()
    let measure = MeasurementFormatter()
    Text(measure.string(from: .init(value: meters, unit: .meters)))
}

// GOOD: Cached formatters
final class DistanceFormatter {
    static let shared = DistanceFormatter()
    let number = NumberFormatter()
    let measure = MeasurementFormatter()
}
```

### Computed properties that do heavy work

```swift
// BAD: Runs on every body eval
var filtered: [Item] {
    items.filter { $0.isEnabled }
}

// GOOD: Precompute or cache on change
@State private var filtered: [Item] = []
// Update filtered when inputs change
```

### Sorting/filtering in `body` or `ForEach`

```swift
// BAD: Sort runs every render
List {
    ForEach(items.sorted(by: sortRule)) { item in
        Row(item)
    }
}

// GOOD: Sort once before view updates
let sortedItems = items.sorted(by: sortRule)
```

### Inline filtering in `ForEach`

```swift
// BAD: Filter runs every render
ForEach(items.filter { $0.isEnabled }) { item in
    Row(item)
}

// GOOD: Prefiltered collection with stable identity
```

### Unstable identity

```swift
// BAD: id: \.self for non-stable values
ForEach(items, id: \.self) { item in
    Row(item)
}

// GOOD: Use a stable ID
ForEach(items, id: \.id) { item in
    Row(item)
}
```

### Image decoding on the main thread

```swift
// BAD: Blocking main thread
Image(uiImage: UIImage(data: data)!)

// GOOD: Decode/downsample off main thread and store result
```

### Broad dependencies in observable models

```swift
// BAD: Entire view updates when any item changes
@Observable class Model {
    var items: [Item] = []
}

var body: some View {
    Row(isFavorite: model.items.contains(item))
}

// GOOD: Granular view models or per-item state
```

---

## Performance Patterns

### Narrow State Scope

```swift
// BAD: State at top level causes full tree updates
struct ParentView: View {
    @State private var selectedId: String?
    
    var body: some View {
        List(items) { item in
            ItemRow(item: item, isSelected: item.id == selectedId)
        }
    }
}

// GOOD: Selection state in child
struct ItemRow: View {
    let item: Item
    @State private var isSelected = false
    
    var body: some View {
        // Only this row updates
    }
}
```

### Equatable for Expensive Views

```swift
struct ExpensiveView: View, Equatable {
    let data: SomeData
    
    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.data.id == rhs.data.id
    }
    
    var body: some View {
        // Complex rendering
    }
}

// Usage
ExpensiveView(data: data)
    .equatable()
```

### Lazy Loading

```swift
// Use LazyVStack/LazyHStack for long lists
LazyVStack {
    ForEach(items) { item in
        ItemRow(item: item)
    }
}
```

### Image Downsampling

```swift
func downsample(imageAt url: URL, to size: CGSize) -> UIImage? {
    let options: [CFString: Any] = [
        kCGImageSourceCreateThumbnailFromImageIfAbsent: true,
        kCGImageSourceCreateThumbnailWithTransform: true,
        kCGImageSourceThumbnailMaxPixelSize: max(size.width, size.height)
    ]
    
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    else { return nil }
    
    return UIImage(cgImage: cgImage)
}
```

---

## 5. Verify

Ask the user to re-run the same capture and compare with baseline metrics.
Summarize the delta (CPU, frame drops, memory peak) if provided.

---

## Outputs

Provide:

- A short metrics table (before/after if available).
- Top issues (ordered by impact).
- Proposed fixes with estimated effort.

---

## Checklist

Before optimizing:

1. **Identify the symptom** - Jank, slow scroll, high CPU, memory spike?
2. **Get the code** - Which view/feature is affected?
3. **Check data flow** - How is state structured and passed?
4. **Look for smells** - Heavy `body`, unstable IDs, broad state?
5. **Profile if needed** - Use Instruments for definitive data
6. **Apply targeted fixes** - Don't over-optimize
7. **Verify improvement** - Measure before/after
