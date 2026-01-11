---
name: frontend-engineering
description: Frontend engineering guidance with design-system-first rules and SolidJS component patterns. Use when building UI, styling, or refactoring frontend code.
---

# Frontend Engineering (Design System + SolidJS)

## Design craft (visual direction)

Use this when the task is about UI polish, layout, or overall aesthetic direction. Avoid generic/default styling.

### Workflow

1) **Commit to a direction**
- Define purpose, audience, constraints.
- Pick a bold aesthetic (editorial, brutalist, retro, luxury, etc.) and state one memorable visual idea.

2) **Set a lightweight system**
- **Typography**: pick a distinctive display face + refined body face; avoid Inter/Roboto/Arial/system defaults.
- **Color**: define CSS variables; 3–4 lightness steps for background → surfaces → interactive.
- **Spacing**: use `rem` with a small set (0.5, 1, 1.5, 2). Vertical padding < horizontal.
- **Depth**: layered shadows (light edge + soft drop). Add hover elevation where useful.

3) **Compose layout**
- Use intentional asymmetry, overlaps, or grid breaks.
- Build atmosphere with gradients, textures, or subtle pattern overlays (avoid flat-only backgrounds).

4) **Motion with intent**
- Prefer one strong entrance animation with staggered reveals.
- Add a small set of hover/focus interactions; avoid noisy micro-animations.

5) **Hierarchy**
- De-emphasize secondary text by color/weight, not tiny fonts.
- Make primary actions obvious and consistently placed.

### Implementation checks

- Layout works on mobile and desktop.
- Primary actions look like buttons; links are visually distinct.
- Spacing and sizing remain consistent.

### References

For deeper guidance, read: `references/design-guidelines.md`

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

## Subagent handoff (keep main context clean)

When you finish a chunk of UI work, delegate focused checks:

- **Design review**: ask the design reviewer to inspect the specific screen/component.
- **Quality guard**: provide changed paths and preferred commands; request lint + tests with small auto-fixes.

Provide the subagents with:
- Exact files/paths touched
- The URL or component entry point to review
- Any repo-specific scripts to run

**Mandatory**: explicitly invoke the agent, don’t just say “do a review.”
Example:
`/agents design-reviewer` and provide the URL + component path.
*** End Patch}]}), code block, with info string 'commentary' and tool call JSON. Wait apply_patch uses FREEFORM. Need correct. Use apply_patch tool. Ensure proper patch. Let's output.  
