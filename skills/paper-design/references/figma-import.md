# Figma Import Workflow

Paper provides a built-in guided workflow for importing Figma designs. Access it via:

```
get_guide({ topic: "figma-import" })
```

This returns step-by-step instructions at runtime. The guide covers the full import process — always call it rather than guessing the workflow.

## Known limitations of Figma→Paper transfer

These issues come from Figma's MCP export, not Paper's import:

- **SVG fills** are returned as images (rasterized), not vectors.
- **Component overrides** are not respected — you get the base component.
- **Spacer elements** are ignored — spacing may appear off and need manual adjustment.
- **Inset borders** don't convert to outlines.
- **Code-connected components** are unreliable in transfer.
- **Large/deeply nested designs** cause errors — break into smaller parts before importing.

## Post-import checklist

After importing, verify with `get_screenshot`:

1. **Spacing** — spacer elements are dropped, so gaps may be wrong. Fix with `update_styles` (add `gap` or `padding`).
2. **Borders** — inset borders may be missing. Re-add with `update_styles`.
3. **Icons** — SVG icons may have been rasterized. Replace with inline SVGs if needed.
4. **Typography** — check that fonts mapped correctly with `get_font_family_info`.
5. **Layout structure** — Figma auto-layout maps to flex, but verify direction and alignment.
