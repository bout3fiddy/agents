# Tailwind CSS Full Reference

# Tailwind CSS v4 Comprehensive Skill

A complete reference for building modern, responsive UIs with Tailwind CSS v4's utility-first approach.

## Overview

Tailwind CSS v4 (January 2025) is a utility-first CSS framework with:
- **CSS-first configuration**: Use `@theme` directive instead of JavaScript config
- **OKLCH color system**: Perceptually uniform colors
- **5x faster builds**: Optimized compilation
- **Native CSS layers**: `@layer base/components/utilities`
- **Dynamic theming**: CSS custom properties for runtime changes

**Key Mental Model**: Apply small, single-purpose utility classes directly in HTML. Compose complex designs from atomic utilities.

---

## Quick Reference

| What You Need | Solution |
|---------------|----------|
| Background color | `bg-{color}-{shade}` (e.g., `bg-blue-500`) |
| Text color | `text-{color}-{shade}` (e.g., `text-gray-900`) |
| Padding | `p-{n}`, `px-{n}`, `py-{n}`, `pt-{n}` |
| Margin | `m-{n}`, `mx-{n}`, `my-{n}`, `mt-{n}` |
| Width | `w-{n}`, `w-full`, `w-1/2`, `w-screen` |
| Height | `h-{n}`, `h-full`, `h-screen`, `min-h-screen` |
| Flexbox | `flex`, `flex-row`, `flex-col`, `gap-{n}` |
| Grid | `grid`, `grid-cols-{n}`, `gap-{n}` |
| Font size | `text-xs` to `text-9xl` |
| Font weight | `font-light` to `font-black` |
| Border radius | `rounded`, `rounded-lg`, `rounded-full` |
| Shadow | `shadow-sm` to `shadow-2xl` |
| Responsive | `sm:`, `md:`, `lg:`, `xl:`, `2xl:` |
| Dark mode | `dark:bg-gray-900` |
| Hover state | `hover:bg-blue-600` |
| Transition | `transition`, `duration-300` |

---

## 1. CSS-First Configuration (v4)

### Setup

```css
/* app.css or globals.css */
@import "tailwindcss";

@theme {
  /* Custom colors */
  --color-brand: #3b82f6;
  --color-accent: oklch(0.72 0.11 178);

  /* Custom spacing */
  --spacing-18: 4.5rem;

  /* Custom fonts */
  --font-display: "Playfair Display", serif;

  /* Custom shadows */
  --shadow-3xl: 0 35px 60px -12px rgba(0, 0, 0, 0.25);
}
```

### Dark Mode Configuration

```css
/* Method 1: System preference (default) */
@import "tailwindcss";

/* Method 2: Class-based toggle */
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));

/* Method 3: Data attribute */
@import "tailwindcss";
@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));
```

**JavaScript toggle:**
```javascript
document.documentElement.classList.toggle("dark");
// or
document.documentElement.dataset.theme = "dark";
```

---

## 2. Spacing Scale

**Base unit**: `--spacing: 0.25rem` (4px)

| Class | Value | Pixels |
|-------|-------|--------|
| `p-0`, `m-0` | 0 | 0px |
| `p-1`, `m-1` | 0.25rem | 4px |
| `p-2`, `m-2` | 0.5rem | 8px |
| `p-3`, `m-3` | 0.75rem | 12px |
| `p-4`, `m-4` | 1rem | 16px |
| `p-5`, `m-5` | 1.25rem | 20px |
| `p-6`, `m-6` | 1.5rem | 24px |
| `p-8`, `m-8` | 2rem | 32px |
| `p-10`, `m-10` | 2.5rem | 40px |
| `p-12`, `m-12` | 3rem | 48px |
| `p-16`, `m-16` | 4rem | 64px |
| `p-20`, `m-20` | 5rem | 80px |
| `p-24`, `m-24` | 6rem | 96px |
| `p-32`, `m-32` | 8rem | 128px |

### Padding Utilities

```html
<!-- All sides -->
<div class="p-4">padding: 1rem</div>

<!-- Horizontal (left + right) -->
<div class="px-6">padding-inline: 1.5rem</div>

<!-- Vertical (top + bottom) -->
<div class="py-4">padding-block: 1rem</div>

<!-- Individual sides -->
<div class="pt-4">padding-top: 1rem</div>
<div class="pr-4">padding-right: 1rem</div>
<div class="pb-4">padding-bottom: 1rem</div>
<div class="pl-4">padding-left: 1rem</div>
```

### Margin Utilities

```html
<!-- All sides -->
<div class="m-4">margin: 1rem</div>

<!-- Horizontal centering -->
<div class="mx-auto">margin-left: auto; margin-right: auto</div>

<!-- Negative margin -->
<div class="-mt-4">margin-top: -1rem</div>
```

### Gap (Flexbox & Grid)

```html
<div class="flex gap-4">gap: 1rem</div>
<div class="grid gap-x-8 gap-y-4">column-gap: 2rem; row-gap: 1rem</div>
```

### Space Between (Children)

```html
<!-- Horizontal spacing between children -->
<div class="flex space-x-4">
  <div>Item 1</div>
  <div>Item 2</div>
</div>

<!-- Vertical spacing -->
<div class="flex flex-col space-y-4">
  <div>Item 1</div>
  <div>Item 2</div>
</div>
```

---

## 3. Colors

### Color Application

| Pattern | Description | Example |
|---------|-------------|---------|
| `text-{color}-{shade}` | Text color | `text-blue-500` |
| `bg-{color}-{shade}` | Background | `bg-red-600` |
| `border-{color}-{shade}` | Border | `border-gray-300` |
| `ring-{color}-{shade}` | Focus ring | `ring-blue-400` |
| `shadow-{color}-{shade}` | Shadow color | `shadow-indigo-500` |

### Color Palette

**22 color families**, each with **11 shades** (50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950)

**Neutrals**: slate, gray, zinc, neutral, stone
**Colors**: red, orange, amber, yellow, lime, green, emerald, teal, cyan, sky, blue, indigo, violet, purple, fuchsia, pink, rose
**Special**: black, white, transparent

### Opacity Modifier

```html
<!-- 75% opacity -->
<div class="bg-blue-500/75">75% blue</div>

<!-- 50% opacity -->
<div class="text-red-600/50">50% red text</div>

<!-- 25% opacity -->
<div class="border-gray-300/25">25% border</div>
```

### Custom Colors

```html
<!-- Hexadecimal -->
<div class="bg-[#ff5733]">Custom hex</div>

<!-- RGB -->
<div class="bg-[rgb(255,87,51)]">Custom RGB</div>

<!-- CSS Variable (v4 syntax) -->
<div class="bg-(--brand-color)">CSS variable</div>
```

---

## 4. Typography

### Font Size

| Class | Size | Line Height |
|-------|------|-------------|
| `text-xs` | 0.75rem (12px) | 1rem |
| `text-sm` | 0.875rem (14px) | 1.25rem |
| `text-base` | 1rem (16px) | 1.5rem |
| `text-lg` | 1.125rem (18px) | 1.75rem |
| `text-xl` | 1.25rem (20px) | 1.75rem |
| `text-2xl` | 1.5rem (24px) | 2rem |
| `text-3xl` | 1.875rem (30px) | 2.25rem |
| `text-4xl` | 2.25rem (36px) | 2.5rem |
| `text-5xl` | 3rem (48px) | 1 |
| `text-6xl` | 3.75rem (60px) | 1 |
| `text-7xl` | 4.5rem (72px) | 1 |
| `text-8xl` | 6rem (96px) | 1 |
| `text-9xl` | 8rem (128px) | 1 |

### Font Weight

| Class | Weight |
|-------|--------|
| `font-thin` | 100 |
| `font-extralight` | 200 |
| `font-light` | 300 |
| `font-normal` | 400 |
| `font-medium` | 500 |
| `font-semibold` | 600 |
| `font-bold` | 700 |
| `font-extrabold` | 800 |
| `font-black` | 900 |

### Letter Spacing (Tracking)

| Class | Value |
|-------|-------|
| `tracking-tighter` | -0.05em |
| `tracking-tight` | -0.025em |
| `tracking-normal` | 0 |
| `tracking-wide` | 0.025em |
| `tracking-wider` | 0.05em |
| `tracking-widest` | 0.1em |

### Text Alignment

```html
<p class="text-left">Left aligned</p>
<p class="text-center">Centered</p>
<p class="text-right">Right aligned</p>
<p class="text-justify">Justified</p>
```

### Line Height (Leading)

| Class | Value |
|-------|-------|
| `leading-none` | 1 |
| `leading-tight` | 1.25 |
| `leading-snug` | 1.375 |
| `leading-normal` | 1.5 |
| `leading-relaxed` | 1.625 |
| `leading-loose` | 2 |

---

## 5. Sizing

### Width

```html
<!-- Fixed widths (spacing scale) -->
<div class="w-4">width: 1rem</div>
<div class="w-64">width: 16rem</div>

<!-- Fractional widths -->
<div class="w-1/2">width: 50%</div>
<div class="w-1/3">width: 33.333%</div>
<div class="w-2/3">width: 66.667%</div>

<!-- Special values -->
<div class="w-full">width: 100%</div>
<div class="w-screen">width: 100vw</div>
<div class="w-min">width: min-content</div>
<div class="w-max">width: max-content</div>
<div class="w-fit">width: fit-content</div>

<!-- Arbitrary values -->
<div class="w-[500px]">width: 500px</div>
```

### Height

```html
<div class="h-16">height: 4rem</div>
<div class="h-full">height: 100%</div>
<div class="h-screen">height: 100vh</div>
<div class="h-dvh">height: 100dvh (dynamic viewport)</div>
<div class="min-h-screen">min-height: 100vh</div>
```

### Size (Width + Height)

```html
<!-- Set both width and height -->
<div class="size-12">width: 3rem; height: 3rem</div>
<div class="size-full">width: 100%; height: 100%</div>
```

### Container Widths

| Class | Value | Pixels |
|-------|-------|--------|
| `max-w-xs` | 20rem | 320px |
| `max-w-sm` | 24rem | 384px |
| `max-w-md` | 28rem | 448px |
| `max-w-lg` | 32rem | 512px |
| `max-w-xl` | 36rem | 576px |
| `max-w-2xl` | 42rem | 672px |
| `max-w-4xl` | 56rem | 896px |
| `max-w-7xl` | 80rem | 1280px |

---

## 6. Flexbox

### Display & Direction

```html
<!-- Enable flexbox -->
<div class="flex">display: flex</div>

<!-- Direction -->
<div class="flex flex-row">horizontal (default)</div>
<div class="flex flex-col">vertical</div>
<div class="flex flex-row-reverse">reverse horizontal</div>
<div class="flex flex-col-reverse">reverse vertical</div>
```

### Justify Content (Main Axis)

```html
<div class="flex justify-start">flex-start</div>
<div class="flex justify-center">center</div>
<div class="flex justify-end">flex-end</div>
<div class="flex justify-between">space-between</div>
<div class="flex justify-around">space-around</div>
<div class="flex justify-evenly">space-evenly</div>
```

### Align Items (Cross Axis)

```html
<div class="flex items-start">align to start</div>
<div class="flex items-center">center</div>
<div class="flex items-end">align to end</div>
<div class="flex items-stretch">stretch (default)</div>
<div class="flex items-baseline">baseline</div>
```

### Flex Grow/Shrink

```html
<div class="flex-1">flex: 1 1 0%</div>
<div class="flex-auto">flex: 1 1 auto</div>
<div class="flex-none">flex: none</div>
<div class="grow">flex-grow: 1</div>
<div class="shrink-0">flex-shrink: 0</div>
```

### Common Patterns

```html
<!-- Center everything -->
<div class="flex items-center justify-center">
  Centered content
</div>

<!-- Space between with vertical center -->
<div class="flex items-center justify-between">
  <span>Left</span>
  <span>Right</span>
</div>

<!-- Column with gap -->
<div class="flex flex-col gap-4">
  <div>Item 1</div>
  <div>Item 2</div>
</div>

<!-- Responsive direction -->
<div class="flex flex-col md:flex-row gap-4">
  <div>Stacked on mobile, side-by-side on desktop</div>
</div>
```

---

## 7. Grid

### Basic Grid

```html
<!-- Enable grid -->
<div class="grid">display: grid</div>

<!-- Define columns -->
<div class="grid grid-cols-1">1 column</div>
<div class="grid grid-cols-2">2 columns</div>
<div class="grid grid-cols-3">3 columns</div>
<div class="grid grid-cols-12">12 columns</div>

<!-- With gap -->
<div class="grid grid-cols-3 gap-4">
  <div>1</div>
  <div>2</div>
  <div>3</div>
</div>
```

### Column/Row Spanning

```html
<div class="grid grid-cols-6 gap-4">
  <div class="col-span-2">Spans 2 columns</div>
  <div class="col-span-4">Spans 4 columns</div>
  <div class="col-span-full">Spans all columns</div>
</div>

<!-- Row spanning -->
<div class="row-span-2">Spans 2 rows</div>
```

### Responsive Grid

```html
<!-- Mobile: 1 col, Tablet: 2 cols, Desktop: 3 cols, Large: 4 cols -->
<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
  <div>Card 1</div>
  <div>Card 2</div>
  <div>Card 3</div>
  <div>Card 4</div>
</div>
```

---

## 8. Responsive Design

### Breakpoints

| Prefix | Min Width | CSS |
|--------|-----------|-----|
| (none) | 0px | Default (mobile-first) |
| `sm:` | 640px | `@media (min-width: 640px)` |
| `md:` | 768px | `@media (min-width: 768px)` |
| `lg:` | 1024px | `@media (min-width: 1024px)` |
| `xl:` | 1280px | `@media (min-width: 1280px)` |
| `2xl:` | 1536px | `@media (min-width: 1536px)` |

### Mobile-First Approach

```html
<!-- Base style (mobile), then override at breakpoints -->
<div class="text-center sm:text-left">
  <!-- Centered on mobile, left-aligned on 640px+ -->
</div>

<img class="w-16 md:w-32 lg:w-48" />
<!-- 16 units on mobile, 32 on 768px+, 48 on 1024px+ -->
```

### Max-Width Variants

```html
<!-- Apply BELOW a breakpoint -->
<div class="max-sm:hidden">Hidden below 640px</div>
<div class="max-md:flex-col">Column below 768px</div>
```

### Breakpoint Ranges

```html
<!-- Apply only between md and lg -->
<div class="md:max-lg:bg-blue-500">
  Blue only between 768px and 1024px
</div>
```

### Common Responsive Patterns

```html
<!-- Stack on mobile, side-by-side on desktop -->
<div class="flex flex-col md:flex-row gap-4">
  <div class="md:w-1/2">Left</div>
  <div class="md:w-1/2">Right</div>
</div>

<!-- Responsive text size -->
<h1 class="text-2xl md:text-4xl lg:text-6xl font-bold">
  Responsive Heading
</h1>

<!-- Responsive padding -->
<div class="p-4 md:p-8 lg:p-12">
  Content
</div>

<!-- Hide/show based on screen size -->
<nav class="hidden md:flex">Desktop navigation</nav>
<button class="md:hidden">Mobile menu button</button>
```

---

## 9. Dark Mode

### Basic Usage

```html
<!-- Light/dark backgrounds -->
<div class="bg-white dark:bg-gray-900">
  <p class="text-gray-900 dark:text-white">
    Adapts to theme
  </p>
</div>
```

### Complete Theme Pattern

```css
/* app.css */
@import "tailwindcss";
@custom-variant dark (&:where(.dark, .dark *));

@theme {
  --color-background: #ffffff;
  --color-foreground: #171717;
}

@media (prefers-color-scheme: dark) {
  @theme {
    --color-background: #0a0a0a;
    --color-foreground: #ededed;
  }
}
```

```html
<div class="bg-background text-foreground">
  Uses theme colors automatically
</div>
```

### Toggle Script

```javascript
// Check system preference on load
if (localStorage.theme === 'dark' ||
    (!('theme' in localStorage) &&
     window.matchMedia('(prefers-color-scheme: dark)').matches)) {
  document.documentElement.classList.add('dark');
}

// Toggle function
function toggleTheme() {
  document.documentElement.classList.toggle('dark');
  localStorage.theme = document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'light';
}
```

---

## 10. Interactive States

### Hover, Focus, Active

```html
<!-- Hover -->
<button class="bg-blue-500 hover:bg-blue-600">
  Hover me
</button>

<!-- Focus -->
<input class="border focus:ring-2 focus:ring-blue-500 focus:border-blue-500" />

<!-- Active (pressed) -->
<button class="bg-blue-500 active:bg-blue-700">
  Press me
</button>

<!-- Focus-visible (keyboard only) -->
<button class="focus-visible:ring-2 focus-visible:ring-offset-2">
  Keyboard focus
</button>
```

### Form States

```html
<!-- Disabled -->
<input class="disabled:opacity-50 disabled:cursor-not-allowed" disabled />

<!-- Invalid -->
<input class="invalid:border-red-500 invalid:text-red-600" type="email" />

<!-- Required -->
<input class="required:border-red-500" required />

<!-- Checked -->
<input type="checkbox" class="checked:bg-blue-500" />
```

### Group Hover

```html
<a href="#" class="group p-4 border rounded-lg">
  <h3 class="text-gray-900 group-hover:text-blue-600">
    Title
  </h3>
  <p class="text-gray-500 group-hover:text-gray-700">
    Description
  </p>
</a>
```

---

## 11. Shadows & Effects

### Box Shadow

| Class | Description |
|-------|-------------|
| `shadow-sm` | Subtle shadow |
| `shadow` | Default shadow |
| `shadow-md` | Medium shadow |
| `shadow-lg` | Large shadow |
| `shadow-xl` | Extra large |
| `shadow-2xl` | 2x large |
| `shadow-inner` | Inset shadow |
| `shadow-none` | No shadow |

```html
<!-- Card with shadow -->
<div class="bg-white p-6 rounded-lg shadow-lg">
  Card content
</div>

<!-- Interactive shadow -->
<div class="shadow-md hover:shadow-xl transition-shadow">
  Hover for larger shadow
</div>
```

### Border Radius

| Class | Value |
|-------|-------|
| `rounded-none` | 0 |
| `rounded-sm` | 0.125rem (2px) |
| `rounded` | 0.25rem (4px) |
| `rounded-md` | 0.375rem (6px) |
| `rounded-lg` | 0.5rem (8px) |
| `rounded-xl` | 0.75rem (12px) |
| `rounded-2xl` | 1rem (16px) |
| `rounded-3xl` | 1.5rem (24px) |
| `rounded-full` | 9999px (pill/circle) |

```html
<!-- Individual corners -->
<div class="rounded-t-lg">Top corners only</div>
<div class="rounded-tl-lg">Top-left only</div>
<div class="rounded-b-lg rounded-t-none">Bottom only, no top</div>
```

### Ring (Focus Ring)

```html
<button class="focus:ring-2 focus:ring-blue-500 focus:ring-offset-2">
  Focus ring on keyboard focus
</button>
```

---

## 12. Transitions & Animations

### Transition Utilities

```html
<!-- Default transition (most properties) -->
<button class="transition hover:bg-blue-600">
  Smooth hover
</button>

<!-- Specific properties -->
<button class="transition-colors hover:bg-blue-600">Colors only</button>
<button class="transition-transform hover:scale-105">Transform only</button>
<button class="transition-opacity hover:opacity-50">Opacity only</button>
<button class="transition-shadow hover:shadow-lg">Shadow only</button>
<button class="transition-all hover:bg-blue-600 hover:scale-105">All</button>
```

### Duration

| Class | Duration |
|-------|----------|
| `duration-75` | 75ms |
| `duration-150` | 150ms |
| `duration-200` | 200ms |
| `duration-300` | 300ms |
| `duration-500` | 500ms |
| `duration-700` | 700ms |
| `duration-1000` | 1000ms |

### Timing Functions

| Class | Easing |
|-------|--------|
| `ease-linear` | Linear |
| `ease-in` | Ease in |
| `ease-out` | Ease out |
| `ease-in-out` | Ease in-out |

### Complete Transition Example

```html
<button class="px-4 py-2
               bg-blue-500 hover:bg-blue-600
               text-white
               rounded-lg
               shadow-md hover:shadow-lg
               transform hover:scale-105 active:scale-95
               transition-all duration-200 ease-out">
  Interactive Button
</button>
```

### Reduced Motion

```html
<!-- Respect user preferences -->
<button class="transition duration-300 motion-reduce:duration-0">
  Accessible animation
</button>
```

---

## 13. Layers System

### @layer base (Global Styles)

```css
@layer base {
  h1 {
    @apply text-2xl font-bold;
  }

  * {
    @apply border-gray-200;
  }
}
```

### @layer components (Reusable Components)

```css
@layer components {
  .btn {
    @apply px-4 py-2 rounded font-medium;
  }

  .btn-primary {
    @apply bg-blue-500 text-white hover:bg-blue-600;
  }

  .card {
    @apply bg-white rounded-lg shadow-md p-6;
  }
}
```

### @utility (Custom Utilities)

```css
@utility container {
  @apply mx-auto px-4 sm:px-8 lg:px-16;
}

@utility btn-custom {
  @apply bg-blue-500 text-white px-4 py-2 rounded;
  @variant hover {
    @apply bg-blue-600;
  }
}
```

---

## 14. Arbitrary Values

### Basic Syntax

```html
<!-- Dimensions -->
<div class="w-[500px] h-[300px]">Fixed size</div>

<!-- Colors -->
<div class="bg-[#ff5733] text-[rgb(255,87,51)]">Custom colors</div>

<!-- CSS calculations -->
<div class="w-[calc(100%-2rem)]">Calculated width</div>

<!-- Grid columns -->
<div class="grid-cols-[200px_1fr_100px]">Custom grid</div>
```

### CSS Variables (v4 Syntax)

```html
<!-- v4: Use parentheses for CSS variables -->
<div class="bg-(--brand-color)">CSS variable</div>

<!-- NOT square brackets (v3 syntax) -->
<!-- <div class="bg-[var(--brand-color)]"> DEPRECATED -->
```

### Type Hints

```html
<!-- Specify type when ambiguous -->
<div class="bg-[length:200px_100px]">Background size</div>
<div class="bg-[url('/img.png')]">Background image</div>
```

---

## 15. Component Patterns

### Navbar

```html
<nav class="flex items-center justify-between px-6 py-4 bg-white shadow-sm">
  <div class="flex items-center gap-2">
    <img src="/logo.svg" class="w-8 h-8" />
    <span class="text-lg font-semibold">Brand</span>
  </div>

  <div class="hidden md:flex items-center gap-6">
    <a href="#" class="text-gray-600 hover:text-gray-900">Features</a>
    <a href="#" class="text-gray-600 hover:text-gray-900">Pricing</a>
    <button class="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600">
      Sign In
    </button>
  </div>

  <button class="md:hidden">
    <svg class="w-6 h-6"><!-- menu icon --></svg>
  </button>
</nav>
```

### Hero Section

```html
<section class="py-16 md:py-24">
  <div class="container mx-auto px-4 text-center">
    <h1 class="text-4xl md:text-6xl font-bold text-gray-900 mb-6">
      Build faster with Tailwind
    </h1>
    <p class="text-lg md:text-xl text-gray-600 max-w-2xl mx-auto mb-8">
      A utility-first CSS framework for rapid UI development
    </p>
    <div class="flex flex-col sm:flex-row items-center justify-center gap-4">
      <button class="px-6 py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600">
        Get Started
      </button>
      <button class="px-6 py-3 border border-gray-300 rounded-lg hover:bg-gray-50">
        Learn More
      </button>
    </div>
  </div>
</section>
```

### Card

```html
<div class="bg-white rounded-xl shadow-lg overflow-hidden
            hover:shadow-xl transition-shadow duration-300">
  <img src="/image.jpg" class="w-full h-48 object-cover" />
  <div class="p-6">
    <span class="text-sm text-blue-500 font-medium uppercase tracking-wide">
      Category
    </span>
    <h3 class="text-xl font-semibold mt-2 mb-3">
      Card Title
    </h3>
    <p class="text-gray-600 mb-4">
      Card description goes here with some details.
    </p>
    <button class="text-blue-500 font-medium hover:text-blue-600">
      Read more &rarr;
    </button>
  </div>
</div>
```

### Interactive Button

```html
<button class="px-6 py-3
               bg-blue-500 hover:bg-blue-600 active:bg-blue-700
               text-white font-semibold
               rounded-lg
               shadow-lg hover:shadow-xl
               focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2
               transform hover:scale-105 active:scale-95
               transition-all duration-200
               disabled:opacity-50 disabled:cursor-not-allowed">
  Click Me
</button>
```

### Form Input

```html
<input
  type="email"
  placeholder="Enter your email"
  class="w-full px-4 py-2
         border-2 border-gray-300 rounded-lg
         focus:border-blue-500 focus:ring-2 focus:ring-blue-200 focus:outline-none
         invalid:border-red-500 invalid:focus:ring-red-200
         disabled:bg-gray-100 disabled:cursor-not-allowed
         transition-colors duration-200
         placeholder:text-gray-400"
/>
```

### Gradient Text

```html
<h1 class="inline-block
           bg-gradient-to-r from-blue-500 via-purple-500 to-pink-500
           bg-clip-text text-transparent
           text-4xl font-bold">
  Gradient Heading
</h1>
```

---

## 16. Best Practices

### DO

1. **Mobile-first**: Write base styles for mobile, add breakpoint modifiers for larger screens
2. **Use semantic color names**: Define `--color-primary`, `--color-background` in `@theme`
3. **Extract repeated patterns**: Use `@layer components` for reusable component classes
4. **Leverage arbitrary values sparingly**: Prefer theme tokens, extract to `@theme` if repeated
5. **Use `gap` over `space-*`**: More flexible and works with both flex and grid
6. **Add transitions**: `transition-all duration-200` for smooth interactions
7. **Include focus states**: Always add `focus:ring-*` for accessibility

### DON'T

1. **Don't fight Tailwind**: If you're writing lots of custom CSS, reconsider your approach
2. **Don't nest arbitrarily**: Keep class lists readable, extract to components when too long
3. **Don't forget responsive**: Always test at multiple breakpoints
4. **Don't skip dark mode**: Add `dark:` variants from the start
5. **Don't use old v3 syntax**: `bg-[var(--color)]` is now `bg-(--color)` in v4
6. **Don't overuse `@apply`**: It defeats the utility-first purpose

### Performance Tips

1. v4 is 5x faster for full builds, 100x faster for incremental
2. No manual content configuration needed (auto-detects templates)
3. Use CSS layers for proper cascade control
4. Built-in vendor prefixing (no autoprefixer needed)

---

## 17. CSS Cheatsheet

### Display

```css
.block        -> display: block;
.inline       -> display: inline;
.inline-block -> display: inline-block;
.flex         -> display: flex;
.grid         -> display: grid;
.hidden       -> display: none;
```

### Position

```css
.static   -> position: static;
.relative -> position: relative;
.absolute -> position: absolute;
.fixed    -> position: fixed;
.sticky   -> position: sticky;
.inset-0  -> top: 0; right: 0; bottom: 0; left: 0;
```

### Overflow

```css
.overflow-hidden -> overflow: hidden;
.overflow-auto   -> overflow: auto;
.overflow-scroll -> overflow: scroll;
.overflow-x-auto -> overflow-x: auto;
```

### Z-Index

```css
.z-0    -> z-index: 0;
.z-10   -> z-index: 10;
.z-20   -> z-index: 20;
.z-50   -> z-index: 50;
.z-auto -> z-index: auto;
```

---

## 18. Migration from v3

### Key Changes

| v3 | v4 |
|----|-----|
| `tailwind.config.js` | `@theme` in CSS |
| `@tailwind base/components/utilities` | `@import "tailwindcss"` |
| `bg-[var(--color)]` | `bg-(--color)` |
| `darkMode: 'class'` in config | `@custom-variant dark` in CSS |
| Requires autoprefixer | Built-in vendor prefixing |

### Upgrade Command

```bash
bunx @tailwindcss/upgrade
```

### Manual Steps

1. Update imports: `@import "tailwindcss";`
2. Move theme config to CSS `@theme` block
3. Update CSS variable syntax in classes
4. Update arbitrary values with commas to underscores

---

## Resources

- [Official Docs](https://tailwindcss.com/docs)
- [Color Reference](https://tailwindcss.com/docs/colors)
- [Responsive Design](https://tailwindcss.com/docs/responsive-design)
- [Dark Mode](https://tailwindcss.com/docs/dark-mode)
- [Upgrade Guide](https://tailwindcss.com/docs/upgrade-guide)

---

## Checklist Before Writing Tailwind Code

1. **Responsive**: Am I using mobile-first breakpoints (`sm:`, `md:`, `lg:`)?
2. **Dark mode**: Have I added `dark:` variants for theme-aware colors?
3. **Interactive states**: Do buttons/links have `hover:`, `focus:`, `active:` states?
4. **Transitions**: Have I added `transition-*` for smooth interactions?
5. **Accessibility**: Do interactive elements have `focus:ring-*` and `focus-visible:`?
6. **Spacing**: Am I using consistent spacing scale values?
7. **Color opacity**: Am I using `/` syntax for opacity (e.g., `bg-blue-500/75`)?
8. **Custom values**: If using arbitrary values, can I extract to `@theme`?
