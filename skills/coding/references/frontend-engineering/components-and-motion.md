# Frontend Components: Full Reference

# Frontend Component Design Patterns

A collection of reusable frontend component patterns with CSS animations, accessibility considerations, and implementation details.

## Overview

This skill covers:
- **CSS Animation Patterns**: Marquees, transitions, keyframe animations
- **Layout Components**: Carousels, grids, cards
- **Interactive Elements**: Modals, tooltips, dropdowns
- **Accessibility**: ARIA attributes, keyboard navigation, screen reader support

---

## 1. Marquee Effect (CSS Animation)

A smooth, infinite scrolling text effect using pure CSS. Useful for long titles that overflow their container.

**Technique inspired by:**
- Blog post: https://www.bennadel.com/blog/4536-creating-a-marquee-effect-with-css-animations.htm
- License: https://www.bennadel.com/blog/license.htm

### Concept

The trick is to place **two copies** of the same content side-by-side in a flex container, then animate both elements from `translateX(0%)` to `translateX(-100%)`. When the first element moves fully off-screen, both snap back to 0% - but visually it appears continuous because the second element is now where the first started.

### HTML Structure

```html
<div class="marquee">
  <h3 class="marquee__item">Your Long Title Here</h3>
  <h3 class="marquee__item" aria-hidden="true">Your Long Title Here</h3>
</div>
```

**Key points:**
- Two identical elements side-by-side
- Second element has `aria-hidden="true"` to avoid duplicate screen reader announcements

### CSS Implementation

```css
/* Marquee container - flex with overflow hidden */
.marquee {
  display: flex;
  overflow: hidden;
  white-space: nowrap;
  max-width: 100%;
}

/* Each marquee item animates independently */
.marquee__item {
  flex-shrink: 0;
  padding-right: 3rem; /* Gap between repetitions */
  animation: marquee-scroll 10s linear infinite;
}

/* Pause on hover for readability */
.marquee:hover .marquee__item {
  animation-play-state: paused;
}

/* Both items translate from 0% to -100% of their own width */
@keyframes marquee-scroll {
  from {
    transform: translateX(0%);
  }
  to {
    transform: translateX(-100%);
  }
}
```

### Critical CSS Properties

| Property | Value | Purpose |
|----------|-------|---------|
| `display: flex` | Container | Places items side-by-side |
| `overflow: hidden` | Container | Clips content outside bounds |
| `white-space: nowrap` | Container | Prevents text wrapping |
| `flex-shrink: 0` | Items | Prevents items from shrinking |
| `animation-timing-function` | `linear` | Hides the snap-back moment |
| `animation-iteration-count` | `infinite` | Continuous looping |

### Animation Speed Considerations

The animation duration is **relative to content width**. A 10-second animation on a 100px element moves at 10px/s, but on a 200px element moves at 20px/s.

For consistent speed across different content lengths, calculate duration dynamically:

```javascript
// Optional: Dynamic duration based on content width
const item = document.querySelector('.marquee__item');
const width = item.offsetWidth;
const speed = 50; // pixels per second
const duration = width / speed;
item.style.animationDuration = `${duration}s`;
```

### Solid.js Component Example

```tsx
interface MarqueeTitleProps {
  title: string;
  class?: string;
}

function MarqueeTitle(props: MarqueeTitleProps) {
  return (
    <div class={`marquee ${props.class ?? ''}`}>
      <h3 class="marquee__item">{props.title}</h3>
      <h3 class="marquee__item" aria-hidden="true">{props.title}</h3>
    </div>
  );
}
```

### Accessibility

- Use `aria-hidden="true"` on the duplicate element
- Pause animation on hover for readability
- Consider `prefers-reduced-motion` media query:

```css
@media (prefers-reduced-motion: reduce) {
  .marquee__item {
    animation: none;
  }
  
  .marquee {
    /* Fallback: truncate with ellipsis */
    text-overflow: ellipsis;
  }
  
  .marquee__item:nth-child(2) {
    display: none;
  }
}
```

---

## 2. Compact Spotify Embed

Display Spotify embeds in a compact single-track format (80px height) instead of full tracklist (352px).

### Embed Heights

| Mode | Height | Use Case |
|------|--------|----------|
| Compact | 80px | Featured cards, previews |
| Full | 352px | Event detail pages |

### Implementation

```typescript
const SPOTIFY_COMPACT_HEIGHT = 80;
const SPOTIFY_FULL_HEIGHT = 352;

interface SpotifyEmbedOptions {
  compact?: boolean;
}

function renderSpotifyEmbed(url: string, options: SpotifyEmbedOptions = {}): string {
  const height = options.compact ? SPOTIFY_COMPACT_HEIGHT : SPOTIFY_FULL_HEIGHT;
  const embedUrl = convertToEmbedUrl(url);
  
  return `<iframe 
    src="${embedUrl}" 
    height="${height}" 
    width="100%" 
    frameborder="0" 
    allow="encrypted-media"
    loading="lazy"
  ></iframe>`;
}
```

### CSS for Compact Mode

```css
.spotify-embed--compact {
  height: 80px;
  border-radius: 12px;
  overflow: hidden;
}

.spotify-embed--compact iframe {
  height: 100%;
  width: 100%;
}
```

---

## 3. Date Badge Component

A small badge showing day and month, useful for event cards.

### HTML Structure

```html
<div class="date-badge">
  <span class="date-badge__day">15</span>
  <span class="date-badge__month">FEB</span>
</div>
```

### CSS Implementation

```css
.date-badge {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 0.5em 0.75em;
  background: var(--color-bg-primary);
  border-radius: 4px;
  box-shadow: var(--shadow-soft-sm);
}

.date-badge__day {
  font-size: 1.5em;
  font-weight: bold;
  line-height: 1;
  color: var(--color-accent-gold);
}

.date-badge__month {
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-fg-secondary);
}

/* Smaller variant for grid cards */
.poster-card .date-badge {
  padding: 0.4em 0.6em;
}

.poster-card .date-badge__day {
  font-size: 1em;
}

.poster-card .date-badge__month {
  font-size: 0.65rem;
}
```

---

## 4. Featured Card Layout

A two-column card with poster image and content body.

### Grid Structure

```css
.featured-card {
  display: grid;
  grid-template-columns: minmax(200px, 38%) minmax(0, 1fr);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  overflow: hidden;
}

.featured-card__poster {
  border-right: 1px solid var(--color-border);
}

.featured-card__body {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1.5rem;
  overflow: hidden; /* Critical for marquee containment */
  min-width: 0; /* Allows flex child to shrink below content size */
}
```

### Key Layout Properties

| Property | Element | Purpose |
|----------|---------|---------|
| `minmax(0, 1fr)` | Grid column | Allows column to shrink below content size |
| `overflow: hidden` | Body | Contains marquee animation |
| `min-width: 0` | Body | Flex item can shrink properly |

---

## 5. Pixel Heart Like Button with Hover Backdrop

A like button with a pixel art heart that shows a radial gradient backdrop on hover for visibility on busy backgrounds.

### Problem

Pixel hearts drawn with `box-shadow` can be invisible on busy poster backgrounds (e.g., red heart on red poster).

### Solution

Add a `::before` pseudo-element with a radial gradient that appears on hover, creating contrast behind the heart.

### HTML Structure

```html
<button class="like-button" aria-label="Like event">
  <span class="pixel-heart"></span>
</button>
```

### CSS Implementation

```css
.like-button {
  position: absolute;
  top: 0.6em;
  right: 0.6em;
  z-index: 10;
  /* 44x44px touch target */
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 50%;
  cursor: pointer;
  transition: transform 0.3s ease;
}

/* Radial gradient backdrop on hover */
.like-button::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: radial-gradient(
    circle,
    rgba(255, 255, 255, 0.85) 0%,
    rgba(255, 255, 255, 0.6) 50%,
    rgba(255, 255, 255, 0) 70%
  );
  opacity: 0;
  transition: opacity 0.2s ease;
  z-index: -1;
}

.like-button:hover::before,
.like-button:focus-visible::before {
  opacity: 1;
}

/* Pixel heart drawn with box-shadow */
.pixel-heart {
  display: block;
  width: 3px;
  height: 3px;
  /* Offset to center (box-shadow extends right/down) */
  position: relative;
  left: -9px;
  top: -9px;
  box-shadow:
    /* Row 1 */
    3px 0 0 currentColor, 6px 0 0 currentColor,
    12px 0 0 currentColor, 15px 0 0 currentColor,
    /* Row 2 */
    0 3px 0 currentColor, 3px 3px 0 currentColor,
    /* ... more pixels ... */;
}
```

### Key Techniques

| Technique | Purpose |
|-----------|---------|
| `::before` pseudo-element | Gradient doesn't affect heart's stacking |
| `radial-gradient` | Soft circular glow, fades to transparent |
| `z-index: -1` on `::before` | Gradient behind heart, not in front |
| `inset: 0` | Fills entire button area |
| Negative offset on heart | Centers the box-shadow-drawn shape |

### Pixel Heart Centering

The pixel heart is drawn using `box-shadow` which extends **right and down** from the element origin. To center it in the button:

1. Button uses `display: flex; align-items: center; justify-content: center`
2. Heart element uses `position: relative; left: -9px; top: -9px` to offset

The offset values depend on the heart's pixel dimensions (approximately half the width/height).

---

## 6. Motion Choice: Spring vs Easing vs None

Start by deciding what role motion plays in the interaction.

- **Use springs** when motion is tied to user input (drag, flick, press, gestures). Springs preserve velocity and handle interruption well.
- **Use easing** when the system is announcing a change or guiding attention (modals, toasts, view switches).
- **Use no animation** for high-frequency actions (typing, rapid toggles, keyboard navigation) where motion adds noise.
- **Use linear** when motion represents time itself (progress bars, scrubbing, loaders).

### Easing defaults

- **Entrance/feedback**: ease-out (fast start, soft landing).
- **Exit**: ease-in (acknowledge, then get out of the way).
- **Mode switches**: ease-in-out (balanced, deliberate).

### Timing defaults

- **Press/hover**: 120–180ms
- **Small state changes**: 180–260ms
- **Large transitions**: up to ~300ms

If motion feels slow, shorten duration before changing the curve.

### Spring knobs

- **Stiffness** controls responsiveness (how hard it pulls to target).
- **Damping** controls settling vs oscillation.
- **Mass** affects perceived weight (interacts with stiffness/damping).

### Example (CSS + spring)

```css
/* Ease-out entrance */
.panel {
  transition: transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1),
              opacity 220ms ease-out;
}
.panel[data-state="open"] {
  transform: translateY(0);
  opacity: 1;
}
.panel[data-state="closed"] {
  transform: translateY(8px);
  opacity: 0;
}
```

```ts
// Spring for gesture-driven motion (example API)
const spring = { type: "spring", stiffness: 800, damping: 70, mass: 8 };
```

---

## 7. Pseudo-Elements for Component Depth

Use pseudo-elements to add layers and interaction polish without extra DOM.

### Core rules

- `::before` / `::after` create anonymous children and **require `content`** to render.
- Use them for **decorative layers, icons, separators, and bigger hit targets** without markup.
- Favor `position: absolute` + `inset: 0` for full-bleed overlays.

### Hover backdrop pattern

```css
.btn {
  position: relative;
  z-index: 0;
}
.btn::before {
  content: "";
  position: absolute;
  inset: 0;
  background: currentColor;
  opacity: 0;
  transform: scale(0.95);
  transition: opacity 160ms ease-out, transform 160ms ease-out;
  z-index: -1;
}
.btn:hover::before,
.btn:focus-visible::before {
  opacity: 0.12;
  transform: scale(1);
}
```

### Native UI styling hooks

Modern pseudo-elements expose browser-native features (dialogs, popovers, view transitions, scroll-driven nav, form pickers). Prefer them over JS wrappers when possible.

### View Transitions (CSS-first)

When using `document.startViewTransition()`, the browser creates a pseudo-element tree for both states. Style those pseudo-elements to define the animation and avoid custom DOM cloning.

---

## 8. 12 Principles of UI Animation (Condensed)

Use these as a checklist when motion feels “off.”

1) **Squash & Stretch**: Subtle deformation signals weight; avoid cartoonish extremes.  
2) **Anticipation**: Add a small pre‑cue before big actions; save for moments that matter.  
3) **Staging**: Sequence motion to guide attention; avoid animating everything at once.  
4) **Pose to Pose**: Define key moments; let interpolation handle in‑betweens.  
5) **Follow Through / Overlap**: Parts settle at different times; small stagger feels alive.  
6) **Slow In / Slow Out**: Ease in/out to avoid jarring starts/stops.  
7) **Arcs**: Curved paths feel organic; reserve for hero moments.  
8) **Secondary Action**: Add supporting flourishes that reinforce the main action.  
9) **Timing**: Keep interactions under ~300ms and consistent across the UI.  
10) **Exaggeration**: Amplify for emphasis, sparingly.  
11) **Solid Drawing**: Use depth cues (shadows, perspective) for believable motion.  
12) **Appeal**: The sum of care and taste; aim for “feels right,” not “shows off.”

---

## 9. Sound as UI Feedback (Optional but Powerful)

Use audio to reinforce actions and reduce perceived latency, but keep it subtle and optional.

### When to use sound

- Confirm major actions (payments, uploads)
- Signal errors/warnings that must be noticed
- Reinforce state changes or notifications that need attention

### Rules

- **Never autoplay.** Trigger on user action.
- **Complement, never replace** visual feedback.
- **Provide a toggle** and allow volume control independent of system volume.
- Use `prefers-reduced-motion` as a proxy for reduced stimulation when needed.

### Implementation notes

- Simple cues: `new Audio("click.mp3").play()` for straightforward playback.
- Lower latency / layering: Web Audio API (especially for rapid UI sounds).

---

## Quick Reference

| Component | Key Technique |
|-----------|---------------|
| Marquee | Two duplicate elements, `translateX(-100%)`, linear infinite |
| Compact embed | Fixed height iframe with overflow hidden |
| Date badge | Flex column, size variants via parent selector |
| Featured card | CSS Grid with `minmax(0, 1fr)` for shrinkable columns |
| Like button | `::before` radial gradient backdrop on hover |
| Motion choice | Springs for input, easing for system, linear for time |
| Pseudo-elements | Decorative layers + hit target expansion |
| UI sound | Subtle, optional, action-driven cues |

---

## Attribution

When using techniques from external sources, always include attribution in code comments:

```css
/* Technique inspired by [Author Name]
   Source: [URL]
   License: [License URL] */
```
