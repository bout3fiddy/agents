---
name: paper-design
description: Use Paper MCP to create, explore, and iterate on UI designs directly on a design canvas. Trigger when the user asks to visualize a component, explore design directions, preview layout changes, or create static mockups.
---

# Paper Design

**When**: Visualize components, explore design directions, preview CSS changes, create static mockups, build design variants, import Figma designs.
**Not for**: Interactive testing (use dev server), animation/motion (use storyboard-animation), design critique of live sites (use design-critique), general design guidance without Paper (use design-guidelines).
**Requires**: Paper MCP server connected and a Paper file open. Verify with `get_basic_info` — if it errors, the server is not running.

---

## Cost awareness

MCP calls are metered weekly: Free = 100/week, Pro = 1M/week. Every tool invocation counts as one call. Minimize calls:

- **Batch everything.** `get_computed_styles`, `set_text_content`, `update_styles`, `rename_nodes` all accept arrays — one call for N nodes, not N calls.
- **`get_tree_summary` over repeated `get_children`.** One call with `depth: 5` replaces a cascade of `get_children` calls down the tree.
- **`duplicate_nodes` + `descendantIdMap` over rebuilding.** Cloning and tweaking a variant is 3-4 calls. Building from scratch is 10+.
- **Screenshot strategically.** Each screenshot is a call. On free tier, screenshot every 4-5 writes instead of every 2-3. On Pro, follow the standard 2-3 cadence.
- **Skip `start_working_on_nodes`** when working solo — it's a visual indicator for collaborators, not a functional requirement.
- **Combine reads.** If you need styles and structure, `get_computed_styles` + `get_tree_summary` in one round is 2 calls. Don't also call `get_node_info` + `get_children` for the same data.
- **Don't re-read after writing.** Trust the write succeeded unless you need visual verification. Use screenshots for verification, not redundant reads.

## Core workflow

1. **`get_basic_info`** first — understand the file, pages, existing artboards, and loaded fonts.
2. **`get_font_family_info`** before writing any text — confirm the font and available weights. Use the project's actual font (check CSS tokens), not a guess.
3. **`create_artboard`** with a clear name and explicit pixel dimensions. Use `find_placement` or `relatedNodeId` to avoid overlap.
4. **`write_html`** incrementally — one visual group per call (header, then body, then footer). Never batch an entire component into one call.
5. **`get_screenshot`** after every 2-3 write calls to verify. Fix issues before continuing.
6. **`finish_working_on_nodes`** when done.

For deeper tool parameter details, see `references/tool-parameters.md`.

## Hard rules

- **Inline styles only** — no class names, no `<style>` blocks, no external CSS.
- **Flex layout only** — no `display: grid`, no `display: inline`, no margins, no HTML `<table>`. Use flexbox, padding, and gap for all layout.
- **One visual group per `write_html` call** — never batch an entire component. A card with header, 4 rows, and footer is 6+ calls.
- **Screenshot every 2-3 modifications** — evaluate against quality signals below. Fix before continuing.
- **`get_font_family_info` before first write** — using an unavailable font or weight breaks the design.
- **Always call `finish_working_on_nodes`** when done — clears the working indicator for the human.
- **Style objects use camelCase** — `update_styles` and `create_artboard` styles use `{ fontSize: "16px", backgroundColor: "#fff" }`, not kebab-case.
- **No emojis as icons** — use inline SVG or omit.
- **Assume `border-box` sizing** on all elements.

## HTML rules

Full rules with examples in `references/html-rules.md`. Key points:

- `display: block` is OK for leaf elements (text, images), not layout containers.
- Absolute positioning works for decorative elements — don't cover entire artboards.
- Images: `<img src="http://localhost:29979/media{absolute_path}">` for local files.
- Inline SVGs work — use for icons.
- `<pre>` or `white-space: pre` for code blocks (whitespace preserved).
- All CSS color formats supported: hex, rgb, rgba, hsl, hsla, oklch, oklab.
- `layer-name` attribute on elements for readable layer tree names.
- `<x-paper-clone node-id="..." />` to clone existing Paper nodes into new HTML.
- No rich text — single text style per element.

## Tools quick reference

### Reading

| Tool | Use when | Key params |
|------|----------|------------|
| `get_basic_info` | Starting a session — file, pages, artboards, fonts | — |
| `get_selection` | User selected something and wants you to act on it | — |
| `get_node_info` | Need text content or structure of a specific node | `nodeId` |
| `get_children` | List direct children of a frame | `nodeId` |
| `get_tree_summary` | Understand hierarchy of a subtree | `nodeId`, `depth` (default 3, max 10) |
| `get_screenshot` | Visual verification | `nodeId`, `scale` (1x or 2x), `transparent` |
| `get_jsx` | Export as React/JSX | `nodeId`, `format` (`tailwind` or `inline-styles`) |
| `get_computed_styles` | Read exact CSS values (batch) | `nodeIds[]` |
| `get_fill_image` | Extract image data from a fill | `nodeId` |
| `get_font_family_info` | Check font availability and weights | `family` |
| `get_guide` | Guided workflows (e.g. `figma-import`) | `topic` |
| `find_placement` | Suggested x/y for new artboard without overlap | — |

### Writing

| Tool | Use when | Key params |
|------|----------|------------|
| `create_artboard` | New canvas area | `name`, `styles` (camelCase JSON), `relatedNodeId` |
| `write_html` | Add or replace content | `html`, `parentId`, `mode` (`insert-children` / `replace`) |
| `set_text_content` | Change text without rewriting | `updates[]` (batch) |
| `update_styles` | Batch CSS changes on existing nodes | `updates[]` (camelCase JSON) |
| `duplicate_nodes` | Clone frames — returns `descendantIdMap` | `nodeIds[]`, `parentId` |
| `rename_nodes` | Clean up layer names (50-char max) | `updates[]` (batch) |
| `delete_nodes` | Remove nodes and descendants | `nodeIds[]` — verify parent with `get_node_info` first |
| `start_working_on_nodes` | Show working indicator on artboards | `nodeIds[]` |
| `finish_working_on_nodes` | Clear working indicator | — |

## Quality signals (check on every screenshot)

- **Spacing** — uneven gaps, cramped groups, empty voids. Is there clear visual rhythm?
- **Typography** — text too small (<12px), poor line-height, weak hierarchy between heading/body/caption.
- **Contrast** — low contrast text, elements blending into background, overly uniform color.
- **Alignment** — elements that should share a vertical/horizontal lane but don't. Icons misaligned across rows.
- **Clipping** — content cut off at container or artboard edges. Fix with `update_styles` → `height: "fit-content"`.
- **Repetition** — overly grid-like sameness. Vary scale, weight, or spacing for visual interest.
- **Layer names** — unnamed layers make the tree unreadable. Use `layer-name` attribute on all groups.

## Patterns

### Explore design directions
1. Build the base variant.
2. `duplicate_nodes` to clone it — use returned `descendantIdMap` to map old→new node IDs.
3. `update_styles` + `set_text_content` on clone nodes (using mapped IDs) to create an alternative.
4. Screenshot both for comparison.

### Responsive preview
Create artboards at each breakpoint using default sizes:
- Desktop: 1440×900
- Tablet: 768×1024
- Mobile: 390×844

Use `relatedNodeId` on `create_artboard` to place breakpoint variants adjacent. Adapt layout per breakpoint (stack on mobile, side-by-side on desktop).

### Component state matrix
Clone a base component for each state: empty, filled, error, loading, disabled. Modify content/styles per clone. Name artboards as `Component / Viewport / State`.

### Selection-driven iteration
User selects a frame in Paper → `get_selection` to read it → `update_styles` or `write_html` with `mode: "replace"` to modify. Fastest feedback loop.

### Design-to-code
1. Build the design in Paper.
2. `get_jsx` with `format: "tailwind"` (or `"inline-styles"`) to export.
3. Adapt the output into the project's component framework.

### Figma import
Call `get_guide({ topic: "figma-import" })` for the full step-by-step workflow. The guide walks through importing Figma designs into Paper.

## Error recovery

- **`write_html` fails** — payload too large. Break into smaller visual groups. Never write >15 lines of HTML per call.
- **Stale node IDs** — a node was deleted or replaced. Re-query with `get_children` or `get_tree_summary` to get current IDs.
- **Content overflows artboard** — don't recreate the entire frame. Use `update_styles` to set the overflowing dimension to `fit-content`.
- **Font unavailable** — `get_font_family_info` returned no match. Fall back to a loaded font from `get_basic_info`, or pick a safe Google Font.
- **Deep nesting errors** — keep artboard structures shallow. Flatten unnecessary wrapper divs.

## Naming convention

Artboards: `Component / Viewport / State`
- `Onboarding Modal / Desktop / Empty`
- `Event Card / Mobile / Hover`
- `Auth Modal / Desktop / Error`

## File organization

Use pages to separate concerns:
- **Components** — isolated component states and variants
- **Screens** — full page layouts
- **Explorations** — throwaway design experiments

## In-app only features (not available via MCP)

These Paper features exist but are **not accessible through MCP tools** — the user must use them directly in the Paper UI:

- **Image generation** — Flux 2, Gemini 3 (Nano Banana Pro), OpenAI Image Edit 1.5, Seedream 4.5. Multi-reference generation supported.
- **Shaders** — 26+ GPU shaders (Mesh Gradient, Liquid Metal, Fluted Glass, Halftone CMYK, Perlin Noise, etc.). Available as React components via `@paper-design/shaders-react`.
- **CSS filters** — blur, saturation, grayscale, brightness, sepia, invert, hue rotation.
- **Video export** — MP4 with duration/resolution/quality controls (Pro only).
- **Image export formats** — WebP, AVIF, PNG beyond standard export.

When a user needs these, guide them to use Paper's UI directly and then continue MCP work on the resulting nodes.

## Cross-MCP workflows

Paper works alongside other MCP servers for richer workflows:

- **Figma MCP** — sync design tokens (colors, typography, spacing) from Figma into Paper. Use `get_guide({ topic: "figma-import" })` for the full workflow.
- **Notion MCP** — pull real content (copy, data) from Notion into Paper designs instead of placeholder text.
- **Code project MCP** — build a design in Paper, export via `get_jsx`, then write code to the project.

## Limitations

- Static HTML only — no JS reactivity, no hover/click interaction.
- SVG fills may export as images, not vectors.
- No rich text (mixed inline styles in one text node) — single style per text element.
- Layer names truncated at 50 characters.
- Screenshots auto-capped to fit API size limits.
