---
name: swiftui-liquid-glass
description: Implement, review, or improve SwiftUI features using the iOS 26+ Liquid Glass API. Use when asked to adopt Liquid Glass in new SwiftUI UI, refactor an existing feature to Liquid Glass, or review Liquid Glass usage for correctness, performance, and design alignment.
metadata:
  version: "1.0.0"
---

# SwiftUI Liquid Glass

## Overview

Use this skill to build or review SwiftUI features that fully align with the iOS 26+ Liquid Glass API. Prioritize native APIs (`glassEffect`, `GlassEffectContainer`, glass button styles) and Apple design guidance. Keep usage consistent, interactive where needed, and performance aware.

## Workflow Decision Tree

Choose the path that matches the request:

### 1) Review an existing feature

- Inspect where Liquid Glass should be used and where it should not.
- Verify correct modifier order, shape usage, and container placement.
- Check for iOS 26+ availability handling and sensible fallbacks.

### 2) Improve a feature using Liquid Glass

- Identify target components for glass treatment (surfaces, chips, buttons, cards).
- Refactor to use `GlassEffectContainer` where multiple glass elements appear.
- Introduce interactive glass only for tappable or focusable elements.

### 3) Implement a new feature using Liquid Glass

- Design the glass surfaces and interactions first (shape, prominence, grouping).
- Add glass modifiers after layout/appearance modifiers.
- Add morphing transitions only when the view hierarchy changes with animation.

---

## Core Guidelines

- Prefer native Liquid Glass APIs over custom blurs.
- Use `GlassEffectContainer` when multiple glass elements coexist.
- Apply `.glassEffect(...)` after layout and visual modifiers.
- Use `.interactive()` for elements that respond to touch/pointer.
- Keep shapes consistent across related elements for a cohesive look.
- Gate with `#available(iOS 26, *)` and provide a non-glass fallback.

---

## Review Checklist

- **Availability**: `#available(iOS 26, *)` present with fallback UI.
- **Composition**: Multiple glass views wrapped in `GlassEffectContainer`.
- **Modifier order**: `glassEffect` applied after layout/appearance modifiers.
- **Interactivity**: `interactive()` only where user interaction exists.
- **Transitions**: `glassEffectID` used with `@Namespace` for morphing.
- **Consistency**: Shapes, tinting, and spacing align across the feature.

---

## Implementation Checklist

- Define target elements and desired glass prominence.
- Wrap grouped glass elements in `GlassEffectContainer` and tune spacing.
- Use `.glassEffect(.regular.tint(...).interactive(), in: .rect(cornerRadius: ...))` as needed.
- Use `.buttonStyle(.glass)` / `.buttonStyle(.glassProminent)` for actions.
- Add morphing transitions with `glassEffectID` when hierarchy changes.
- Provide fallback materials and visuals for earlier iOS versions.

---

## Quick Snippets

Use these patterns directly and tailor shapes/tints/spacing.

### Basic Glass Effect with Fallback

```swift
if #available(iOS 26, *) {
    Text("Hello")
        .padding()
        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 16))
} else {
    Text("Hello")
        .padding()
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
}
```

### Glass Effect Container

```swift
GlassEffectContainer(spacing: 24) {
    HStack(spacing: 24) {
        Image(systemName: "scribble.variable")
            .frame(width: 72, height: 72)
            .font(.system(size: 32))
            .glassEffect()
        Image(systemName: "eraser.fill")
            .frame(width: 72, height: 72)
            .font(.system(size: 32))
            .glassEffect()
    }
}
```

### Glass Button Styles

```swift
Button("Confirm") { }
    .buttonStyle(.glassProminent)

Button("Cancel") { }
    .buttonStyle(.glass)
```

### Morphing Transitions

```swift
struct MorphingExample: View {
    @Namespace private var namespace
    @State private var isExpanded = false
    
    var body: some View {
        if isExpanded {
            ExpandedCard()
                .glassEffectID("card", in: namespace)
        } else {
            CollapsedCard()
                .glassEffectID("card", in: namespace)
        }
    }
}
```

### Custom Tinting

```swift
Text("Tinted Glass")
    .padding()
    .glassEffect(.regular.tint(.blue.opacity(0.3)), in: .capsule)
```

---

## Common Patterns

### Navigation Bar with Glass

```swift
@available(iOS 26, *)
struct GlassNavigationBar: View {
    var body: some View {
        HStack {
            Button(action: {}) {
                Image(systemName: "chevron.left")
            }
            Spacer()
            Text("Title")
                .font(.headline)
            Spacer()
            Button(action: {}) {
                Image(systemName: "ellipsis")
            }
        }
        .padding()
        .glassEffect(.regular, in: .rect(cornerRadius: 20))
    }
}
```

### Floating Action Button

```swift
@available(iOS 26, *)
struct FloatingActionButton: View {
    let action: () -> Void
    
    var body: some View {
        Button(action: action) {
            Image(systemName: "plus")
                .font(.title2)
                .frame(width: 56, height: 56)
        }
        .buttonStyle(.glassProminent)
    }
}
```

### Card Grid with Glass

```swift
@available(iOS 26, *)
struct GlassCardGrid: View {
    let items: [Item]
    
    var body: some View {
        GlassEffectContainer(spacing: 16) {
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 150))], spacing: 16) {
                ForEach(items) { item in
                    ItemCard(item: item)
                        .glassEffect(.regular.interactive(), in: .rect(cornerRadius: 12))
                }
            }
        }
    }
}
```

---

## Performance Considerations

- Limit glass effects to visible elements; avoid applying to off-screen content.
- Use `GlassEffectContainer` to batch multiple glass elements for better performance.
- Avoid animating glass properties frequently; prefer morphing transitions.
- Test on actual devices, as glass effects are GPU-intensive.

---

## Fallback Strategy

Always provide meaningful fallbacks for pre-iOS 26:

```swift
struct AdaptiveGlassView: View {
    var body: some View {
        if #available(iOS 26, *) {
            content
                .glassEffect(.regular, in: .rect(cornerRadius: 16))
        } else {
            content
                .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
        }
    }
    
    @ViewBuilder
    private var content: some View {
        // Shared content
    }
}
```
