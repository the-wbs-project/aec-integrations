# AEC Integrations — UI Style Guide

This is the source of truth for the visual language of the AEC Integrations application. Every color, spacing value, type size, and component pattern lives here. If you're building a screen, a component, or a feature, you reference this document first and only deviate with a documented reason.

The principles behind every decision in this doc:

1. **Editorial, not SaaS-y.** The brand is closer to a publication than to a typical B2B dashboard. Generous whitespace, restrained color, type that does most of the work.
2. **Forest is the brand.** Forest green (`#1E3A2F`) appears on every screen, in every state, light or dark. If you can only pick one color, it's this one.
3. **Clay is rare.** Clay (`#E89668`) is the only saturated color in the system. If it appears in more than ~5% of any given screen, it's losing its meaning. Use it for the connector mark, primary CTAs, and key highlights — nothing else.
4. **Borders over shadows.** The brand reads quiet, not lifted. Use `0.5px` borders to separate surfaces. Reserve box-shadows for focus rings only.
5. **Sentence case everywhere.** Headings, buttons, labels, table headers — all sentence case. Title Case reads as marketing; sentence case reads as editorial.

---

## Design tokens

All tokens are defined as CSS custom properties on `:root` for light mode and `[data-theme="dark"]` for dark mode. Use the variables, never the raw hex values, so dark mode flips automatically.

### Color tokens

```css
:root {
  /* Brand colors — these don't change between modes */
  --color-brand-forest: #1E3A2F;
  --color-brand-bone: #F5F2EA;
  --color-brand-clay: #E89668;

  /* Surfaces */
  --color-bg-page: #F5F2EA;        /* Bone — default page background */
  --color-bg-elevated: #FFFFFF;    /* Paper — cards, modals, panels */
  --color-bg-recessed: #EDE9DE;    /* Bone 600 — input fields, code blocks */
  --color-bg-overlay: rgba(15, 20, 25, 0.45); /* Modal backdrops */

  /* Text */
  --color-text-primary: #1E3A2F;   /* Forest — headings, primary text */
  --color-text-body: #0F1419;      /* Ink — long-form body copy */
  --color-text-secondary: #6B6B63; /* Stone — captions, labels, metadata */
  --color-text-tertiary: #9A9A8E;  /* Stone 400 — placeholders, disabled */
  --color-text-inverse: #F5F2EA;   /* Bone — text on dark surfaces */
  --color-text-accent: #C97A4F;    /* Clay 700 — links, accent text on light bg */

  /* Borders */
  --color-border-default: rgba(30, 58, 47, 0.12);  /* Default 0.5px borders */
  --color-border-strong: rgba(30, 58, 47, 0.24);   /* Hover state, dividers */
  --color-border-focus: #1E3A2F;                    /* Focus ring */

  /* Accent (clay) — interactive states */
  --color-accent: #E89668;
  --color-accent-hover: #DD8456;
  --color-accent-active: #C97042;
  --color-accent-bg: rgba(232, 150, 104, 0.12);    /* Tinted accent backgrounds */

  /* Semantic colors */
  --color-success: #2D7A4F;
  --color-success-bg: rgba(45, 122, 79, 0.10);
  --color-warning: #B87333;
  --color-warning-bg: rgba(184, 115, 51, 0.10);
  --color-danger: #A8341F;
  --color-danger-bg: rgba(168, 52, 31, 0.10);
  --color-info: #2E5A7A;
  --color-info-bg: rgba(46, 90, 122, 0.10);
}

[data-theme="dark"] {
  /* Surfaces — forest becomes the canvas */
  --color-bg-page: #1E3A2F;        /* Forest — page background */
  --color-bg-elevated: #2A4A3D;    /* Forest 600 — cards lift toward lighter */
  --color-bg-recessed: #162B23;    /* Forest 900 — inputs sink toward darker */
  --color-bg-overlay: rgba(0, 0, 0, 0.6);

  /* Text */
  --color-text-primary: #F5F2EA;   /* Bone */
  --color-text-body: #EDE9DE;      /* Bone 600 */
  --color-text-secondary: #9A9A8E; /* Stone 400 */
  --color-text-tertiary: #6B6B63;  /* Stone */
  --color-text-inverse: #1E3A2F;   /* Forest — text on light surfaces */
  --color-text-accent: #F0A77E;    /* Clay 400 — brighter for dark bg contrast */

  /* Borders */
  --color-border-default: rgba(245, 242, 234, 0.12);
  --color-border-strong: rgba(245, 242, 234, 0.24);
  --color-border-focus: #F5F2EA;

  /* Accent shifts brighter in dark mode */
  --color-accent: #F0A77E;
  --color-accent-hover: #F4B891;
  --color-accent-active: #E89668;
  --color-accent-bg: rgba(240, 167, 126, 0.16);

  /* Semantic colors — slightly desaturated for dark bg */
  --color-success: #5BA577;
  --color-success-bg: rgba(91, 165, 119, 0.16);
  --color-warning: #D49858;
  --color-warning-bg: rgba(212, 152, 88, 0.16);
  --color-danger: #C95A45;
  --color-danger-bg: rgba(201, 90, 69, 0.16);
  --color-info: #6B95B5;
  --color-info-bg: rgba(107, 149, 181, 0.16);
}
```

**Rules:**

- Always use the variables. Never hardcode `#1E3A2F` in a component file.
- Pure white (`#FFFFFF`) is reserved for `--color-bg-elevated` only. Don't introduce it elsewhere.
- Pure black is never used. Use `--color-text-body` (`#0F1419`) for long-form text.
- Clay only appears as an accent. Never use it for body text, page backgrounds, or large surface fills.

### Type tokens

The brand uses a single sans-serif typeface. Inter is the default; the system stack is the fallback chain.

```css
:root {
  --font-sans: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  --font-mono: 'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace;

  /* Font sizes — tight scale, no 6 sizes between H1 and body */
  --text-xs: 11px;
  --text-sm: 13px;
  --text-base: 15px;     /* Body default */
  --text-md: 17px;       /* Lead paragraphs */
  --text-lg: 20px;       /* H4 */
  --text-xl: 24px;       /* H3 */
  --text-2xl: 30px;      /* H2 */
  --text-3xl: 38px;      /* H1 */
  --text-display: 52px;  /* Hero only */

  /* Font weights — only two */
  --font-weight-regular: 400;
  --font-weight-medium: 500;

  /* Line heights */
  --leading-tight: 1.2;   /* Headings */
  --leading-snug: 1.4;    /* Subheads, lead paragraphs */
  --leading-normal: 1.6;  /* Body */
  --leading-relaxed: 1.75; /* Long-form reading */

  /* Letter-spacing */
  --tracking-tight: -0.02em;   /* Large headings */
  --tracking-normal: 0;
  --tracking-wide: 0.04em;     /* Labels, eyebrows, all-caps (use sparingly) */
}
```

**Type rules:**

- **Two weights only: 400 (regular) and 500 (medium).** Never use 600, 700, or 800. They look heavy and over-designed against the rest of the system.
- **Sentence case for everything.** No Title Case in headings, button labels, navigation, or table headers.
- **Headings use Forest (`--color-text-primary`).** Body copy uses Ink (`--color-text-body`). They are different colors on purpose — Forest is too saturated for long reading.
- **Line-height for body is `--leading-normal` (1.6) minimum.** This is a reading-heavy product. Tight body line-height makes it feel cramped.
- **No mid-sentence bolding.** If you need to emphasize something inline, restructure the sentence or use `<code>` styling. Bold is for headings and form labels only.

### Spacing tokens

A 4px-based scale. Stick to it — don't introduce intermediate values.

```css
:root {
  --space-0: 0;
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;
  --space-16: 64px;
  --space-20: 80px;
  --space-24: 96px;
}
```

**Rules:**

- Component-internal spacing (padding, gaps): `--space-2` to `--space-4`.
- Card padding: `--space-4` to `--space-6`.
- Section spacing (between major page sections): `--space-12` to `--space-20`.
- Page margins: `--space-6` on mobile, `--space-12` on tablet, `--space-16` on desktop.
- **Never use odd values.** No `15px`, no `22px`. If the design calls for something between two scale values, pick one.

### Radius tokens

```css
:root {
  --radius-sm: 4px;    /* Pills, tags, badges, inline elements */
  --radius-md: 6px;    /* Inputs, buttons, small cards */
  --radius-lg: 8px;    /* Cards, modals, major panels */
  --radius-xl: 12px;   /* Hero cards, feature panels */
  --radius-full: 9999px; /* Fully rounded — avatars, icon buttons */
}
```

**Rule:** Never use rounded corners on single-sided borders (e.g., `border-left` accents). Rounded corners only work with full borders. If using a `border-left` accent, set `border-radius: 0`.

### Border tokens

```css
:root {
  --border-thin: 0.5px solid var(--color-border-default);
  --border-default: 1px solid var(--color-border-default);
  --border-strong: 1px solid var(--color-border-strong);
  --border-focus: 2px solid var(--color-border-focus);
}
```

**The default border is `0.5px`, not `1px`.** This is intentional and central to the brand's quiet, editorial feel. `1px` borders look heavy in this color system.

### Shadow tokens

```css
:root {
  /* Use shadows extremely sparingly. Borders do most of the separation work. */
  --shadow-focus-ring: 0 0 0 3px rgba(232, 150, 104, 0.32);
  --shadow-modal: 0 20px 60px rgba(15, 20, 25, 0.16);
  --shadow-dropdown: 0 8px 24px rgba(15, 20, 25, 0.08);
}
```

**No drop shadows on cards, buttons, or inputs.** Only modals and dropdowns get shadows, and only because they need to feel detached from the page.

### Motion tokens

```css
:root {
  --duration-fast: 120ms;
  --duration-base: 180ms;
  --duration-slow: 280ms;
  --easing-default: cubic-bezier(0.2, 0, 0, 1);
  --easing-emphasized: cubic-bezier(0.3, 0, 0, 1);
}
```

**Motion rules:**

- Default transition: `all var(--duration-base) var(--easing-default)`.
- Hover states: `--duration-fast`. They should feel instant.
- Page transitions: `--duration-slow`. Larger movements need more time.
- Never animate `color`, `background-color`, and `transform` together with different durations. Pick one duration for the whole element.

---

## Layout

### Page width

```css
.page-container {
  max-width: 1240px;
  margin: 0 auto;
  padding: 0 var(--space-6);
}

.page-container--narrow {
  max-width: 720px;  /* Long-form reading: articles, listing detail pages */
}

.page-container--wide {
  max-width: 1440px;  /* Dashboards, data tables, comparison views */
}
```

### Grid

Use CSS Grid for layouts, not Flexbox. Flexbox is for component-internal arrangement.

```css
.grid-listings {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-6);
}
```

**Critical:** `grid-template-columns: 1fr` defaults to `min-width: auto`, which lets children with large content push columns past the container. Always use `minmax(0, 1fr)` for grid columns inside constrained layouts.

---

## Components

### Buttons

Three variants only: primary, secondary, ghost. No tertiary, no link buttons (use `<a>` for links).

```css
/* Base button — never use directly, always with a variant */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  height: 36px;
  padding: 0 var(--space-4);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  font-weight: var(--font-weight-medium);
  border-radius: var(--radius-md);
  border: var(--border-thin);
  cursor: pointer;
  transition: all var(--duration-fast) var(--easing-default);
  white-space: nowrap;
}

.btn:focus-visible {
  outline: none;
  box-shadow: var(--shadow-focus-ring);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Primary — clay accent, used sparingly. One per screen, ideally. */
.btn--primary {
  background: var(--color-accent);
  color: var(--color-brand-forest);
  border-color: transparent;
}
.btn--primary:hover { background: var(--color-accent-hover); }
.btn--primary:active { background: var(--color-accent-active); }

/* Secondary — the default for most actions */
.btn--secondary {
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
  border-color: var(--color-border-strong);
}
.btn--secondary:hover {
  background: var(--color-bg-recessed);
  border-color: var(--color-text-primary);
}

/* Ghost — for low-priority actions in dense UIs */
.btn--ghost {
  background: transparent;
  color: var(--color-text-primary);
  border-color: transparent;
}
.btn--ghost:hover { background: var(--color-bg-recessed); }

/* Sizes */
.btn--sm { height: 28px; padding: 0 var(--space-3); font-size: var(--text-xs); }
.btn--lg { height: 44px; padding: 0 var(--space-6); font-size: var(--text-base); }
```

**Button rules:**

- **One primary button per screen.** If you have two equally important actions, neither is primary — they're both secondary. Multiple primary buttons compete for attention and lose it.
- **Button text is always sentence case.** "Save changes", not "Save Changes". "View 12 integrations", not "View 12 Integrations".
- **No "Click here".** Button labels describe what happens when clicked.
- **Icons go on the left of text** for actions ("← Back", "↻ Refresh"). Icons go on the right for navigation forward ("Continue →", "View details →").

### Cards

The card is the most-used surface in the application — listings, tool detail panels, integration entries. There's one card pattern, and it has variants.

```css
.card {
  background: var(--color-bg-elevated);
  border: var(--border-thin);
  border-radius: var(--radius-lg);
  padding: var(--space-5);
  transition: border-color var(--duration-base) var(--easing-default);
}

.card--interactive {
  cursor: pointer;
}
.card--interactive:hover {
  border-color: var(--color-border-strong);
}

.card--featured {
  border: 2px solid var(--color-accent);  /* The only place 2px borders are allowed */
}

.card__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3);
  margin-bottom: var(--space-3);
}

.card__title {
  font-size: var(--text-lg);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  line-height: var(--leading-tight);
}

.card__meta {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
  margin-top: var(--space-1);
}

.card__body {
  font-size: var(--text-sm);
  color: var(--color-text-body);
  line-height: var(--leading-normal);
}

.card__footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--space-4);
  padding-top: var(--space-3);
  border-top: var(--border-thin);
}
```

**Card rules:**

- **Cards never have shadows.** Border separation only.
- **Cards never have hover lift effects** (no `transform: translateY`). The hover state is a border color shift.
- **Featured cards use a 2px clay border.** This is the only exception to the 0.5px-default rule. Use it for "verified", "featured", or "most popular" markers — never on more than one card per screen.
- **Card padding is always uniform.** Don't use `padding: 16px 24px`. Use `padding: var(--space-5)` and let internal elements handle their own spacing.

### Inputs and forms

```css
.input {
  display: block;
  width: 100%;
  height: 36px;
  padding: 0 var(--space-3);
  font-family: var(--font-sans);
  font-size: var(--text-sm);
  color: var(--color-text-primary);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  transition: all var(--duration-fast) var(--easing-default);
}

.input::placeholder {
  color: var(--color-text-tertiary);
}

.input:hover {
  border-color: var(--color-text-secondary);
}

.input:focus {
  outline: none;
  border-color: var(--color-text-primary);
  box-shadow: var(--shadow-focus-ring);
}

.input:disabled {
  background: var(--color-bg-recessed);
  color: var(--color-text-tertiary);
  cursor: not-allowed;
}

.input--error {
  border-color: var(--color-danger);
}
.input--error:focus {
  box-shadow: 0 0 0 3px var(--color-danger-bg);
}

/* Textarea inherits from .input */
.textarea {
  height: auto;
  min-height: 96px;
  padding: var(--space-3);
  line-height: var(--leading-normal);
  resize: vertical;
}

/* Field group — label + input + helper text */
.field {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.field__label {
  font-size: var(--text-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
}

.field__hint {
  font-size: var(--text-xs);
  color: var(--color-text-secondary);
}

.field__error {
  font-size: var(--text-xs);
  color: var(--color-danger);
}
```

**Form rules:**

- **Inputs are 36px tall by default.** This matches the default button height so they line up in inline forms.
- **Labels go above inputs, not beside them.** Right-aligned labels are a 2010s pattern that doesn't work on mobile.
- **Helper text is `--text-xs` and `--color-text-secondary`.** Don't make hints louder than the input itself.
- **Required fields don't get red asterisks.** Add "(required)" to optional contexts or "(optional)" to required-by-default contexts. Asterisks are noise.
- **Error states use `--color-danger` on the border, plus an error message below.** Don't rely on color alone — always show the message.

### Badges and tags

```css
.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  height: 20px;
  padding: 0 var(--space-2);
  font-size: var(--text-xs);
  font-weight: var(--font-weight-medium);
  border-radius: var(--radius-sm);
  white-space: nowrap;
}

.badge--neutral {
  background: var(--color-bg-recessed);
  color: var(--color-text-secondary);
}

.badge--accent {
  background: var(--color-accent-bg);
  color: var(--color-text-accent);
}

.badge--success { background: var(--color-success-bg); color: var(--color-success); }
.badge--warning { background: var(--color-warning-bg); color: var(--color-warning); }
.badge--danger { background: var(--color-danger-bg); color: var(--color-danger); }
.badge--info { background: var(--color-info-bg); color: var(--color-info); }
```

**Badge rules:**

- **Use sparingly.** A card with five badges is a card with no badges — they all blur together.
- **Verified status uses `.badge--accent` (clay).** This is the most important badge in the product. Don't dilute it by using clay for other badges.

### Tables

```css
.table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
}

.table th {
  text-align: left;
  font-weight: var(--font-weight-medium);
  color: var(--color-text-secondary);
  padding: var(--space-3) var(--space-4);
  border-bottom: var(--border-thin);
  font-size: var(--text-xs);
  /* Sentence case, NOT all caps */
}

.table td {
  padding: var(--space-4);
  border-bottom: var(--border-thin);
  color: var(--color-text-body);
  vertical-align: top;
}

.table tr:last-child td {
  border-bottom: none;
}

.table--striped tbody tr:nth-child(even) {
  background: var(--color-bg-recessed);
}

.table--compact th,
.table--compact td {
  padding: var(--space-2) var(--space-3);
}
```

**Table rules:**

- **Headers are sentence case, not ALL CAPS.** All caps is a 2015 SaaS pattern that conflicts with the editorial brand.
- **No vertical borders between columns.** Horizontal rules only. Vertical lines make tables feel like spreadsheets.
- **Striped rows are optional.** Use them only when row density is high enough that the eye loses track of which row it's reading. For tables with ~10 rows, skip striping.

### Navigation

```css
.nav {
  display: flex;
  align-items: center;
  gap: var(--space-1);
}

.nav__item {
  display: inline-flex;
  align-items: center;
  height: 36px;
  padding: 0 var(--space-3);
  font-size: var(--text-sm);
  font-weight: var(--font-weight-regular);
  color: var(--color-text-secondary);
  text-decoration: none;
  border-radius: var(--radius-md);
  transition: all var(--duration-fast) var(--easing-default);
}

.nav__item:hover {
  color: var(--color-text-primary);
  background: var(--color-bg-recessed);
}

.nav__item--active {
  color: var(--color-text-primary);
  font-weight: var(--font-weight-medium);
}
```

**Nav rules:**

- **Active state uses weight, not color.** The active item shifts from regular to medium and from secondary to primary text color. No underlines, no clay accents — too loud.
- **Don't use clay anywhere in navigation.** Clay is for actions, not orientation.

---

## Iconography

Use **Lucide** icons exclusively. Don't mix icon libraries.

```css
.icon {
  display: inline-block;
  width: 16px;
  height: 16px;
  flex-shrink: 0;  /* Critical — without this, icons get squished in flex containers */
  stroke-width: 1.5;
}

.icon--sm { width: 14px; height: 14px; }
.icon--lg { width: 20px; height: 20px; }
.icon--xl { width: 24px; height: 24px; }
```

**Icon rules:**

- **Stroke width is 1.5, not 2.** The default 2px Lucide stroke is too heavy for this brand. 1.5 matches the editorial weight.
- **Icons inherit `currentColor`.** Don't set `fill` or `stroke` directly — let CSS color cascade through.
- **Always set explicit width/height.** Icons in flex containers without dimensions expand to fill, which looks awful.
- **No emoji.** Lucide has every icon you need. Emoji rendering is inconsistent across platforms and clashes with the brand.

---

## Accessibility

Non-negotiable rules. The product is read-heavy and used by professionals — accessibility isn't a checkbox, it's table stakes.

- **All interactive elements need a visible focus state.** The `--shadow-focus-ring` is the default; don't strip it without replacing it.
- **Color contrast must meet WCAG AA minimum.** Body text on `--color-bg-page` is well above. Verify any custom color combinations with a contrast checker.
- **Never communicate state with color alone.** Error states need an icon or text. Required fields get a label, not just a red border.
- **All form inputs have associated labels.** Use `<label for="x">` or wrap the input in a `<label>`. Placeholder text is not a label.
- **Icon-only buttons need an `aria-label`.** "Close", "Search", "Filter" — describe the action.
- **Skip-to-content link required at the top of every page.** Hidden until focused.

---

## Dark mode

The application supports dark mode via `[data-theme="dark"]`. The design tokens above already include all dark-mode mappings — components don't need to be re-styled.

**Dark mode principles:**

1. **Forest becomes the canvas.** Page background flips from Bone to Forest. This is intentional and distinctive — most dark modes use near-black, but ours leads with the brand color.
2. **Elevated surfaces go *lighter*, not darker.** Cards in dark mode use Forest 600 (`#2A4A3D`), which lifts them off the Forest page background. Inputs and recessed surfaces go *darker* (Forest 900, `#162B23`) — the inverted relationship from light mode.
3. **Clay shifts brighter.** From `#E89668` to `#F0A77E`. The original clay loses vibrance against forest; the lighter version holds its weight without losing its earthy character. This is the **only** color in the system that has two values across modes.
4. **Don't auto-flip the marketing site.** The application UI supports dark mode based on user preference or OS setting. Marketing pages stay in light mode regardless — the brand presents itself in light first.
5. **Test every component in both modes before shipping.** It's tempting to assume the token system handles everything, but contrast and visual weight still need a human eye.

---

## Things never to do

These are the patterns that will make a screen look "off-brand" even if every individual element is technically correct.

- **Never use pure white as a page background.** Use Bone (`--color-bg-page`). Pure white is reserved for elevated surfaces only.
- **Never use pure black for text.** Use Ink (`--color-text-body`).
- **Never use clay for body text, headings, or large surfaces.** Clay is an accent only. Long stretches of clay break the brand.
- **Never use Title Case.** Sentence case everywhere.
- **Never use font weights 600, 700, or 800.** Two weights only: 400 and 500.
- **Never use 1px borders as the default.** 0.5px is the default. 1px is for inputs and emphasis. 2px is for featured cards only.
- **Never use box-shadows on cards or buttons.** Borders separate surfaces. Shadows are for modals and dropdowns only.
- **Never use the brand connector mark as a UI divider.** It's part of the logo, not a visual element to reuse.
- **Never use stock photography of construction sites, hard hats, or blueprints.** The visual cliché of AEC software. The brand is editorial — if imagery is needed, it should be diagrams, screenshots, or original photography.
- **Never animate things "for fun".** Motion has a purpose: feedback, transition, or focus. Decorative animation is noise.
- **Never use rounded corners on `border-left` accents.** They look broken. Set `border-radius: 0` if using a single-sided border.
- **Never override design tokens locally.** If you need a color, spacing value, or radius that doesn't exist in the token system, propose adding it to the system — don't hardcode a one-off.