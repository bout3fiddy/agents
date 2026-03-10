# Paper HTML/CSS Rules

Paper renders HTML/CSS on a DOM-based canvas. These rules are non-negotiable — violating them produces broken or invisible output.

## Layout

- **Flex only for containers.** All layout containers must use `display: flex`. No `display: grid`, `display: inline`, `display: inline-block`, or `display: table`.
- **`display: block`** is allowed only on leaf elements — text spans, images, shapes. Never on containers with children that need layout.
- **No margins.** Use `padding` on containers and `gap` on flex parents for spacing.
- **Core layout tools:** `display: flex`, `flex-direction`, `padding`, `gap`, `align-items`, `justify-content`, `flex-wrap`, `flex-shrink`, `flex-grow`.
- **`border-box` sizing** is assumed on all elements. No need to set it explicitly.
- **Absolute positioning** works for decorative overlays (badges, floating labels). Never cover an entire artboard with an absolutely positioned element.

## Styles

- **Inline styles only.** Every style goes in the `style` attribute. No `class`, no `<style>` blocks, no external stylesheets.
- **camelCase in JS objects, kebab-case in HTML.** When passing styles to `update_styles` or `create_artboard`, use camelCase (`fontSize`, `backgroundColor`). In `write_html` HTML strings, use standard kebab-case (`font-size`, `background-color`).
- **All CSS color formats:** hex (`#1a1a1a`), rgb/rgba, hsl/hsla, oklch, oklab.
- **No shorthand pitfalls.** `border`, `padding`, `margin` shorthands work, but be explicit when mixing — e.g., `padding: 16px 24px` is fine, but don't rely on shorthand overrides for specificity.

## Typography

- **Font sizes in `px`** — always.
- **Letter spacing in `em`** — unless the existing design uses `px`.
- **Line height in `px`** — relative units are OK if they don't produce subpixel values.
- **Single text style per element.** No rich text (mixed bold/italic/color within one text node). To mix styles, use separate elements.
- **`<pre>` or `white-space: pre`** for code blocks and preformatted text — whitespace is preserved.
- **Check font availability** with `get_font_family_info` before using any font family. All Google Fonts are available, plus system fonts on the user's machine.

## Images and icons

- **Local images:** `<img src="http://localhost:29979/media{absolute_path}">` — the MCP server proxies local files.
- **No emojis as icons.** Use inline SVG instead, or omit the icon entirely.
- **Inline SVGs** work well for icons. Keep them simple — complex SVGs increase payload size.

## Paper-specific attributes

- **`layer-name="..."`** — set on any element to control its name in Paper's layer panel. Use descriptive names on all groups and sections.
- **`<x-paper-clone node-id="..." />`** — a custom element that clones an existing Paper node by ID into new HTML. Useful for reusing existing design elements without recreating them.

## Overflow

- When content overflows a frame, **do not recreate the entire frame.** Use `update_styles` to set the overflowing dimension to `fit-content` (e.g., `height: "fit-content"`).
- Let the user decide whether to constrain or expand — don't silently clip or restructure.

## Anti-patterns

- Writing >15 lines of HTML in a single `write_html` call — break it up.
- Using `display: grid` or HTML `<table>` — Paper doesn't support them.
- Deeply nested structures (>5-6 levels) — flatten wrapper divs.
- Using `margin` for spacing — use `gap` and `padding` instead.
- Setting `class` attributes — they're ignored.
- Covering artboards with absolute-positioned elements.
