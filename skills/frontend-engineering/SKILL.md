---
name: frontend-engineering
description: Frontend engineering guidance with design-system-first rules and SolidJS component patterns. Use when building UI, styling, or refactoring frontend code.
---

# Frontend Engineering (Design System + SolidJS)

## Design system first

All frontend code MUST follow a design-system-first approach. Components must be reusable and centralized.

### Design system locations (project-specific)

If the repo defines a design system, use its structure and naming. Common patterns:

- **CSS Components**: `design-system/components/`
- **CSS Tokens**: `design-system/tokens/`
- **CSS Layouts**: `design-system/layouts/`
- **CSS Base**: `design-system/base/`
- **View-specific styles**: `design-system/views/`

If the repo uses a different structure, follow the repo conventions.

### Rules

1. **ALWAYS check existing components first** before creating new UI.
2. **New UI elements go into the design system first**, then are composed in views.
3. **Component naming**:
   - CSS partials: `_component-name.css`
   - SolidJS components: `ComponentName.tsx`
4. **CSS architecture**:
   - Tokens in `tokens/`
   - Reusable UI patterns in `components/`
   - Layout primitives in `layouts/`
   - View-specific compositions in `views/` (no duplicated styles)
5. **Before creating a new component, ask**:
   - Does a similar component already exist?
   - Can it be generalized instead?
   - Is this actually view-specific?

## SolidJS patterns

### Component composition

- Prefer small, focused components and composition over inheritance.
- Keep components pure: compute state with signals/memos and avoid side effects in render.
- Use `createSignal` for local state and `createStore` for nested state.
- Use `createMemo` for derived values instead of recomputing in JSX.

### Control flow

- Use `<Show>` and `<For>` instead of ternaries and `.map()`.
- Use `<Switch>`/`<Match>` for multi-branch conditions.

### Data fetching

- Use `createResource` for async data with `Suspense` and error boundaries.
- Keep data fetching outside of rendering logic.

### Anti-patterns

- Destructuring props (breaks reactivity).
- Reading signals without calling them.
- Mutating signals directly.
*** End Patch}]}), code block, with info string 'commentary' and tool call JSON. Wait apply_patch uses FREEFORM. Need correct. Use apply_patch tool. Ensure proper patch. Let's output.  
