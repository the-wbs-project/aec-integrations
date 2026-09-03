---
name: AEC Integrations
description: Editorial directory and review platform for AEC software integrations. Light-only (AECI-226; dark reintroduction dropped, not roadmapped), Tailwind v4 + Spartan brain.
colors:
  # Light theme (the only theme in Stage 1; dark token set removed in AECI-226,
  # documented in docs/BRAND_GUIDELINES.md §3, returns at Stage 2).
  surface-base:           "oklch(100% 0 0)"
  surface-raised:         "oklch(98.43% 0 0)"
  surface-sunken:         "oklch(96.78% 0.0019 286.38)"
  border-default:         "oklch(91.97% 0.0036 286.32)"
  border-strong:          "oklch(87.20% 0.0055 286.32)"
  text-primary:           "oklch(14.48% 0 0)"
  text-secondary:         "oklch(43.86% 0.0145 285.94)"
  text-tertiary:          "oklch(55.17% 0.0138 285.94)"
  accent-primary:         "oklch(31.92% 0.0436 152.32)"
  accent-primary-hover:   "oklch(43.83% 0.0658 152.61)"
  accent-primary-soft:    "oklch(95.35% 0.0066 160.07)"
  accent-secondary:       "oklch(76.10% 0.1144 47.10)"
  accent-secondary-deep:  "oklch(51.86% 0.1245 45.13)"
  accent-warm:            "oklch(95.62% 0.0149 95.45)"
  status-error:           "oklch(50.13% 0.1783 28.70)"
typography:
  display:
    fontFamily: '"Source Serif 4", Georgia, "Times New Roman", serif'
    fontSize: "clamp(2.25rem, 4.5vw + 1rem, 4rem)"
    fontWeight: 400
    lineHeight: 1.05
    letterSpacing: "-0.01em"
  headline:
    fontFamily: '"Source Serif 4", Georgia, "Times New Roman", serif'
    fontSize: "clamp(1.75rem, 2.5vw + 0.75rem, 2.5rem)"
    fontWeight: 600
    lineHeight: 1.15
    letterSpacing: "-0.005em"
  title:
    fontFamily: '"Source Serif 4", Georgia, "Times New Roman", serif'
    fontSize: "1.5rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "normal"
  body:
    fontFamily: '"Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  label:
    fontFamily: '"Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "0.8125rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.01em"
  overline:
    fontFamily: '"Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.08em"
    textTransform: "uppercase"
  caption:
    fontFamily: '"Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
rounded:
  none: "0"
  sm: "0.25rem"
  md: "0.5rem"
  lg: "0.75rem"
  xl: "1rem"
  pill: "9999px"
spacing:
  "0": "0"
  "1": "0.25rem"
  "2": "0.5rem"
  "3": "0.75rem"
  "4": "1rem"
  "5": "1.5rem"
  "6": "2rem"
  "7": "3rem"
  "8": "4rem"
  "9": "6rem"
components:
  button-primary:
    backgroundColor: "{colors.accent-primary}"
    textColor: "{colors.surface-base}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "{spacing.3} {spacing.5}"
  button-primary-hover:
    backgroundColor: "{colors.accent-primary-hover}"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "{spacing.3} {spacing.5}"
  button-secondary-hover:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.accent-primary}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    typography: "{typography.label}"
    rounded: "{rounded.md}"
    padding: "{spacing.3} {spacing.4}"
  card:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.lg}"
    padding: "{spacing.5}"
  card-hover:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
  input:
    backgroundColor: "{colors.surface-base}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.md}"
    padding: "{spacing.3} {spacing.4}"
  input-focus:
    backgroundColor: "{colors.surface-base}"
    textColor: "{colors.text-primary}"
  badge-verified:
    backgroundColor: "{colors.accent-primary}"
    textColor: "{colors.surface-base}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "{spacing.1} {spacing.3}"
  badge-pending:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    padding: "{spacing.1} {spacing.3}"
  score-display:
    backgroundColor: "transparent"
    textColor: "{colors.accent-primary}"
    typography: "{typography.headline}"
    padding: "{spacing.0}"
  detail-layout:
    backgroundColor: "{colors.surface-base}"
    textColor: "{colors.text-primary}"
    padding: "{spacing.8} {spacing.6}"
    md_padding: "{spacing.12} {spacing.8}"
    sectionDivider: "1px solid {colors.border-default}"
  browse-layout:
    backgroundColor: "{colors.surface-base}"
    textColor: "{colors.text-primary}"
    padding: "{spacing.8} {spacing.6}"
    md_padding: "{spacing.12} {spacing.8}"
    sectionDivider: "1px solid {colors.border-default}"
---

# Design System: AEC Integrations

## 1. Overview

**Creative North Star: "The specifier's reference."**

AECi reads as an editorial industry reference — a published artifact closer in spirit to a printed product specification or a specialist trade journal than to a SaaS landing page. The reader is an AEC professional making a serious decision; the surface should feel built for that job, not built for a marketing demo. Restraint, density, generous whitespace, sentence case, and a serif headline that borrows posture from `ENR` or `Architectural Record` — never from a startup landing page.

The system rejects the AI-startup visual cohort entirely: no purple-to-blue gradients, no glassmorphism, no hero-metric template, no Inter / DM Sans / Plus Jakarta Sans / Geist / Mona Sans / Space Grotesk / IBM Plex Sans / Outfit / Fraunces / Newsreader / Playfair Display / Cormorant / DM Serif / Instrument Serif / Syne. It also rejects the horizontal-SaaS-directory cohort (G2, Capterra, GetApp): no equal-weight feature grids, no logo clouds as proof, no orange-and-cream marketplace cream. Forest, Bone, and Clay carry brand identity as accents; surfaces stay neutral and let content lead.

**Key Characteristics:**

- Editorial restraint over commercial enthusiasm. Sentence case everywhere (one named exception: the overline role, §3).
- Pair a refined serif (Source Serif 4) with an a11y-first sans (Atkinson Hyperlegible Next). The pairing itself is the brand statement.
- Forest is the anchor accent. Clay is rare (≤5% per screen, decorative/fill only — Clay deep carries meaning-bearing clay). Bone is a warm-tinted accent surface, never a page background.
- Borders separate surfaces. Shadows are reserved for modals, dropdowns, and focus rings.
- Light only: a single light theme, no toggle and no system-preference detection (AECI-226). The dark reintroduction was dropped — dark is not roadmapped (`STAGE_2_SPEC.md` §9); design once, for light.

## 2. Colors

A neutral surface palette with three brand accents (Forest, Clay, Bone) and two near-monochrome text scales. Frontmatter values are OKLCH for perceptual uniformity (and to enforce Impeccable's color doctrine); each color's documented hex equivalent is the canonical sRGB value used by `apps/web/src/styles.css` and `docs/BRAND_GUIDELINES.md`.

### Primary

- **Forest** (`#1E3A2F` / `oklch(31.92% 0.0436 152.32)`): the primary brand color. CTAs, links, headings, the connector mark, primary badges. Hover state is **Forest Hover** (`#2E5C45` / `oklch(43.83% 0.0658 152.61)`) — measurably brighter, never a synthetic opacity reduction.
- **Forest soft** (`#ECF1EE` / `oklch(95.35% 0.0066 160.07)`): the Forest *wash* — fills for selected facets, active chips, verified-soft and info states. It is how Forest registers at rest without recoloring text. A wash, not a boundary (1.14:1 against white): always paired with a border or another selected-state affordance. Forest text on it measures 10.80:1.

### Secondary

- **Clay** (`#E89668` / `oklch(76.10% 0.1144 47.10)`): warm secondary accent — **decorative and fill only**. The connector mark, badge fills (carrying `text-primary` at 8.48:1 — never white text, which is 2.33:1), accent strokes. It measures ~2.3:1 on white, below even the 3:1 large-text/non-text floor, so it can never carry text or meaning-bearing graphics — see the Clay restriction below.
- **Clay deep** (`#A14D22` / `oklch(51.86% 0.1245 45.13)`): the text-capable member of the Clay family — clay-colored text and icons. 5.83:1 on white, 5.59:1 on raised, 5.21:1 on Bone. Doubles as the warning hue.

### Rating

- **Goldenrod** (`#DAA520` / `oklch(75.16% 0.1469 83.99)`): the gold-star fill for rating glyphs (`<aec-review-stars>` and the review-form rating listboxes) — token `--accent-rating`. The conventional gold star, tuned warm to sit with the Clay/Bone family rather than a neon yellow. It measures 2.24:1 on white, *below* the 3:1 meaning-bearing-graphic floor — permitted because the star glyphs are **decorative** (`aria-hidden`): the rating is carried by the `aria-label` (and, in displays, the adjacent numeral), never by glyph color alone. In read-only displays (`<aec-review-stars>`, vendor-detail) empty stars use **Border strong** `#D4D4D8` as a faint track so the gold reads against it. The **interactive review-form picker** instead uses **Text tertiary** `#71717A` for unselected stars: it has no adjacent numeral and renders fully unselected on first load, so a faint `#D4D4D8` track would leave the whole control near-invisible until hovered. (The dedicated Goldenrod gives ratings their own recognizable color and frees Clay deep to mean "text-capable clay / warning.")

### Tertiary

- **Bone** (`#F5F2EA` / `oklch(95.62% 0.0149 95.45)`): warm-tinted *accent surface*. Hero bands on About, callout sections, marketing emphasis. **Not a page background.**

### Neutral

- **Surface base** (`#FFFFFF` / `oklch(100% 0 0)`): default page background.
- **Surface raised** (`#FAFAFA` / `oklch(98.43% 0 0)`): cards, panels.
- **Surface sunken** (`#F4F4F5` / `oklch(96.78% 0.0019 286.38)`): inset wells, code blocks, secondary states.
- **Surface muted** (`#F4F4F5` / `oklch(96.78% 0.0019 286.38)`): interactive row hover / `focus-within` highlight on index tables. Shares the surface-sunken value by design — the two never co-occur inside a row, and a hover wants the same one-step lift sunken gives on white.
- **Border default** (`#E4E4E7` / `oklch(91.97% 0.0036 286.32)`): standard separators (0.5px default, 1px emphasis).
- **Border strong** (`#D4D4D8` / `oklch(87.20% 0.0055 286.32)`): emphasized borders (focus, featured states).
- **Text primary** (`#0A0A0A` / `oklch(14.48% 0 0)`): body and headings. Near-black, not pure black — gentler against bright surfaces, lower halation.
- **Text secondary** (`#52525B` / `oklch(43.86% 0.0145 285.94)`): supporting prose, captions.
- **Text tertiary** (`#71717A` / `oklch(55.17% 0.0138 285.94)`): hints, placeholders, metadata. Re-pointed from `#A1A1AA` in AECI-230 — the old value measured 2.56:1 on white, failing even the 3:1 large-text floor. Now 4.83:1 on white, 4.63:1 on raised. **Never on sunken/muted surfaces** (4.40:1 there) — step up to text secondary.

### Status

- **Error** (`#B3261E` / `oklch(50.13% 0.1783 28.70)`): form/validation error text and icons, **and the `conflict` agreement badge** (6.54:1 on white). Always paired with an inline message or icon — color is never the sole signal. Success states use Forest; warning states use Clay deep. No additional status hues exist.
  - **The scope widened in AECI-605** from form/validation only. `conflict` — two vendors describing the same data flow differently — is the **one non-form state permitted to be red**, and the only red state in the agreement set (`STAGE_2_ATTESTATIONS_SPEC.md` §4.3). It is red because it is genuinely actionable for the reader, not because anything is broken: the copy names the disagreement ("Vendors disagree") rather than faulting either product. It carries an `✕` glyph alongside the hue so it survives greyscale and colour-vision deficiency. Do not extend Error to any further state without a spec decision — `unverified` and `single_source` are deliberately neutral, and making an unconfirmed claim look like a defect is the failure mode this system is built to avoid.

### Dark theme — dropped from the roadmap (not shipped)

The dark palette was removed from the active design system in **AECI-226**: AECi ships light only (see the "Light only" rule below). The Stage 2 dark-theme reintroduction was subsequently **dropped** (epic AECI-517 canceled; `STAGE_2_SPEC.md` §9) — dark is **not roadmapped**. The brand-approved dark Forest / Clay / Bone variants stay documented in `docs/BRAND_GUIDELINES.md` §3, and the prior OKLCH dark token set is preserved in git history, so *should* a later stage ever revisit dark it would be a token-block + toggle change — every component consumes the semantic tokens (`--surface-*`, `--text-*`, `--accent-*`), not a per-component rework — but nothing is planned.

### Named Rules

**The Surfaces-Are-Neutral Rule.** Brand colors are accents that layer on top of neutral surfaces. They are never the page background. The `<body>` is `#FFFFFF`. Bone is *not* a page background — it is a warm-tinted accent surface used in callout bands and hero sections only.

**The Forest-Anchor Rule.** Forest is the primary brand accent and the anchor of the system. Every CTA, every link, every heading color, every primary badge fill: Forest. No alternative primary color exists — proposals for "a second primary" are rejected.

**The Clay-Restriction Rule.** Clay is the rarest color in the system. ≤5% of any screen. Clay `#E89668` is **decorative and fill only**: the connector mark, accent strokes, and badge fills carrying `text-primary` (8.48:1) — never white text (2.33:1). It measures ~2.3:1 on white, which fails not just AA body text but the 3:1 floor for large text and meaning-bearing graphics — the former "large-text allowed" clause was mathematically false and was struck in AECI-230. Anything clay-colored that *carries meaning* — text, icons — uses **Clay deep** `#A14D22` (5.83:1). (Star-rating glyphs are *not* clay: they use the dedicated **Goldenrod** `--accent-rating` — see the Rating palette above.) Clay never fills a CTA: the Forest-Anchor Rule owns every CTA. Keeping Clay rare preserves its meaning as the high-emphasis accent. (The brand policy would carry forward to Dark Clay if dark is ever revisited; dark theme is not currently roadmapped — the Stage 2 reintroduction was dropped.)

**The No-Pure-Black-Or-White Rule.** `#000` and `#fff` never appear in this system. The text-primary token is `#0A0A0A` (a near-black) on a `#FFFFFF` surface base. Pure-black-on-pure-white is harsher than the near-tones and creates unnecessary halation. (The same principle would govern the dark variants documented in `BRAND_GUIDELINES.md` §3 if dark is ever revisited; it is not currently roadmapped.)

**The Anchor-Site Rule.** When a surface uses a Mobbin reference site as its theme, components for that surface come from the *same* Mobbin site. Pulling components from a second site is a deliberate exception, not a default — and the originating theme site remains the visual anchor for composition, hierarchy, density, and atmosphere. This protects editorial coherence: AECi reads as one publication, not a mashup of unrelated apps. Record the anchor site with the surface (Linear issue or commit message) so future iterations stay aligned. Access Mobbin via the `mcp__mobbin__*` MCP server — see `CLAUDE.md` §"MCP usage rules" for auth flow and the matching design-checklist step.

## 3. Typography

**Display Font:** Source Serif 4 (with Georgia, "Times New Roman", serif fallback)
**Body Font:** Atkinson Hyperlegible Next (with system-ui, -apple-system, "Segoe UI", sans-serif fallback)
**Label Font:** Atkinson Hyperlegible Next (same family as body, distinct role via size + weight)

**Character:** Source Serif 4 carries the editorial / industry-publication posture of a printed reference — calmer and more grounded than the SaaS-default sans cohort, but without the stylized affectation of the reflex-reject serifs (Fraunces, Playfair Display, Cormorant, DM Serif, Instrument Serif). Atkinson Hyperlegible Next is an a11y-first sans designed by the Braille Institute for low-vision readers; pairing it with a serif display face makes the trust/transparency principle visible in the typography itself. The pairing is the brand statement: a system that treats the reader's vision as a constraint to engineer for, not an afterthought to "support."

> **Why Next (AECI-230):** the classic Atkinson Hyperlegible ships only 400/700, so this system's 500 (chips) and 600 (labels) weights could not actually render — CSS font matching silently resolved 500 to 400. Atkinson Hyperlegible Next is the Braille Institute's expanded release (loaded as a 400–700 variable font), making every specified weight real. Same lineage, same a11y story.

### Hierarchy

- **Display** (Source Serif 4, 400, `clamp(2.25rem, 4.5vw + 1rem, 4rem)`, line-height 1.05, tracking -0.01em): hero headlines on About, Home, vendor profile mastheads. Used at most once per page.
- **Headline** (Source Serif 4, 600, `clamp(1.75rem, 2.5vw + 0.75rem, 2.5rem)`, line-height 1.15, tracking -0.005em): page H1 on content pages and product surfaces.
- **Title** (Source Serif 4, 600, 1.5rem / 24px, line-height 1.25): section H2 within long-form content; product surface card titles where editorial weight is wanted.
- **Body** (Atkinson Hyperlegible Next, 400, 1rem / 16px, line-height 1.6): default body and reading text. Cap measure at 70ch on long-form pages; product surfaces use container constraints instead. **Use 700 (Bold) only for inline emphasis or product-surface affordances** — never for headings (those are Source Serif 4).
- **Label** (Atkinson Hyperlegible Next, 600, 0.8125rem / 13px, line-height 1.4, tracking +0.01em): button text, table headers, status badges (verified / pending), form field labels. Sentence case (not uppercase — see the rule below). Moved 700 → 600 in AECI-230: with a real 600 cut available, the calmer weight is the premium read at 13px. **Navigational taxonomy chips/tags use the same family and size at medium (500), not 600** — they are content links, not button affordances (see §5 → Tags / taxonomy chips).
- **Overline** (Atkinson Hyperlegible Next, 600, 0.75rem / 12px, line-height 1.4, tracking +0.08em, **uppercase**): eyebrows, kickers, and sidebar microheadings ("Vendor", "Categories", "Filters", "At a glance") — the print-kicker role and the *only* sanctioned uppercase in the system (see the Sentence-Case Rule). Shipped as the `.aec-overline` class in `styles.css`; apply it on whatever element carries the right semantics (often `h2`/`h3` — the class beats the global heading serif rule, which is the point). Default color text secondary; Forest for emphasis.
- **Caption** (Atkinson Hyperlegible Next, 400, 0.875rem / 14px, line-height 1.5): metadata, hints, timestamps, helper text. Maps to `text-sm` + text secondary; defined as a role so components stop improvising this size.

### Named Rules

**The Sentence-Case Rule.** Headings, buttons, labels, navigation, table headers, page titles, section titles — all sentence case. Title Case reads as marketing copy; sentence case reads as editorial copy. This rule has exactly **one named exception: the overline role** (above) — uppercase via CSS `text-transform`, never in source strings. Eyebrows, kickers, and sidebar microheadings are overlines; *nothing else* is uppercase. Table headers and breadcrumbs are explicitly **not** overlines — they are sentence case (the uppercase table-header treatment that contradicted this rule was struck in AECI-230).

**The Serif-Floor Rule.** Source Serif 4 never renders below 1.125rem / 18px. Anything smaller is by definition a label, overline, or caption — Atkinson territory. (The global `h1,h2,h3` serif rule in `styles.css` makes small serif easy to leak; the `.aec-overline` class on small headings is the standing fix — AECI-230.)

**The Unlayered-Heading Rule.** The `h1, h2, h3` block in `styles.css` (family, weight, **and size**) sits **outside any `@layer`**, and unlayered declarations beat every layered one regardless of specificity. Tailwind v4 ships its utilities in `@layer utilities`, so **a `text-*` utility written directly on an `h1`/`h2`/`h3` is silently dead** — the element keeps the global size (h1 `clamp(1.75rem…2.5rem)`, h2 1.5rem, h3 1.25rem) and the author's intent never renders. Two consequences:

- **To size a heading, put the `text-*` utility on an inner `<span>`**, not on the heading element. The span inherits the display face from the heading and takes its own size. (`product-powered-hub.ts` does this for its card titles.)
- **Don't "fix" it by moving the block into `@layer base` without an audit.** Doing so silently resizes every heading that currently carries a losing `text-*` utility — at the time of writing that is ~9 surfaces, including all three `/search` hit cards (`text-base` → would drop 1.25rem → 1rem, which the Serif-Floor Rule then forbids), `browse-grid`, `products-pair` mechanism titles, `home-how-it-works`, `admin-shell`, and both taxonomy `h1`s. The block being unlayered is a bug, but unwinding it is its own scoped piece of work with per-surface decisions, not a drive-by.

**The Two-Family Rule.** Source Serif 4 for display, headline, title. Atkinson Hyperlegible Next for body, label, overline, and caption. No third typeface enters the system. Monospace appears only when rendering literal code (in `<code>` and `<pre>`) and uses the system monospace stack — it is not a brand face.

**The Reflex-Reject Rule.** This system explicitly does not use, and will reject any proposal to introduce: Inter, DM Sans, Plus Jakarta Sans, Geist, Mona Sans, Space Grotesk, IBM Plex Sans, Outfit, Roboto, Open Sans, Arial, Fraunces, Newsreader, Lora, Crimson, Crimson Pro, Crimson Text, Playfair Display, Cormorant, Cormorant Garamond, DM Serif Display, DM Serif Text, Instrument Sans, Instrument Serif, Syne. The chosen pair (Source Serif 4 + Atkinson Hyperlegible) is the answer; the reflex list is the question that has already been refused.

## 4. Elevation

Borders separate surfaces. Shadows do not.

The system is flat by default. Depth is conveyed through color (Bone callouts, sunken inset wells), spacing (generous whitespace around elevated content), and border weight — not through drop shadows on cards or buttons. Box-shadows appear only where a literal layer is rising off the page: modals, dropdowns, popover menus, and focus rings.

### Shadow Vocabulary

- **Modal / Dialog** (`box-shadow: 0 16px 48px -8px rgb(0 0 0 / 0.18), 0 4px 16px -2px rgb(0 0 0 / 0.10)`): for overlay surfaces (dialogs, command palettes). Pairs with a 50% opacity backdrop.
- **Dropdown / Popover** (`box-shadow: 0 8px 24px -4px rgb(0 0 0 / 0.12), 0 2px 8px -1px rgb(0 0 0 / 0.06)`): for menu panes, autocomplete dropdowns, tooltips with body content.
- **Focus ring** (`box-shadow: 0 0 0 2px var(--surface-base), 0 0 0 4px var(--accent-primary)`): keyboard-focus indicator. Always paired with a visible focus state — never `outline: none` without a replacement.

### Named Rules

**The Borders-Not-Shadows Rule.** Cards, buttons, badges, inputs, and tabs use borders to separate from their surface (0.5px default, 1px emphasis, 2px featured). Box-shadows on these elements are forbidden — they are an AI-design tell ("rounded rectangle with generic drop shadow") and do not match the editorial posture of the system.

## 5. Components

Components are bound to tokens via the front-matter `{...}` references. Concrete behavior, states, and Spartan brain primitive bindings below.

> **Behavior providers (ADR 0010, Accepted).** Component _behavior_ here is headless. **Spartan brain** (ADR 0005) covers the overlay primitives — buttons, popovers, dialogs. **Angular Aria** (`@angular/aria`, stable in v22) is the provider for _new_ interactive and form-control patterns: select, combobox, listbox, radio, accordion, tree, grid, menu, toolbar, tabs. Both bind to the tokens below identically, via Tailwind **`aria-*:` variant utilities** (`aria-selected:`, `aria-expanded:`, `aria-checked:`) plus the **`data-[active=true]:`** variant Aria sets on the active option — token-bound, no TS state mirror. (Two adopter-facing deviations: Aria@22 ships no `radio`/`select`, so listbox/combobox stand in; and discrete-choice Aria controls bridge into Signal Forms via `[(value)]`+`(valueChange)`, not `[formField]` — a styling-invisible detail, but see the ADR.) The behavior provider is invisible to the visual system — the **Anchor-Site Rule** governs composition, hierarchy, density, and atmosphere, not which library supplies keyboard/ARIA logic, so two providers is not a mashup. See `docs/adr/0010-angular-aria-alongside-spartan.md`.

### Buttons

Spartan `BrnButton` directive provides the headless behavior; Tailwind utility classes bind to tokens.

- **Shape:** `rounded.md` (8px). Never pill-shaped (`rounded.pill`) for primary actions — pill buttons read as social-media UI, not editorial.
- **Primary** (`button-primary` / `button-primary-hover`): Forest fill (`accent-primary`), surface-base text. Padding `spacing.3 spacing.5` (12px / 24px). Sentence-case label using the `label` typography role. Hover: brightens to `accent-primary-hover`. No transform, no scale, no shadow on hover.
- **Secondary** (`button-secondary` / `button-secondary-hover`): surface-raised fill, text-primary text, 0.5px border-default. Hover: surface sinks to `surface-sunken` and text shifts to `accent-primary`.
- **Ghost** (`button-ghost`): transparent fill, text-primary text, no border. Hover: text shifts to `accent-primary`. Used for tertiary actions in dense product surfaces.
- **States:** `:focus-visible` shows the focus-ring elevation token. `:disabled` reduces opacity to 0.6 and disables pointer events — does not change color (color shifts on disable look broken).

### Cards

Used for vendor profiles, integration cards, the `/search` result tiles (see Search & discovery below — they are the canonical instantiation of this primitive), and content modules. Distinct from the **Entity cards (index rows)** below, which despite the shared "card" name render as `<tr>` table rows and do _not_ use this primitive.

- **Corner Style:** `rounded.lg` (12px).
- **Background:** `surface-raised`.
- **Shadow Strategy:** **None.** Borders separate surfaces. (See the Borders-Not-Shadows Rule above.)
- **Border:** 0.5px solid `border-default`. Hover (when interactive) raises to 1px solid `border-strong` — no fill change, no shadow, no scale.
- **Internal Padding:** `spacing.5` (24px). Dense list contexts may use `spacing.4` (16px).

### Entity cards (index rows)

Listing rows render through `ProductCard` (Phase 2 Spec §11.2, `apps/web/src/app/products/product-card.ts`). Despite the "card" name it renders as a **table row**: it uses an attribute selector on `<tr>` (`tr[aec-product-card]`) so the rendered DOM stays a valid `<tbody>` child — a custom element placed directly inside `<tbody>` is foster-parented out by the HTML tree builder (the same pattern Angular CDK uses for `tr[cdk-row]`). AECI-190 split the products catalog into two views: this `<tr>` component is the **table view** (shared by the `/products` table and the taxonomy browse-page tables), while a separate `ProductCardGrid` (below) is the **card-grid view** and the default for `/products`.

> **Formerly three.** §11.2 also specified `VendorCard` (`tr[aec-vendor-card]`) and `IntegrationCard` (`tr[aec-integration-card]`), the row primitives of the `/vendors` and `/integrations` index pages. AECI-165 removed both index pages (orphaned from the nav after AECI-160; the URLs now 301 to `/products`), leaving the two components with no consumer. They were deleted in AECI-657 along with `IndexLayout`. `/vendors/:slug` detail pages are unaffected — they never used `VendorCard`.

Row behavior:

- **Host:** `text-primary`; `hover` and `focus-within` raise the row fill to `surface-muted`. No shadow, no scale.
- **Cells:** `spacing.4` horizontal / `spacing.3` vertical padding. Numeric cells (counts, founded year) are `text-end` and `tabular-nums`. Linked cells shift to `accent-primary` on hover with a `focus-visible` ring.
- **Empty states:** a missing optional field renders an en-dash (`–`) in `text-tertiary` carrying an i18n-wrapped `aria-label` (`@@{entity}.card.{field}.none`) — never a bare blank, and color is never the sole signal.

Cell content:

- **ProductCard** (`tr[aec-product-card]`) — a monogram (`LogoOrInitial`, 32px) beside the name (→ `/products/:slug`), vendor (→ `/vendors/:slug`; nullable per AECI-115), primary category as a `TaxonomyBadge` chip (→ `/categories/:slug`), the overall rating as a `RatingSummary` (`variant="cell"` — gold star + average + review count, or an en-dash below the §5.5 ≥5-review gate; `hidden md:table-cell` so it collapses with the vendor column on mobile, where the card-grid view carries the rating), and the integration count as an `IntegrationStat` (graceful "Not yet connected" at zero). AECI-190 folded this richer treatment in so the `/products` table view and the taxonomy browse-page tables share one row.

### Search & discovery (Phase 3)

The Phase 3 search surface (`/search`, the listing-page filters, and the header autocomplete) adds one page shell and several small headless-behavior components. Search itself runs **browser-side against Algolia** with the search-only key (Spec §7.5) — the admin key is never shipped (see the CSP / key handling note in §6). Every component renders correctly via tokens and i18n-wraps (or is passed) every visible string. Components live in `apps/web/src/app/search/` (search experience) and `apps/web/src/app/shared/facets/` (listing-page filters).

- **Search page shell** (`<app-search-page>`, `search/search-page.ts`) — the `/search` experience: a `role="search"` query box (seeded from `?q=`), the **entity tablist**, a `md:` two-column body (`16rem` facet rail / results grid), and an empty state. Uses `surface-base` / `text-primary`; the query input follows the **Inputs / Fields** style. Unlike the other shells this page is **non-cacheable** (`private, no-store` — it is deliberately absent from `ROUTE_CACHE_PATTERNS`) and **`noindex`** (`MetaService.setSearchMeta`, §4.6 — search results aren't canonical content). **Graceful degradation:** when the public Algolia config is absent (local dev / an unprovisioned env / CI) the shell renders a `role="status"` "temporarily unavailable" notice and never constructs the controller — this is also the path the bound e2e exercises. Search/connector logic lives in `search-controller.ts` (the `instantsearch.js` + connectors → signals deviation, ADR 0014); the shell only binds the resulting signals.

- **Entity tabs** — the products / vendors / integrations switcher (`role="tablist"` with `role="tab"` / `role="tabpanel"`), implementing the APG tabs pattern: roving `tabindex` (active = 0), `aria-selected` / `aria-controls` / `aria-labelledby`, and ←/→/Home/End key handling that moves and activates. Active tab carries a 2px `accent-primary` bottom border (the **Navigation** active-route treatment); inactive tabs are `text-secondary` with a transparent border. Per-tab hit counts render as `tabular-nums` `text-secondary`. Switching tabs is pure show/hide of already-materialized signal slices — it never re-queries.

- **Search hit cards** (`<aec-search-product-card>` / `<aec-search-vendor-card>` / `<aec-search-integration-card>`) — grid hit tiles for the `/search` results, the **canonical instantiation of the Cards primitive** (`rounded.lg`, `surface-raised`, 0.5px `border-default` → 1px `border-strong` on hover, `spacing.5` padding, no shadow). Distinct from the **Entity cards (index rows)** above: those are `<tr>` table rows for the index/browse pages; these are `<article>` tiles bound to the **denormalized Algolia record** (Spec §7.1) — every display field is on the hit, so there is no follow-up fetch. Each tile uses the **stretched-link pattern** (the entity name is the single link, `::after` overlaying the whole tile) so the tile is one click target with one accessible name; supporting fields (vendor, headquarters, counts, taxonomy chips, mechanism/direction) render as non-link text/badges. Nullable fields mirror the index cards' em-dash empty-state convention. The integration tile reuses the shared `mechanism-labels` so badges match the `/integrations` table exactly, and is empty until integration seeding returns (AECI-86).

- **In-page facet widgets** (`search/widgets/`) — four generic, **i18n-free chrome** widgets bound to InstantSearch connector render-state slices; the page passes each one its localized heading and the localized labels for any boolean/"all" values (facet _values_ are data and render verbatim). Each names its group with `<fieldset>` + `<legend>` and wraps every control in its `<label>`, and renders nothing when its slice is empty (keeps the rail clean for an empty index):
  - **`<aec-search-refinement-list>`** — checkbox group (multi-select) over string facets (`accent-(--accent-primary)` checkboxes).
  - **`<aec-search-numeric-menu>`** — radio group over count buckets (`0 / 1–10 / 11–50 / 51+`, §7.2); radios share a page-supplied tab-unique `name` so two same-attribute menus never collapse into one group.
  - **`<aec-search-range-input>`** — a min/max number-input pair (vendor `founded_year`); index-wide bounds become placeholders + native `min`/`max`; each field has an sr-only `<label>`.
  - **`<aec-search-paginator>`** — minimal prev/next + "Page X of Y" (`tabular-nums`); `<nav aria-label>`, disabled at the ends, renders nothing for a single page. (Distinct from the 1-based `/products` table `Paginator`; InstantSearch pagination is page-count based.)

- **Listing-page facet sidebar** (`<aec-facet-sidebar>`, `shared/facets/facet-sidebar.ts`, AECI-143) — the filter rail for `/products` and the taxonomy browse pages (fills the `BrowseLayout` `filters` slot). Deliberately **NOT Algolia-backed**: it reads scoped counts from `GET /api/products/facets` via `httpResource` (captured in the SSR transfer cache), so the host pages **stay edge-cacheable** — their cache key includes `category_id` / `audience_id` / `phase_id` via `LISTING_CACHE_KEY_PARAMS`. **Single-select per dimension** (the API takes one `{kind}_id` per dimension): clicking the active term clears it, another replaces it, `page` resets to 1. Browse pages pass `lockedKind` + `lockedId` to scope to (and hide) their own taxonomy. Renders its term lists through the shared `<aec-search-refinement-list>` widget, plus a "Clear filters" link when any filter is active.

- **Header search autocomplete** (`<aec-search-autocomplete>`, `search/search-autocomplete.ts`, AECI-144) — the search-as-you-type field in the site header (the home hero reuses it in Phase 4). This is the project's **first Angular Aria combobox** adoption (ADR 0010): `ngCombobox` + `ngListbox`/`ngOption` supply the `role=combobox/listbox/option` semantics, `aria-expanded`/`aria-controls`/`aria-activedescendant`, the Arrow/Home/End/Escape model, and the CDK-Overlay-positioned popup; we supply only token CSS (`data-[active=true]:` highlight on `surface-sunken`, popup on `surface-raised` with `border-default`). A real `<label for>` names the input (never placeholder-as-label). It **SSR-renders only the static `<form>`/`<label>`/`<input>`** (visitor-state-neutral, so it is safe inside the cached header) and is hydration-enhanced; when the Algolia config is absent it stays a plain submit-to-`/search` field with no error UI (correct for a header control). The listbox is rendered **only when there is ≥1 hit**, so a zero-hit query shows no empty floating panel (keeps it `role=option`-only and axe-clean); Enter with no selection routes to `/search?q=`, which owns the "no results" empty state.

- **Per-tab sort dropdown** (`<aec-search-sort-by>`, `search/widgets/search-sort-by.ts`, AECI-175 / ADR 0014) — the sort control above the `/search` results (Relevance · Most integrations · Name A–Z, per the Products/Vendors tab). A **non-editable Angular Aria combobox + listbox-in-overlay**, the same discrete-choice pattern as the review-form role picker (ADR 0010): `ngCombobox` + `[(expanded)]` trigger, with a `cdkConnectedOverlay` (`usePopover:'inline'`) supplying the floating layer since `ComboboxPopup` renders in-flow. A real label names the trigger (`aria-labelledby`), the active sort shows in the trigger with a ✓ on the chosen option, and labels are `$localize`d. Backed by Algolia **replica indexes** (`SEARCH_RANKING.md` §5a); the active sort mirrors to `?sort=`. It mounts browser-side once results load (it reads the controller's sort options), so the degraded/SSR shell shows no sort control.
### Product card grid (AECI-190)

`ProductCardGrid` (`aec-product-card-grid`, `apps/web/src/app/products/`) is the **default view** of every product listing — `/products` and, since AECI-657, the four taxonomy browse pages — a buyer-facing catalog grid (anchor site: Faire). The table view above stays available on both via the toolbar toggle (`?view=table`). This is the card-grid variant the note above anticipated.

**Listing toolbar** (`<aec-listing-toolbar>`, `apps/web/src/app/shared/listing-toolbar/`) — the control strip above every product listing: a sort `<select>` on the start edge, a cards/table segmented toggle on the end edge. Extracted from the `/products` template by AECI-657, which is when the taxonomy browse pages got one; before that they had no sort control at all, against `STAGE_1_SPEC.md` §4.5. Presentation-only — the host owns `?sort=` / `?view=` in the URL (both fork the edge cache key), and the shared `productSortOptions()` supplies the option set to both surfaces so they cannot drift. The toggle buttons carry `aria-pressed`; the `<label>` is associated to the select by a per-instance id.

  Note this is a **native `<select>`**, while `/search` uses an Angular Aria combobox (`<aec-search-sort-by>`, below). That is deliberate, not drift: the search control's options are built browser-side from the loaded Algolia controller, whereas these are static and SSR-rendered, so a native select keeps sorting operable with no JS.

- **Layout:** responsive `grid` — 1 / 2 / 3 columns (`sm:grid-cols-2 lg:grid-cols-3`). The grid is deliberately *broken* (per the anti-reference against identical SaaS grids): the lead product gets a wide featured card spanning two columns on a warm **Bone** (`accent-warm`) band. The host enables the lead only on page 1 at the newest sort, so its "Recently added" eyebrow stays truthful; otherwise the grid is uniform.
- **Tile:** one whole-card `<a>` to `/products/:slug`, so category / role render as **non-link** chips (`CategoryChip` / `RoleBadge`, never the `<a>`-based `TaxonomyBadge` — nested anchors are invalid + an axe failure). Monogram (`LogoOrInitial`), name (Source Serif), vendor, the overall rating as a `RatingSummary` (`variant="inline"` — the line is **omitted entirely** below the §5.5 gate, so the card reflows with no orphaned label; `RatingSummary` is non-link, safe inside the whole-card anchor), and the integration count as an `IntegrationStat` badge. Borders not shadows; hover raises `border-default` → `border-strong`.

### Integration stat

`IntegrationStat` (`aec-integration-stat`) renders a product's `integration_count` as a deliberate metric — the directory's whole thesis is "which tools connect to what" — in three weights: `inline` (number over noun; table cells + grid), `badge` (a bordered pill with a Lucide "link" glyph), `headline` (a large Forest figure on the featured card). At zero it renders "Not yet connected" in `text-secondary`, never a bare `0`; it pluralizes the noun (1 → "integration"). The glyph is `aria-hidden` — the number + noun carry the meaning.

### Role + category chips

Two non-link chips for the card grid, sharing the Tags / Taxonomy-chip surface (bordered, `rounded.sm`, `text-secondary`):

- **RoleBadge** (`aec-role-badge`) — the product's `product_role`, shown **only** for `connector` / `hybrid`; the default `application` renders nothing, so the chip earns attention by appearing selectively.
- **CategoryChip** (`aec-category-chip`) — the primary category as plain styled text (not a link), for contexts where the whole card is already a link.

### Home (Phase 4)

The home page (`/`, `apps/web/src/app/home/`) assembles the §4.1 surface from new home-only components plus reused catalog vocabulary. Anchor site: **Faire** (recorded in `docs/design/home-direction.md`, AECI-181) — the home reuses the AECI-190 `ProductCardGrid` / `IntegrationStat` so the front door and the catalog read as **one publication**, not a mashup (the Anchor-Site Rule). Every component renders correctly via tokens and i18n-wraps every visible string. Stats data is SSR-resolved from `GET /api/stats/home` (`home-stats.resolver.ts`); the "Browse by" counts come from the **live** `GET /api/taxonomy` (`home-browse.resolver.ts`), never the stats_cache.

- **Home hero** (`<aec-home-hero>`, `home/home-hero.ts`) — a warm **Bone** (`accent-warm`) band with a 1px bottom border (the §"Surfaces-Are-Neutral" accent-band treatment, not a page background): an i18n eyebrow, a **Display**-face (Source Serif) tagline used at most once on the page, a lede, then the **reused header search autocomplete** (`<aec-search-autocomplete>`, AECI-144) mounted as the hero search field, and a browser-only "popular" quick-links row sourced from the `TaxonomyNavStore` (progressive enhancement — absent from the SSR/no-JS base, so it never poisons the cached shell).

- **Home stats cards** (`<aec-home-stats-cards>`, `home/home-stats-cards.ts`) — the three §4.1 cards as bordered surfaces (deliberately **not** the rejected hero-metric template): (1) **Total integrations indexed** — the count as a large Forest (`accent-primary`) figure with the **"+X in the last 30 days"** subtitle below it (i18n `@@home.stats.total.delta`, rendered only when the 30-day delta > 0); (2) **Most integrated product** — a whole-card link to `/products/:slug` with the count as an `IntegrationStat` headline; (3) **Most active category** — a whole-card link to `/categories/:slug`. Each card carries a first-class empty state (e.g. "No integrations indexed yet") so the sparse pre-launch `stats_cache` payload renders cleanly rather than as bare zeros.

- **Browse grid** (`<app-browse-grid>`, `home/browse-grid.ts`) — one reusable count-chip grid rendered three times (category / audience / phase). It reads the **live taxonomy** `product_count` (passed down from `home-browse.resolver.ts` → `GET /api/taxonomy`), **not** the stats_cache, so the "Browse by" counts match the listing pages exactly. Each variant i18n-wraps its heading, its "view all" link, and its empty state.

- **Recently added integrations** (`<aec-recent-integrations-section>` + `<aec-integration-tile>`, `home/recent-integrations-section.ts` + `home/integration-tile.ts`) — the last 10 integrations as a 2-up grid of **integration tiles** (source → target monograms + names + a mechanism chip; whole-tile link to `/integrations/:id`, reusing the shared `mechanism-labels` so badges match the `/integrations` table). A bordered, i18n'd empty state covers the pre-seed state (integrations stay empty until AECI-86 seeding returns).

- **Trending products this week** (`<aec-trending-products-section>`, `home/trending-products-section.ts`) — the top 5 products by 7-day `page_views`, rendered through the reused **`ProductCardGrid`** (Faire vocabulary). When trending is empty it **falls back to recently-added products** (the heading swaps, both i18n'd); when both are empty it shows a bordered empty state — keeping the §4.1 "trending" slot honest while `page_views` is still sparse at pre-launch.

### Auth & Reviews (Phase 5)

Phase 5 adds the authenticated surfaces — sign-in, review submission + display, account, and the admin moderation queue (`apps/web/src/app/{auth,reviews,account,admin}/`, plus the reviews section on the product page). They were built through the v0 → Angular workflow and reuse the established catalog token + type vocabulary so the signed-in experience reads as the **same publication** as the public directory (the Anchor-Site Rule). Every component is token-only (zero hardcoded color), i18n-wraps every visible string, and ships **light-only** (AECI-226 — no `dark:` variants). New form controls follow **ADR 0009** (Signal Forms) and the **Angular Aria** ADR (0010, Accepted — overlay primitives stay Spartan); the cacheable product page stays visitor-state-neutral (see the cache-neutrality constraint in CLAUDE.md).

- **Login** (`<aec-login-page>`, `auth/login.ts`) — the `/auth/login` page: a magic-link email field (a real `<label for>`, never placeholder-as-label) and a Google OAuth button, driven by Signal Forms with a validated `return` path. Non-cacheable, `noindex`. Degrades gracefully when Supabase is unconfigured (the field still renders; no console error).

- **Review form** (`<aec-review-form>`, `reviews/review-form.ts`) — the `/products/:slug/review` submission form and the project's **first Angular Aria form** (satisfies AECI-133). The two 1–5 **star-rating controls** (overall + onboarding) are horizontal Aria **listboxes** (`role=listbox`/`option`, roving tabindex, `aria-selected` highlight); role-at-company is a non-editable Aria **combobox**; optional fields (years-using, would-recommend) are held as signals and merged at submit. Signal Forms own validation (`SubmitReviewSchema` from `@aeci/shared`); a confirmation replaces the form on success, errors are retryable inline. The headline (5–100) and body (50 min) length floors are stated in persistent help text under each control per the §5 → Inputs named rule, not held back until the error fires.

- **Star display** (`<aec-review-stars>`, `reviews/review-stars.ts`) — the **read-only** rating display used by the summary averages (decimals, e.g. 4.3) and per-review rows. Glyphs are decorative (`aria-hidden`); the precise value is announced via `aria-label`, so shape/color is never the sole signal.

- **Rating summary** (`<aec-rating-summary>`, `reviews/rating-summary.ts`) — the **compact, editorial** rating for product **cards and table rows** (the list-surface counterpart to the five-star `ReviewStars`, which stays on the detail page). Deliberately numeral-forward — a single gold star (`--accent-rating`, `aria-hidden`), the average (Source Serif, `tabular-nums`), and a review-count caption — so a catalog reads like a publication, not a G2/Capterra ratings wall (a PRODUCT.md anti-reference). It **owns the §5.5 visibility gate** (`RATING_VISIBILITY_MIN_REVIEWS`) so it behaves identically bound to a `ProductListItem` or a denormalized `AlgoliaProductRecord`: shown only at ≥5 reviews and a non-null average. Two variants for the two empty-state needs — `inline` (grid + search cards) renders **nothing** when gated and collapses the host to `display:none` so it leaves no flex/gap; `cell` (dense table) renders the `–` en-dash empty state (the same convention as the vendor / category cells). The value is announced once via `role="img"` + `aria-label`, never by glyph color alone. Closes the 2026-06-12 trust-audit P0 ("zero social-proof on cards"); the existing "Highest rated" / "Most reviewed" sorts now have a visible counterpart.

- **Product reviews section** (`<aec-product-reviews>`, `products/product-reviews.ts`) — the reviews block on the product detail page. Enforces the **≥5 summary gate** (§5.5): `reviewCount === 0` → a "Be the first to review" empty state; `0 < count < 5` → the list + an overline threshold note, no averages; `count ≥ 5` → the list + the bordered averages summary. "Load more" paginates client-side. Section labels use the AECI-230 **overline** role (`aec-overline`).

- **Review CTA** (`<aec-review-cta>`, `reviews/review-cta.ts`) — the **cache-neutral** call-to-action embedded in the (cacheable) product page. SSR / pre-hydration renders a neutral "Write a review"; **client-side hydration** (`afterNextRender`) reconciles to `anon` ("Sign in to review" → `/auth/login?return=…`) or `authed` ("Submit a review"), so the cached HTML never carries session state.

- **Account** (`<aec-account-page>`, `account/account.ts`) — the `/account` page (non-cacheable): a read-only email, an editable display name (Signal Forms `PATCH`), sign-out, and a **delete-account** flow gated behind a Spartan dialog confirmation that calls the GDPR `DELETE /api/account` (anonymizes the user's reviews).

- **Admin shell** (`<aec-admin-shell>`, `admin/admin-shell.ts`) — the `/admin` layout + role gate. A non-admin resolver result renders the global 404 surface (the admin area is never *revealed* to non-admins); an admin sees the header, nav, and a **live pending-review badge** seeded from `GET /api/admin/summary` and decremented in-place by the queue via `AdminSummaryStore` (no round-trip).

- **Moderation queue** (`<aec-review-queue>`, `admin/reviews/review-queue.ts`) — the `/admin/reviews` child route. Lists pending reviews with product, reviewer email, queue age, body, and toxicity score; **client-side sortable** (default: toxicity high→low, nulls last — worst content first). One-click **approve**; **reject** opens a Signal-Forms reason field (required, Aria textbox). On success the row leaves, a live region announces it, and the shell badge ticks down. A toxicity score ≥ 70 gets a warning highlight — flag, never auto-block.

### Requests & Moderation (Phase 6)

Phase 6 extends the admin area with **vendor-request moderation** (`/admin/requests`) and **reviewer ban management** (`/admin/reviewers`) (`apps/web/src/app/admin/{requests,reviewers}/`), plus the repeat-offender → ban flow grafted onto the Phase 5 moderation queue. Both new pages are children of the existing `<aec-admin-shell>` (same role gate + live badge), reuse the established catalog token + type vocabulary so the moderation surfaces read as the **same publication** as the public directory (the Anchor-Site Rule), are token-only (zero hardcoded color), i18n-wrap every visible string, and ship **light-only** (AECI-226 — no `dark:` variants). Spartan stays for the one overlay primitive (the ban dialog).

- **Public request form** (`<aec-request-form-body>`, `requests/request-form-body.html`) — the shared body behind both the routed `/{products,vendors}/:slug/{claim,correction}` page and the in-place `RequestDrawer`. One Signal Forms model; the active `kind` picks the shared Zod schema (`ClaimFormSchema` / `CorrectionFormSchema`). Both free-text bodies carry a **20-character floor**, so both state it in persistent help text under the textarea along with what to actually write — the claim's "Anything we should know?" reads as an optional afterthought otherwise, and its `body` column is NOT NULL (see the §5 → Inputs named rule).

- **Request queue** (`<aec-request-queue>`, `admin/requests/request-queue.ts`) — the `/admin/requests` child route. Lists vendor **claims** and **corrections** as cards with kind + status badges, the linked target product/vendor, submitter, and submitted-age. Two **client-side filters** (kind: all / claims / corrections; status: open / resolved / rejected) are `aria-pressed` toggle-button groups. Each row surfaces the two **informational signals** computed at submit — a **possible-duplicate** flag (an open sibling request for the same target) and the **domain-match** status (submitter-email domain vs. vendor domain) — neither auto-decides; the admin resolves every request by hand. The linked **Linear issue** opens out. **Resolve** is one-click; **reject** opens an optional reason field. On success the row leaves and a `role=status` live region announces it; a capped-note shows when the server holds more rows than the page loaded.

- **Reviewer bans** (`<aec-reviewer-bans>`, `admin/reviewers/reviewer-bans.ts`) — the `/admin/reviewers` child route: the list of **currently-banned** reviewers (newest ban first) and the home for **unbanning** (`PATCH /api/admin/reviewers/:id` `{action:'unban'}`; the in-flight row's button disables, a live region announces the result, an already-unbanned row degrades gracefully). The ban *action* itself is raised from the moderation queue's repeat-offender flow (below), not here.

- **Repeat-offender prompt + ban dialog** (in `<aec-review-queue>`, `admin/reviews/review-queue.ts`) — when an admin rejects a review and that pushes the reviewer past the rejection threshold, the `PATCH /api/admin/reviews/:id` response carries a `repeat_offender` payload that raises a dismissible prompt. Confirming opens a **Spartan ban dialog** (`BrnDialog`) with a required reason; the dialog is driven **imperatively** from the event handler (`openBan()`), never from an `effect()` (a `BrnDialog.open()` inside an effect throws NG0602). Banning calls `PATCH /api/admin/reviewers/:id` `{action:'ban', reason}`.

### Operator console (Phase 8.3)

Phase 8.3 (`docs/ADMIN_PANEL_SPEC.md`, epic AECI-572) turns the moderation area into the **operator console**: `<aec-admin-shell>`'s `h1` becomes "Admin", its nav groups into **Insights / Catalog / Operations**, and `/admin` opens on the Overview. **No new Mobbin anchor was picked, deliberately** (spec §9.10): the console inherits the Phase 5/6 admin queues' visual language and the home stats cards' card vocabulary — bordered `--surface-raised`, border not shadow, Forest figures, `tabular-nums`, Bone/Clay-deep for anything cautionary. One publication, one voice (Anchor-Site Rule). Token-only, i18n throughout, light-only.

- **Overview** (`<aec-admin-overview>`, `admin/overview/`) — the `/admin/overview` child route and the 05:00 analytics digest as a live page. Four `<aec-stat-tile>`s plus a catalog-totals card, a 30-day human-vs-bot chart, ranked top-sources / top-products lists, and a five-item status strip. A **Recompute** button re-reads the bundle with `?recompute=1` to fill the two network-dependent status items, announcing via a polite live region.

- **Resolution honesty is a visual rule here, not just a data one.** Every tile's caption states the window it covers, and the unique-visitors definition renders *next to the number* rather than in a tooltip. The response's caveats render through `<aec-admin-notes>` — a Note/Caveat chip plus localized prose keyed off the API's machine-readable `code`, placed above every figure it qualifies. Unmeasured values read "Not measured", never `0`.

- **Charts are hand-rolled SVG** (`admin/charts/`, spec §8 / §13 D3): `<aec-sparkline>` and `<aec-stacked-bar-chart>`, geometry from pure functions so they are SSR-safe, sized by `viewBox` rather than measurement, series in Forest and Clay-deep (distinct in hue **and** lightness). A chart is never the only representation of a number: the stacked bar carries a visible legend and a visually-hidden `<table>` of the full series, and a sparkline only ever accompanies a figure already rendered as text. An empty series renders nothing rather than a flat line implying a measured zero.

- **Operator lists are tables, not cards** (AECI-694). The rule is the shape of the data, not the surface: when every field is short and every row has the same fields, the operator is comparing a column down the page and a card makes them read a paragraph per row. `/admin/vendors` and `/admin/users` were cards and are now tables; the moderation queues stay cards because a review's body is long free text. The console's table markup is one pattern, first written in `admin/system/system-status.html`: `overflow-x-auto` wrapper, `min-w-[…]` on the table, a visually-hidden `<caption>` naming it, `th[scope=col]` in the head, `th[scope=row]` on each row's identity cell, `text-end tabular-nums` on counts, and the Entity-cards en-dash-with-`aria-label` for a genuinely absent value. **Table headers are sentence case**, per the Sentence-Case Rule, which explicitly strikes the overline treatment for them.

- **A sortable header states the sort; it does not toggle one.** `<th aec-sort-header>` (`shared/sort-header/sort-header.ts`) renders a button plus a static ↑ or ↓ and sets `aria-sort` to the direction the SERVER uses for that key. It does not flip between ascending and descending, because none of the list endpoints takes an `order` parameter — direction is fixed per key in `apps/api/src/lib/sort.ts`. Building a toggle affordance over a one-way API would be a lie the first time someone clicked it twice. The corollary matters more: **a column the API cannot order by gets no control at all**, and stays plain `<th>` text with no hover state. A header that looks clickable and reorders the 25 rows on the current page presents a page as a ranking, which is worse than no control. (`/admin/users` Last sign-in is the standing example: it comes from GoTrue per id, *after* the ORDER BY has already chosen the page.)

- **Relative time is for ledgers, and it always carries the exact instant** (AECI-694). `<aec-relative-time>` (`shared/relative-time/`) renders a compact span ("4h", "2d") beside an info control **whose accessible name IS the full `medium`/UTC datetime** — not an `aria-describedby` pointing at the panel, so a screen-reader or keyboard user never depends on a transient overlay to learn when something happened. Sighted users get the panel on hover, focus or click. It is used **only** in the audit trail, where "how long ago" is the question being asked; every other timestamp in the console is absolute `medium`/UTC, because "Profile created" is a date, not a staleness signal. Two implementation notes worth keeping: the panel is a `cdkConnectedOverlay` rather than the cheap CSS tooltip (`home/home-why.ts`) because every table it appears in sits inside `overflow-x-auto`, which clips an in-flow panel; and `now` is read once at construction, matching the console's no-live-updates rule, so the stamp is as fresh as the fetch that produced the row.

- **Console detail screens carry a breadcrumb, not a back link** (AECI-777, spec §5.0b). `<aec-admin-breadcrumb>` renders once in the shell, under the category row, as `Admin › Operations › Vendors › Acme Corp`. It replaces the four hand-rolled "Back to …" links the parameterised routes each carried, which had drifted into four class strings and two wrapper shapes for one job. Three rules. **It follows the public site's breadcrumb treatment** rather than inventing a console one, per `docs/ADMIN_PANEL_SPEC.md` §9 item 10 — the same `<nav aria-label="Breadcrumb">` + `<ol>`, the same `›` separator marked `aria-hidden`, the same `aria-current="page"` on the last crumb, sentence case (the Sentence-Case Rule names breadcrumbs explicitly as *not* overlines, so the uppercase variant on `/taxonomy` is the outlier, not the model). **Only ancestors are crumbs** — never siblings — so it is a location readout and not a second navigation surface; the category crumb is plain text because there is no route behind it, and neither is the page you are on. **It contains no heading**, because the shell owns the only `h1` and each screen the only `h2`; a heading in the trail would sit between them and break heading order, which is the same conclusion the nav's group labels reached twice already. Its consequence for the screens: with the trail carrying the way back, a detail `h2` names **which** vendor / account / claim / catalogue rather than the entity type, showing the same fallback word the trail does until the fetch resolves.

- **An audit action is rendered in English, with the raw token beneath it.** `describeAuditAction()` maps the vocabulary `apps/api` actually writes; an action this build has never heard of humanises its token rather than rendering blank, which is mandatory because `audit_log.action` is deliberately an open string and the table is excluded from the retention prune. Keeping the token visible is not redundancy: the description is what makes the ledger readable to someone who has not memorised the vocabulary, and the token is what makes a row greppable against a log line.

### Vendor portal (Stage 2)

The signed-in vendor's portal (`apps/web/src/app/vendor/`): the AECI-522 tabbed dashboard (Vendor Overview / Profile / Products / Integrations / Seats) plus the AECI-606 Integrations section. Gated by `vendorMeResolver`, `noindex`, non-cacheable.

**Every section has its own address: `/vendor/:vendorSlug/<section>`** (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.2). The sections are `routerLink` anchors over a `<router-outlet/>`, not buttons over an in-page switch, so a section is linkable, bookmarkable, and reachable with Back — and `aria-current="page"` is driven by `routerLinkActive` rather than by hand. The vendor slug leads because the address should say which company is being edited; bare `/vendor` resolves the caller's own vendor and redirects. The nav's first item reads **"Vendor Overview"**, not "Overview": it sits inside a page whose `h1` is the company name, and it has to stay self-describing in a screen-reader's link list and a history entry.

**The nav is a horizontal tab row under the company name** (`vendor/vendor-portal-nav.ts`, §6.4) — a 14rem side rail spent a seventh of a wide page on five short links, and the editors it fronts are what want the width. The active item carries the 2px `accent-primary` bottom border over the row's hairline (`-mb-px` + `border-b-2`, the `/search` entity-tab treatment); the header gives up its own rule so the row reads as attached to the panel it switches. Narrow viewports **scroll the row sideways** rather than wrapping it — a wrapped tab row breaks its own underline across two lines — and there is exactly one row at every width, never a `md:hidden` duplicate. It is deliberately **not sticky**: `section-nav.ts` is sticky because it is an in-page jump nav on a long scroll, and a router nav has no such coupling.

> **The underline colour is `.aec-nav-tab[aria-current]` in `styles.css`, not a Tailwind utility.** `styles.css` sets `border-color` on `*` **outside any cascade layer**, and an unlayered rule beats every layered rule regardless of specificity — so `border-transparent` and `border-(--accent-primary)` silently never reach the tab and it renders `border-default` grey in both states. This defeats every border-color utility in the app (~165 usages, the `/search` tabs included); the real fix is moving that `*` rule into `@layer base`, which is an app-wide visual change and wants its own issue.

- **Products is a dropdown with a search box, not a link** (`vendor/vendor-products-menu.ts`) — a disclosure button opening a top-layer panel whose first control filters the vendor's own catalog by name, alphabetical, with the current product check-marked. Choosing one sets the `/products/:productSlug` segment. A stack of collapsed disclosures reads fine at three products and is unusable at a hundred, where the one you came to edit cannot be named; a non-editable picker beside the heading fixed the stack but still required being *on* the products page to switch, and gave a long catalog nothing but first-letter typeahead. Because the trigger is a button and not a link, its current state is `aria-current="true"` computed from the router (subset-matched, so it stays current once a product slug is appended) rather than from `routerLinkActive` — the one exception to the rule above, and the reason is that the item has no `routerLink` to hang the directive on.
- **A vendor with one product (or none) gets a plain link instead.** A dropdown over a single option is noise, and the link keeps the section reachable in the degenerate case.
- **The panel is a `cdkConnectedOverlay`, and it must be**: the row is `overflow-x-auto`, i.e. a clip container, so an `absolute top-full` panel would be clipped by the row it hangs from. It is the one shadowed box on the surface (Borders-Not-Shadows permits dropdowns).
- **The products section still shows one product at a time** (`sections/vendor-products-page.ts`): the bare path resolves to the primary product, the card carries no heading of its own (the form opens with its read-only name block, so a header would be the third place the same name appears), and a URL naming a product the vendor does not own says so rather than quietly rendering a different one.

**It is not a static page — it live-updates while it is open** (AECI-516, shipped 2026-08-19; `docs/STAGE_2_REALTIME_SPEC.md`, transport decision ADR 0023). A poll loop (`vendor-live-sync.ts`) reads a per-vendor freshness cursor — every 20 s focused, 60 s unfocused, **paused with no timer when the tab is hidden** — and asks the shared store (`vendor-portal-store.ts`) to refetch only the sections that actually moved, so a claim approved or a plan activated by an admin lands without a reload. There is no socket. Two visual consequences are binding: **a background refresh must never reflow the control under the pointer or steal focus** (staleness is the lesser harm), and **a section holding unsaved edits is never overwritten** — it defers and offers a quiet "Updated elsewhere — reload this section" affordance instead. Toggle-shaped writes (Affirm / Deny / Clear) render optimistically and **roll back with a visible error**; form-shaped writes stay pessimistic, because "Saved" before it saved is a worse lie than a short wait.

**No new Mobbin anchor was picked, deliberately** — the same call the operator console made above (`ADMIN_PANEL_SPEC.md` §9.10), and recorded here because the Anchor-Site Rule's "record the anchor site with the surface" had never been satisfied for `/vendor`. The portal inherits the Phase 5/6 admin-queue and Phase 8.3 console vocabulary: bordered `--surface-raised` cards, border not shadow, the eyebrow-then-heading header, Forest figures, `tabular-nums`. It is an internal, signed-in surface reading the same catalog the public directory renders, so a second reference site would make AECi read as two products. One publication, one voice (Anchor-Site Rule). Token-only, i18n throughout, light-only.

- **Integrations section** (`<aec-vendor-integrations-section>`, `vendor/components/`) — one card per integration touching a product the vendor owns: their own product as the eyebrow, the counterpart as the `h3`, the mechanism beneath. Inside, a lane per `data_object` claim.

- **Direction is always the vendor's own frame.** Lanes render "Sends to Procore" / "Receives from Procore" / "Syncs both ways" through `products/pair-direction-labels.ts` — the *same* `@@pair.direction.*` copy the public pair page uses, extracted by AECI-606 rather than restated. The stored `a_to_b`/`b_to_a` never reaches the browser.

- **Agreement state reuses `<aec-agreement-badge>` verbatim.** The vendor's view of a claim must not disagree with the public page's view of the same claim, so the four states' copy and tone stay owned in one component — including the rule that `conflict` is the only red state and `single_source` never borrows `confirmed`'s treatment.

- **A conflict shows both positions, and is not styled as an error.** The disclosure is a `--surface-sunken` / `--border-strong` two-column `<dl>`: your stance and note beside theirs. Two vendors describing a flow differently is a disagreement to resolve, not a defect in either product — red on this surface belongs to the badge alone.

- **Affirm / Deny / Clear are plain buttons**, because they are commands that write on activation, not values you pick and submit (ADR 0010 governs the latter). The note field renders *inline and populated* rather than behind a collapsed disclosure, because `PUT` replaces the whole position: the UI must never look emptier than what a save will send. Aria is used where the ADR asks for it — the `data_object` combobox over the closed vocabulary, the direction listbox, and the version pickers, all via the shared `<aec-select>`.

- **One polite live region on the surface, many assertive ones.** Successful writes mutate a single persistent `role="status"` that names the subject; failures are lane-local `role="alert"` beside the control that failed. AECI-631 **hoisted that region out of the Integrations section and into the dashboard shell** — `vendor-dashboard-tabbed.ts` for Concept A, `vendor-dashboard-single.ts` for Concept B, one each and only ever one concept on screen. The shell is the layout route's component, so the region survives every section navigation. It is fed by `VendorPortalAnnouncer` (`vendor/vendor-announcer.ts`), a root service any section can announce into, because once the region lives in the shell a control five levels down has no other way to reach it — and because announcement wording belongs with the component that can name the subject, not with the store that holds the data. **Never add a second persistent one** — two live regions on one page make announcements race and duplicate, and the vendor hears the wrong one. Polite always; a background refresh is not an interruption. A **local** `role="status"` is still allowed, but only for immediate feedback on an action the user just took, beside the control they took it with, and only where it can never fire for an event the channel also announces (the two save confirmations and the add-claim duplicate notice qualify). Standing state that a background poll can move is plain text, not a region — the attestation control's divergent-slots notice was exactly that and had its role removed. Rule and audit: `STAGE_2_REALTIME_SPEC.md` §6.3 / §6.5.

- **Copy carries the trust promise.** Nothing implies attesting affects ranking or placement; the only search reference is that search refreshes within a day; "Verified" is framed as an account status arranged with AEC Integrations, and the unverified state explains what verification unlocks rather than 403-ing a vendor out of their own data.

### Inputs / Fields

Native inputs driven by Signal Forms today (ADR 0009); richer controls use Angular Aria per the provider note above (ADR 0010, Accepted) — `select`/`radio` are realised via combobox/listbox (Aria@22 ships neither), and these discrete-choice controls bridge into Signal Forms via `[(value)]`+`(valueChange)`, not `[formField]`. Styling binds to tokens.

- **Style:** 1px solid `border-default`, `surface-base` background, `rounded.md` corner. Padding `spacing.3 spacing.4` (12px / 16px). Body typography role.
- **Focus:** border shifts to 1px solid `accent-primary`, paired with the focus-ring elevation. No glow halo, no underline animation — clean border swap.
- **Error:** border shifts to 1px solid `status-error` (`#B3261E`, 6.54:1 on white — see §2 → Status); accompanied by an inline label and an icon (color is never the sole error signal).
- **Disabled:** background fades to `surface-sunken`, text-secondary text. Pointer events disabled.
- **Help text:** `text-xs text-(--text-secondary)`, directly under the control, always rendered. Optional-field marking (`(optional)` on the label) is unchanged — unmarked still means required.

**Named rule — constraints are stated, never discovered.** Any field carrying a rule the user can trip — a minimum length, a range, a format, an expected kind of answer — states it in persistent help text under the control, with the constraint sentence itself set in `<strong class="text-(--text-primary)">` so it survives a skim of the surrounding guidance. A requirement that only appears in the error message after the user has already failed is a defect, not a validation strategy: the user writes an answer, gets rejected, and has to reverse-engineer what was wanted. The rule has an a11y half that is not optional: the hint's `id` is in the field's `aria-describedby` **from first render**, and the error `id` is *appended* to it when the error fires (`'x-hint x-error'`) rather than replacing it — so the requirement is announced on focus and survives the failure. Because the hint now carries the requirement, the error states the *failure* tersely ("Add at least 20 characters.") instead of restating the instruction — the two render stacked, and a paraphrase of the hint reads as noise. Shipped on every field in the app with a length floor: the claim body and correction body (20 chars, `requests/request-form-body.html`) and the review headline (5–100) and review body (50, `reviews/review-form.html`).

### Badges

> **No verification iconography in Stage 1.** AECi verifies nothing today: production
> holds zero vendor attestations and zero vendors with `verified = true`, and it stays
> that way until the Stage 2 portal lets a vendor attest. So **no checkmark, shield,
> tick, or "Verified" fill renders on any public surface** — a trust mark the data
> cannot back is the one design error this brand cannot afford. Provenance is carried
> by *text* (a maintainer name, and eventually a date), because text is falsifiable and
> a checkmark is not. If you are reaching for a trust glyph, you want the maintenance
> marker below. This is why `home-credibility-strip` uses a balance scale rather than
> the shield-check it originally shipped with.

What actually renders today:

- **Maintenance marker** (`shared/maintenance-marker`): neutral chip — `border-default` /
  `surface-raised` / `text-secondary`, decorative dot, no icon. On product detail, vendor
  detail, and the pair page. It is a **label, not a sentence, so it carries no terminal
  period**, and the date clause is joined with a middot. Four readings, all **live** since
  AECI-616: `Maintained by AEC Integrations` · `Maintained by AEC Integrations · Reviewed
  <date>` · `Vendor-maintained` · `Vendor-maintained · Updated <date>`. The date renders only
  when `last_reviewed_at` is set, and it is `null` on almost every record because **nothing
  was backfilled** — bare attribution is the honest default, not missing data. Never wire the
  date to `updated_at`: it is `$onUpdate` and promote restamps it, so the date would refresh
  itself on every bulk re-promote (60 production products share one `updated_at` day). The
  vendor branch is driven by real vendor attestations. Dates are formatted in **UTC**, not the
  ambient zone — SSR runs UTC and the browser does not, so a zone-local format would trip a
  hydration mismatch either side of midnight.
  - It **coexists** with the agreement pill below rather than replacing it, deliberately: the
    marker is page-header attribution ("who is on the hook for this page"), the pill is
    per-claim state on the mechanism cards ("do the two vendors agree about this one data
    object"). Three distinct signals share this page — marker, agreement chip, and the
    `rounded-full` verified-vendor pill — and collapsing any two would lose information.
- **Agreement pill** (`products/agreement-badge`): same neutral chip tokens. Renders
  `Unverified · AECi` on every claim on every pair page — the honest posture, not a
  warning. `Vendor-confirmed` / `Needs review` are defined for Stage 2 and unreachable.
- **Pending** (`badge-pending`): surface-sunken fill, text-secondary text, 0.5px border-default. Indicates "submitted, not yet reviewed" — never confused with verified.
- **Verified vendor** (`aec-verified-badge`, AECI-523): the trust-surface indicator for an **AECi-verified vendor _account_** (`vendors.verified`). A quiet editorial **pill** — Forest-soft wash (`--accent-primary-soft`) + Forest text + 0.5px Forest border + a shield-check glyph (Forest text on Forest-soft = 10.80:1). This is the badge the **pill shape is reserved for** (see Tags / taxonomy chips below): the `rounded-full` pill and the shield glyph keep it distinct from the `rounded.sm` integration `badge-verified` above and from the rating anatomy (gold stars). Two variants — `full` (icon + "Verified vendor" label) and `compact` (icon-only, accessible name via `aria-label`, for dense contexts like the product-pair rail). Renders **only when verified** — the public "Unverified" baseline is the badge's absence, never a label (the explicit "Unverified" readout is a vendor-dashboard concept). It is a **trust** signal, never a paid-placement or ranking signal (no pay-for-placement), and never an endorsement of product quality.
- **Agreement badge** (`aec-agreement-badge`, AECI-300 / AECI-605): the per-claim state on the product-pair page's data-flow lanes — whether the two vendors agree that a `data_object` flows between their products. A `rounded.sm` **chip**, deliberately *not* the pill: the pill belongs to `aec-verified-badge`, which means an AECi-verified vendor *account*, and the two must never be read as the same signal. Four states, and the tonal ladder between them is the point:

  | State | Treatment | Label |
  |---|---|---|
  | `unverified` | `border-default` / `surface-raised` / `text-secondary`, tertiary dot | "Unverified · AECi" |
  | `single_source` | the **same neutral chip**, `text-secondary` dot | "Confirmed by {vendor}" |
  | `confirmed` | Forest-soft wash + Forest text + Forest border (10.80:1) | "Both vendors confirmed" |
  | `conflict` | `--status-error` text + border on `surface-base`, `✕` glyph | "Vendors disagree" |

  Three rules hold this together. **`single_source` shares the neutral chip with `unverified` on purpose** — one vendor affirming while the counterparty stays silent must never borrow the affirmative Forest treatment, so the only difference is a slightly stronger dot; the badge names the vendor and its `aria-label` states the other's silence outright. **`confirmed` is the only badge that earns the wash**, and only for two *distinct* vendors. **`conflict` is the only red**, and it reports a difference between vendors, not a defect in either product. Colour is never the sole signal (WCAG 1.4.1): every state carries a distinct visible label and accessible name, and the dot/glyph is `aria-hidden`.

- **Version diff markers** (AECI-303, `STAGE_2_ATTESTATIONS_SPEC.md` §9): on the product-pair page's claim rows, what the selected product-version pair *changed*. Deliberately **not badges** — a rule and a label, not a chip:

  | State | Treatment | Label |
  |---|---|---|
  | `unchanged` | **nothing** | — |
  | `added` | `border-s-2` Forest **start rule**, `+` glyph, `.aec-overline` in `text-secondary` | "New in {version}" |
  | `removed` | `border-s-2` `border-strong` start rule, `−` glyph, name steps to `text-secondary` + `line-through` | "Removed in {version}" |

  Four rules, each of which rules something else out. **Position carries the separation:** the marker sits at the row's *start*, the agreement badge at its *end* — left is what changed in this version, right is who agrees about it. Two questions, two zones, no competition. **`added` gets the rule, not a wash:** `--accent-primary-soft` is the `confirmed` chip's, and a wash inches from a neutral chip reads as "confirmed" by proximity; a single vertical mark is unmistakably structural, and doubles as a scannable gutter down the lane (borders-not-shadows, and the same spirit as the Score Display's range marker). **`removed` is never `--status-error`:** `conflict` is the only red, and a second red on the same row would collapse "vendors disagree" into "no longer supported". Clay is excluded on both counts — `added` is not a warning, and the Clay-Restriction Rule caps that hue at ≤5% of a screen, which a per-row marker blows instantly. And **`unchanged` renders nothing**, which is both the overwhelming majority state and what keeps the default latest × latest view byte-identical to a pair page with no version data at all.

  `text-secondary` only, never `text-tertiary`: these rows sit on `surface-base` inside a `surface-raised` lane, and the tertiary token is forbidden on sunken/muted surfaces. Logical `border-s-*` keeps the mark on the correct edge under RTL. Every state carries a glyph **and** a visible text label (WCAG 1.4.1), and `removed` adds a decoration change on top.

  **No Mobbin anchor was picked for this surface, deliberately** — the same call the AECI-605 agreement badge recorded. The pair page has three shipped layers and a settled chip/token vocabulary; the diff markers inherit it rather than importing a second site's visual language onto the page that is most editorial. This is the standing precedent for anchorless surfaces (see the Phase 8.3 operator console: "One publication, one voice").

**Deferred to Stage 2, not shipped:**

- **Verified** (`badge-verified`): Forest fill, surface-base text, `rounded.sm`, label typography. Reserved for vendor-verified integrations and other editorially-confirmed states. **Do not build this until vendor attestations exist** (AECI-514) — until then there is nothing true for it to mark.

### Tags / Taxonomy chips

Chip-style links to category / audience / phase browse pages (the `TaxonomyBadge` component). Distinct from the status badges above — these are navigational, not state indicators.

- **Surface:** `surface-raised` fill, 0.5px solid `border-default` raising to 1px `border-strong` on hover. `rounded.sm` (4px) — chips, not pills (the pill shape is reserved for vendor-verified badges).
- **Typography:** Atkinson Hyperlegible Next **medium (500)**, 0.8125rem / 13px, tracking +0.01em. Deliberately lighter than the `label` role (600): the chip reads as a content tag, not a button. (500 is a real cut since the Next upgrade, AECI-230 — the classic family silently rendered it as 400.) `text-primary` shifts to `accent-primary` on hover.
- **Case:** sentence case, per the Sentence-Case Rule.

### Score Display

The signature data component for review scores. Source Serif 4 numerals (headline typography role) in Forest, no chart-junk decoration, no sparkline behind the number — the score *is* the visual.

- **Numeric value:** Source Serif 4 600, headline scale (`clamp(1.75rem, 2.5vw + 0.75rem, 2.5rem)`), Forest color (`accent-primary`).
- **Label below:** Atkinson Hyperlegible label scale, text-secondary color.
- **Range marker** (optional, sparse): a single vertical mark on a 1-10 axis with no fill, no gradient, no animation — visible at a glance, not a chart.

### Data visualization — operator console only (AECI-578)

The admin panel (`/admin/*`, `docs/ADMIN_PANEL_SPEC.md` §8) is the one surface in
AECi that plots multi-series data. Its primitives live in
`apps/web/src/app/admin/charts/` and are hand-rolled SVG + HTML — there is no
charting dependency and none is to be added (§13 D3). The method comes from the
`dataviz` skill: pick the form, then assign colour by the job it does, then
validate the palette with a script rather than by eye.

**The series palette is scoped, and it is not a brand colour.** Eight categorical
hues are declared under `.aec-charts` in `apps/web/src/styles.css`, deliberately
**outside `@theme inline`** so they never become Tailwind colour utilities and
cannot drift onto a public surface. They encode *data-series identity* on an
operator screen. **Forest remains the sole brand primary** under the
Forest-Anchor Rule above; nothing here is a second primary, and none of these
hues may appear outside `/admin`.

| Slot | Hue | Light | Reserved for |
|---|---|---|---|
| 1 | blue | `#2a78d6` | human page views |
| 2 | orange | `#eb6834` | bot page views |
| 3 | aqua | `#1baf7a` | — |
| 4 | yellow | `#eda100` | — |
| 5 | magenta | `#e87ba4` | — |
| 6 | green | `#008300` | — |
| 7 | violet | `#4a3aa7` | — |
| 8 | red | `#e34948` | — |

Adopted verbatim from the `dataviz` skill's validated reference palette rather
than derived from the AECi hues, because the brand system has exactly one
meaning-bearing hue (Forest) plus Clay deep and Error red — not a categorical
set, and a hand-derived one would need its own validation pass. Verified as a set
with the skill's `validate_palette.js`: lightness band PASS, chroma floor PASS,
CVD separation PASS (worst adjacent ΔE 9.1), normal-vision floor PASS (worst
adjacent ΔE 19.6).

Rules that ride with it:

- **Colour follows the entity, never its rank.** Slots are declared as part of a
  series' identity, not assigned by array index — a filter that changes the series
  count must not repaint the survivors. Human is always slot 1, bot always slot 2.
- **The relief rule.** Slots 3, 4 and 5 measure below 3:1 against the light
  surface (2.74 / 2.11 / 2.62). Any chart reaching slot 3 must ship **visible**
  value labels. The visually-hidden data table does *not* discharge this — the
  reader who needs the relief can see the chart.
- **Eight is the ceiling.** A ninth generated hue is indistinguishable under CVD.
  Past eight, fold the tail into `--chart-other` or facet.
- **Text never wears the data colour.** Values, labels, legends and axis text use
  `--text-primary` / `--text-secondary`; a coloured mark beside the text carries
  identity.
- **Marks:** 2px lines with round caps; area fills at ~10% opacity; ≤24px bars
  with a 4px rounded data end and a square baseline; a **2px surface gap** between
  every pair of touching fills, columns and stacked segments alike; hairline solid
  gridlines in `--chart-grid`. White does the separating — never a stroke around a
  mark.
- **Never a dual axis**, never a truncated bar baseline, never a rainbow ramp.
- **Legend for ≥2 series, none for one** (the title already names a lone series).
- **Light only.** The skill's dark column is recorded there for the Stage 2 dark
  reintroduction; Stage 1 ships no `dark:` variant.
- **Responsive via `viewBox`, never a JS resize handler.** Axis labels are HTML
  positioned by percentage over the SVG, because `viewBox` scaling would shrink
  SVG text to unreadable sizes in a narrow column.

### Navigation

- **Style:** Atkinson Hyperlegible label scale, sentence case, text-primary color, transparent background.
- **Default → hover:** color shifts to `accent-primary`. No underline-on-hover for top-level nav (reserved for inline body links).
- **Active route:** color = `accent-primary`, paired with a 2px bottom border in `accent-primary` for primary nav. Border on the *element*, not as a side stripe (forbidden — see Do's and Don'ts). In a horizontal ROUTER nav the concrete form is `-mb-px border-b-2` on the item over the row's `border-b`, so the item's own border replaces the hairline beneath it rather than stacking above it; narrow viewports scroll the row (`overflow-x-auto whitespace-nowrap`) rather than wrapping, which would break the underline across two lines. Shipped three times: the `/search` entity tabs, the vendor portal's section row, and the admin console's category row (AECI-694). Watch the cascade trap recorded under "Vendor portal (Stage 2)" — `border-color` on `*` is unlayered in `styles.css`, so a border-color *utility* cannot set this colour.
  - **The admin console's row is the one exception to the scroll rule, and it is a consequence not a preference.** With only three items it fits a 320px viewport outright, and `overflow-x-auto` computes `overflow-y` to `auto` as well, which would clip its in-flow dropdown panels — forcing every panel into a CDK overlay to escape a clip the row does not need. It wraps rather than scrolls. Any row that both scrolls *and* drops down has to portal its panels; decide which one it is before writing the markup.
- **The row:** `Home · Products · Categories · Trades · Audiences · Phases`. The four taxonomy facets are the directory's spine and lead. The row is **public-only** — every item is a public directory surface, and it renders identically for every viewer. It used to end in a `More▾` overflow menu; that was retired (see The Overflow Rule below).
- **Mobile:** collapses into a CDK-overlay dropdown with focus trap. No hamburger-as-mystery — the toggle is labeled. It carries the same six entries, with the four facets as tap-to-expand disclosures, plus search and the account block. Below `lg` the hamburger is the only menu control, so it also carries the pending-review badge.
- **All four dropdowns in this row behave identically** — hover opens, mouseleave closes, Escape closes and returns focus to the trigger, and focus leaving the host closes. That contract is a shared base (`layout/nav-disclosure.ts`); a new dropdown **in the public primary nav** extends it rather than reimplementing it. The **trigger shape is the implementor's**, not the base's: the four public facets follow the clean editorial convention of Yahoo Finance navigation — one text link that navigates to the facet index and carries `aria-expanded`/`aria-controls`/`aria-haspopup`, with no separate arrow button (which cost width and cluttered the row), and ArrowDown on that link opens the panel and moves focus into it (`layout/nav-flyout-trigger.ts`). The admin console's row keeps a `button` trigger that toggles, since its items are not themselves destinations. A row where one dropdown opens on hover and its neighbour only on click reads as a bug. (It had a fifth implementor, `More▾`, until that menu was retired.)
  - **The base is no longer public-nav-only.** The admin console's category row (`admin/admin-nav-dropdown.ts`, AECI-694) is the first implementor outside the header, for the same reason: a portal whose dropdowns behaved differently from the site's would read as a different product. It is deliberately **not** `@angular/aria/menu` even though ADR 0010 routes new menu patterns there — a navigation row of router links is not an application menu, and `role="menu"` is the wrong semantic for it. `ANGULAR_STYLE_GUIDE.md` §19 and the ADR both carry that clarification.
  - **A category with exactly one destination is a plain link, not a one-item dropdown.** A disclosure that reveals a single item is a click that buys nothing. Label it with the **group** name, not the item's: at the top level of a nav the category is what is self-describing. Keep the rule structural (`items.length`), so the group becomes a dropdown by itself the day it gains a second screen.
  - **The exception, and why it is one.** A dropdown whose panel contains a **text field** does not hover-open: a panel you are typing into must not evaporate because the pointer strayed. It also cannot use `NavDisclosure` mechanically — that base closes on `focusout` by asking `host.contains(relatedTarget)`, and a panel in the browser's top layer is not a DOM descendant of the host, so every focus move *into* the panel would read as "focus left" and slam it shut. The vendor portal's Products menu is the first of these (`vendor/vendor-products-menu.ts`): click to open, focus into the search box, Escape or Tab closes and returns focus to the trigger, outside click closes. Keep that set identical for any future search-bearing dropdown.
- **Handover breakpoint:** the inline primary nav appears at `lg` and up; below that the hamburger carries it (`aec-nav-menu` is `lg:hidden`). Moved up from `md` when Trades became the fourth taxonomy flyout (AECI-544): seven items plus the wordmark and sign-in CTA no longer fit a 768px header, and clipping nav items out of the viewport is worse than deferring to a labeled overlay that already lists every facet. The header search input appears at `xl`. Adding a further top-level nav item needs a re-measure, not just an insert. **Retiring `More▾` gave a slot back, which may make `md` viable again — but that is a re-measure at 768px, not an assumption**, so the breakpoint stays at `lg` until someone does it (**AECI-669**). Whichever way that lands, record the measured number here so it is not re-litigated.
- **Dropdown panel type hierarchy — three levels, and a panel item pins its own weight.** Inside any nav dropdown: a **column title** is 600, sentence case, 14px, `text-primary`; a **group label** is the overline (600, uppercase, 12px, `text-secondary`); a **destination** is **400**, 14px, `text-primary`. Panel destinations set `font-normal` explicitly rather than inheriting — the primary row carries `font-medium`, so an unpinned item renders at 500 inside the flyout and 400 inside the mobile overlay (the same component, two weights), and at 500 it sits too close to the 600 label above it for a reader to tell a header from a link. Pin the weight at the list component; never let the row's weight reach a panel. Only the facet flyouts (`nav-flyout-list.ts`) use this now — the grouped, multi-level form went with `More▾` — but it is the contract any future panel inherits.

- **Grouped nav lists are separated by vertical rhythm, never by indentation.** In a grouped list, a destination sits on the **same left rail as its own group label** (`px-3` on both) — what separates one group from the next is space: roughly **12px between items and 26px at a group boundary**, a >2:1 ratio, so proximity alone tells a reader where a group ends. The live instances are the mobile nav overlay and, since AECI-694, the admin console's dropdown PANELS — the admin sidebar that used to demonstrate it (`space-y-6` between groups vs `space-y-1` within) became a horizontal row of categories, so each group now gets a panel of its own and the boundary is the panel edge. The rule still governs any panel that carries more than one group. **Do not indent items under their label**: an indent reads as *tree depth*, which these non-clickable eyebrow labels do not have, and it invites a click on the label. If a grouped list reads as flat, the fix is the group gap, not a horizontal step. (This rule was written when the header's `More▾` panel rendered the same array as that sidebar and the two had to stay aligned row-for-row. The panel is gone; the rule survives it because it is about how a grouped list reads, not about that pairing.)

**The Overflow Rule.** The primary row is width-budgeted, **public-only**, and closed. It carries the directory's primary surfaces and nothing else.

- **A new *secondary* destination goes to the footer**, not into the row and not into a header menu. The footer is server-rendered on every page, so a link there is as reachable and as crawlable as one in the header. See "The footer" below.
- **A new *primary* destination is a re-measure at 1024px**, not an insert.
- **A role-gated surface gets one door in the account menu** (`layout/user-menu.ts` at `lg+`, the overlay's account block below). Never a row item.

> **This supersedes the previous rule, which put secondary destinations in a `More▾` overflow menu and the complete `/admin` section inside it.** Two things were wrong with that. Its public half was ~83% duplicated by the footer — of twelve links, ten were already there, and only Updates and Roadmap were unique. And its admin half restated the eleven-screen `/admin` IA that `admin/admin-shell.ts` already renders from the same `ADMIN_NAV_GROUPS` array, which is why the panel had to grow to a two-column `34rem` grid for an admin. A portal owns its own navigation; the header's job is to offer **one door** to it.

**Why the doors are in the account menu, not the row.** The old rule said *"admin navigation belongs with site navigation; the account menu is for the person, not for operator surfaces."* That reasoning was about eleven screens of navigation, and it does not carry to a single door. The sharper line: **the row is the site; the avatar is you and what you can operate.** The row renders on cached, URL-keyed, indexable pages and must look the same to everyone — a private, `noindex`, role-gated door in it would make the row's width depend on who is looking (seven items for an admin, six for a visitor), against the closed width budget above. The account menu is *already* the viewer-dependent region: it only mounts when signed in, and it already held the Vendor portal door. Putting Admin beside it makes the two portals symmetric and the header legible.

**Both doors are one link each** — "Admin portal" → `/admin`, "Vendor portal" → `/vendor` — in sentence case, matching the rule that user-facing copy says *portal*, never *dashboard* (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.3). Neither restates its portal's sections. The pending-review badge sits on the account-menu trigger, following the Admin door.

**Nothing role-gated may reach server-rendered HTML.** Both doors are gated on the shared, browser-only role probe (`auth/role-status.ts`), which reports `null` during SSR — so no `/admin` or `/vendor` href is ever baked into the URL-keyed cached header. This is the header-side complement to `/admin/*` being non-cacheable.

### The footer

Never specified until the Overflow Rule made it load-bearing: it is now the home
for every secondary destination, and the only site-wide entry point for several
of them. Source: `apps/web/src/app/layout/site-footer.ts`; the columns are pinned
by `site-footer.component.spec.ts`, because a link quietly dropping out is a
regression rather than a tidy-up.

**Anchor:** Stripe — a brand region (wordmark + one-line tagline) beside a nav
group of three labelled `<nav>` columns, over a bottom strip carrying copyright,
separated by a `border-default` hairline. The nav group is its own responsive
grid (2 columns on mobile, 3 from `sm`) so the columns stay balanced instead of
the brand eating a quarter-column and leaving a dead zone at tablet widths. From
`lg` the brand sits left, the nav group right.

**The three columns, and why each holds what it does:**

| Column | Holds | Why |
|---|---|---|
| **Directory** | Home, Products, Categories, Audiences, Trades, Phases | The primary surfaces, in **server-rendered HTML**. The header's facet values render client-side and its mobile overlay never reaches SSR, so this is where a crawler meets the taxonomy. |
| **Legal** | Terms, Privacy, Review guidelines, Listing accuracy | Trust-first positioning means the legal set is one click from every page, not buried. |
| **Company** | About, Contact, Updates, Roadmap | Who we are and where we are going. Updates and Roadmap arrived here when `More▾` was retired; the header links neither, so this is their sole site-wide entry. |

**Rules.**

- **Every column is a `<nav>` with an `aria-label`.** Three unlabelled navs in one
  landmark are indistinguishable in a screen reader's landmark list.
- **The footer is visitor-neutral, absolutely.** It sits inside URL-keyed cached
  HTML and holds no session state — no portal door, no account link, no badge.
  That is what lets it render identically for everyone. Role-gated affordances
  live in the account menu (the Overflow Rule).
- **Column labels are overlines**; links are `text-secondary` rising to
  `text-primary` on hover — quieter than header nav on purpose, because this is a
  reference surface, not a wayfinding one.
- **Vendors / Integrations are deliberately absent** (AECI-160, PO decision;
  AECI-165 removed the index pages, which now 301 to `/products`). Their detail
  pages stay reachable via product links, `sitemap.xml`, and search.
- **i18n ids are shared, not duplicated.** Several links reuse `@@app.nav.*` /
  `@@app.footer.*` ids that other surfaces also emit. Keep the tight
  `<ng-container i18n>` wrap so the extracted source string stays byte-identical —
  an identical source under a shared id is one translation unit; a differing one
  is a collision.
- **Adding a column** is a re-measure at `sm`, where three become two. Prefer
  growing an existing column: four to six items read fine, and the Company column
  absorbed two without a layout change.

### Layout shells

Three reusable Angular shells (`apps/web/src/app/layouts/`) — every Phase 2 page projects body content into one of them via named slots (shadcn-style composition). No state, no inputs; structure only. Anchor inherited from the AECi site chrome (Stripe — see Named Rules).

All three share the same outer container: `max-w-7xl` centered, `surface-base` background, `text-primary` text, 24px horizontal / 32px vertical padding on phones, 32px / 48px on `md` and up. Section dividers use `border-default` (0.5–1px). No box-shadows.

- **DetailLayout** (`<aec-detail-layout>`) — for product / vendor / integration detail pages.
  - **Slots:** `breadcrumbs`, `hero` (required), `metadata` (right column), `body` (required).
  - **Grid:** `md:` two-column (2fr main / 1fr metadata) with sticky-top metadata; collapses to single column with metadata below hero on phones.
  - **Internal rhythm:** hero bordered below; body sections stack with `space-y-12`; metadata sidebar uses `space-y-6`.

- **BrowseLayout** (`<aec-browse-layout>`) — for the card-grid browse pages (Phase 3 filters).
  - **Slots:** `header` (required), `filters` (Phase 3 placeholder), `grid` (required).
  - **Grid:** `md:` two-column (1fr filters / 3fr grid) with sticky-top filters; filters collapse above grid on phones.
  - **Internal rhythm:** header bordered below; grid uses container's own card spacing.

Every visible string and every ARIA label is i18n-wrapped (`@@app.layouts.{detail|browse}.{slot}.aria`). Concrete pages add their own i18n keys for projected content.

> **`IndexLayout` and `EntityTable` (§11.2) — neither ships.** The Phase 2 spec listed a generic sortable / paginated `EntityTable` primitive; in implementation its whole responsibility (the semantic `<table>`, the scroll container, the `table-header` / `table-body` / `pagination` slots) was folded into a third shell, `IndexLayout` (`<aec-index-layout>`), so no separate `EntityTable` class was ever written. `IndexLayout` then lost its own consumers: AECI-165 deleted the `/vendors` + `/integrations` index pages, and AECI-190 rebuilt `/products` on **`BrowseLayout`** (it needs the facet rail, which `IndexLayout` has no slot for). The shell was deleted in AECI-657. Listing pages now compose `BrowseLayout` + their own `<table>` or `ProductCardGrid`; if a table shell is ever wanted as a primitive again, extract it from `products-index.ts` at that point.

## 6. Do's and Don'ts

The strategic anti-references in `PRODUCT.md` carry through here as concrete visual prohibitions. Every PRODUCT.md anti-reference appears below as a "Don't" with the same language.

### Do:

- **Do** use OKLCH in CSS (`oklch(...)`) for color tokens. Hex values are documented as fallbacks but the canonical source is OKLCH (the front matter, plus `apps/web/src/styles.css`).
- **Do** pair Source Serif 4 (display) with Atkinson Hyperlegible Next (body) — the chosen system pair. Use them in their assigned roles (display for headings, body for prose, label for buttons / badges / table headers, overline for eyebrows / kickers / sidebar microheadings).
- **Do** use sentence case everywhere. Headings, buttons, labels, navigation, table headers, page titles, section titles. The overline role is the single uppercase exception (§3).
- **Do** use 0.5px borders to separate surfaces (`border-default`); 1px for emphasis; 2px for featured states.
- **Do** keep Clay rare (≤5% per screen, decorative/fill only — fills carry `text-primary`, never white). Clay-colored text and icons use Clay deep (`#A14D22`); star-rating glyphs use Goldenrod (`#DAA520` / `--accent-rating`). CTAs are always Forest (the Forest-Anchor Rule).
- **Do** use Bone as a *warm-tinted accent surface* — hero bands, callout sections — never as a page background.
- **Do** vary spacing for visual rhythm (4pt scale: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96). Tight groupings, generous separations.
- **Do** use container queries (`@container`) for component-level responsiveness; viewport queries for page layout.
- **Do** respect `prefers-reduced-motion` on every transition. Default durations: 120ms (hover), 180ms (default), 280ms (page transitions).
- **Do** show a visible focus-ring on every interactive element (`:focus-visible`). Never `outline: none` without a replacement.

### Don't:

- **Don't** use `border-left` or `border-right` greater than 1px as a colored accent stripe on cards, list items, callouts, or alerts. **Side-stripe borders are banned.** Rewrite with a full border, a background tint, leading numbers/icons, or no visual indicator at all.
- **Don't** use gradient text (any combination of `background-clip` text fill plus a gradient `background`). **Gradient text is banned.** Solid colors only; emphasis via weight or size.
- **Don't** use the hero-metric template (big number + small label + supporting stats + gradient accent). It's the SaaS cliché; the score-display component is the editorial alternative.
- **Don't** use sparklines as decoration. Tiny charts that look sophisticated and convey nothing meaningful are noise.
- **Don't** nest cards inside cards. Visual noise; flatten the hierarchy.
- **Don't** use identical card grids (3×3 or 4-up cards each with icon + heading + 8 words). Vary the layout, vary card sizes, break the grid intentionally for emphasis.
- **Don't** use any of the reflex-reject fonts: Inter, DM Sans, Plus Jakarta Sans, Geist, Mona Sans, Space Grotesk, IBM Plex Sans, Outfit, Roboto, Open Sans, Arial, Fraunces, Newsreader, Lora, Crimson Pro, Playfair Display, Cormorant, Cormorant Garamond, DM Serif Display, DM Serif Text, Instrument Sans, Instrument Serif, Syne. The chosen pair is Source Serif 4 + Atkinson Hyperlegible.
- **Don't** use `#000` or `#fff` directly. Use `text-primary` (`#0A0A0A`) and `surface-base` (`#FFFFFF`) tokens.
- **Don't** use bounce or elastic easing on motion. Use exponential ease-out (`ease-out-quart` / `quint` / `expo`). Real objects decelerate smoothly.
- **Don't** use glassmorphism (blur, glass cards, glow borders) decoratively. Rare and purposeful, or nothing.
- **Don't** put box-shadows on cards or buttons. Borders separate surfaces; shadows are for modals, dropdowns, popovers, and focus rings.
- **Don't** use the AI color palette: cyan-on-dark, purple-to-blue gradients, neon accents on dark backgrounds, gradient backgrounds for impact.
- **Don't** use stock photography of construction sites, hard hats, or blueprints. The AEC visual cliché — the brand is editorial about AEC, not a costume of AEC.
- **Don't** use emoji in UI chrome. Lucide icons exclusively. Emoji rendering is inconsistent across platforms and clashes with the editorial brand.
- **Don't** use em dashes in UI copy (also not `--`). Use commas, colons, semicolons, periods, or parentheses.
- **Don't** make every button primary. Use ghost and secondary variants — hierarchy matters.
- **Don't** use modals as the first thought. Exhaust inline / progressive disclosure / drawer alternatives first.
