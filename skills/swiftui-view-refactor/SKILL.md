---
name: swiftui-view-refactor
description: Refactor and review SwiftUI view files for consistent structure, dependency injection, and Observation usage. Use when asked to clean up a SwiftUI view's layout/ordering, handle view models safely (non-optional when possible), or standardize how dependencies and @Observable state are initialized and passed.
metadata:
  version: "1.0.0"
---

# SwiftUI View Refactor

## Overview

Apply a consistent structure and dependency pattern to SwiftUI views, with a focus on ordering, Model-View (MV) patterns, careful view model handling, and correct Observation usage.

---

## Core Guidelines

### 1) View ordering (top to bottom)

- Environment
- `private`/`public` `let`
- `@State` / other stored properties
- computed `var` (non-view)
- `init`
- `body`
- computed view builders / other view helpers
- helper / async functions

### 2) Prefer MV (Model-View) patterns

- Default to MV: Views are lightweight state expressions; models/services own business logic.
- Favor `@State`, `@Environment`, `@Query`, and `task`/`onChange` for orchestration.
- Inject services and shared models via `@Environment`; keep views small and composable.
- Split large views into subviews rather than introducing a view model.

### 3) Split large bodies and view properties

- If `body` grows beyond a screen or has multiple logical sections, split it into smaller subviews.
- Extract large computed view properties (`var header: some View { ... }`) into dedicated `View` types when they carry state or complex branching.
- It's fine to keep related subviews as computed view properties in the same file; extract to a standalone `View` struct only when it structurally makes sense or when reuse is intended.
- Prefer passing small inputs (data, bindings, callbacks) over reusing the entire parent view state.

### 4) View model handling (only if already present)

- Do not introduce a view model unless the request or existing code clearly calls for one.
- If a view model exists, make it non-optional when possible.
- Pass dependencies to the view via `init`, then pass them into the view model in the view's `init`.
- Avoid `bootstrapIfNeeded` patterns.

### 5) Observation usage

- For `@Observable` reference types, store them as `@State` in the root view.
- Pass observables down explicitly as needed; avoid optional state unless required.

---

## Workflow

1. Reorder the view to match the ordering rules.
2. Favor MV: move lightweight orchestration into the view using `@State`, `@Environment`, `@Query`, `task`, and `onChange`.
3. If a view model exists, replace optional view models with a non-optional `@State` view model initialized in `init` by passing dependencies from the view.
4. Confirm Observation usage: `@State` for root `@Observable` view models, no redundant wrappers.
5. Keep behavior intact: do not change layout or business logic unless requested.

---

## Examples

### Proper View Ordering

```swift
struct UserProfileView: View {
    // 1. Environment
    @Environment(\.dismiss) private var dismiss
    @Environment(UserService.self) private var userService
    
    // 2. Constants
    private let userId: String
    
    // 3. State
    @State private var user: User?
    @State private var isLoading = false
    
    // 4. Computed vars (non-view)
    private var displayName: String {
        user?.name ?? "Unknown"
    }
    
    // 5. Init
    init(userId: String) {
        self.userId = userId
    }
    
    // 6. Body
    var body: some View {
        content
            .task { await loadUser() }
    }
    
    // 7. View helpers
    @ViewBuilder
    private var content: some View {
        if isLoading {
            ProgressView()
        } else if let user {
            UserDetails(user: user)
        }
    }
    
    // 8. Helper functions
    private func loadUser() async {
        isLoading = true
        user = await userService.fetchUser(id: userId)
        isLoading = false
    }
}
```

### Extracting Sections

```swift
var body: some View {
    VStack(alignment: .leading, spacing: 16) {
        HeaderSection(title: title, isPinned: isPinned)
        DetailsSection(details: details)
        ActionsSection(onSave: onSave, onCancel: onCancel)
    }
}
```

### Computed Views in Same File

```swift
var body: some View {
    List {
        header
        filters
        results
        footer
    }
}

private var header: some View {
    VStack(alignment: .leading, spacing: 6) {
        Text(title).font(.title2)
        Text(subtitle).font(.subheadline)
    }
}

private var filters: some View {
    ScrollView(.horizontal, showsIndicators: false) {
        HStack {
            ForEach(filterOptions, id: \.self) { option in
                FilterChip(option: option, isSelected: option == selectedFilter)
                    .onTapGesture { selectedFilter = option }
            }
        }
    }
}
```

### Extracting Complex Computed View

```swift
private var header: some View {
    HeaderSection(title: title, subtitle: subtitle, status: status)
}

private struct HeaderSection: View {
    let title: String
    let subtitle: String?
    let status: Status

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.headline)
            if let subtitle { Text(subtitle).font(.subheadline) }
            StatusBadge(status: status)
        }
    }
}
```

### View Model Initialization (Observation-based)

```swift
struct DetailView: View {
    @State private var viewModel: DetailViewModel

    init(dependency: Dependency) {
        _viewModel = State(initialValue: DetailViewModel(dependency: dependency))
    }
    
    var body: some View {
        // ...
    }
}
```

---

## MV Pattern Best Practices

### Prefer @State over View Models

```swift
// GOOD: Simple state in view
struct CounterView: View {
    @State private var count = 0
    
    var body: some View {
        Button("Count: \(count)") {
            count += 1
        }
    }
}

// AVOID: Unnecessary view model
struct CounterView: View {
    @State private var viewModel = CounterViewModel()
    
    var body: some View {
        Button("Count: \(viewModel.count)") {
            viewModel.increment()
        }
    }
}
```

### Use @Environment for Shared Services

```swift
struct OrderView: View {
    @Environment(OrderService.self) private var orderService
    @State private var orders: [Order] = []
    
    var body: some View {
        List(orders) { order in
            OrderRow(order: order)
        }
        .task {
            orders = await orderService.fetchOrders()
        }
    }
}
```

### Use task/onChange for Side Effects

```swift
struct SearchView: View {
    @State private var query = ""
    @State private var results: [Result] = []
    
    var body: some View {
        TextField("Search", text: $query)
            .onChange(of: query) { _, newValue in
                Task {
                    results = await search(newValue)
                }
            }
    }
}
```

---

## Notes

- Prefer small, explicit helpers over large conditional blocks.
- Keep computed view builders below `body` and non-view computed vars above `init`.
- Extract to separate files only when reuse is intended or the view becomes unwieldy.
