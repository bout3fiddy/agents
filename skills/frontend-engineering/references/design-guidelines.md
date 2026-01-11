# Frontend Design Guidelines (Reference)

## Depth and layering
- **Layered shades**: create 3–4 lightness steps of a base color (≈10% each) for background → surfaces → interactive.
- **Two-step depth**: first brighten a surface layer, then add shadow for separation.
- **Shadows**: combine a light edge/glow with a darker drop shadow for realism.
- **Inset depth**: dark inset top + light inset bottom to push sections inward.
- **Hover**: increase shadow size on hover, especially in light mode.
- **Highlights**: use a subtle linear gradient + inner highlight to mimic overhead light.

## Spacing system
- Use `rem` values; avoid arbitrary pixels.
- Core values: 0.5rem (group), 1rem (default), 1.5–2rem (separate sections).
- Inside spacing < outside spacing; horizontal padding > vertical padding (2x–3x rule).
- Start with generous spacing, reduce only if needed; consistency beats precision.
- 4px rule: sizes and spacing divisible by 4 (e.g., 16, 20, 24, 32, 64).

## Typography and hierarchy
- Keep a simple type scale; base size handles most text.
- Build hierarchy via weight and color; de-emphasize secondary text (lower lightness).
- Use line-height to create natural breathing room between headings and content.

## Clarity and conventions
- Preserve common UI patterns (nav top/side, buttons look like buttons).
- Keep primary actions in consistent locations.
- Avoid ambiguity; use explicit labels and instructions.
- Optimize for scanners with clear headings and bullets; avoid text walls.

## Buttons and affordance
- Use color hierarchy: primary > secondary; never equal weight.
- Underline or visually indicate links when appropriate.
- Add hover/focus states that reinforce interactivity.

## Layout and responsiveness
- Use flex or grid for responsiveness; prefer `gap` over ad-hoc margins.
- Use relative units and `clamp()` for scalable typography and spacing.
- For cards, use padding and rounded corners; avoid sharp default boxes.

## CSS layout notes
- **Grid subgrid**: use `grid-template-rows: subgrid` on card layouts to align internal rows; set `grid-row: span N` for responsive grids.
- **Body background**: apply global page background to `body` for full-viewport background behavior.

## Gradients and texture
- Replace flat fills with subtle gradients to add depth.
- Add minimal noise/texture overlays sparingly to prevent banding and add atmosphere.
