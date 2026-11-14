---
name: AEC Integrations
description: Editorial directory and review platform for AEC software integrations. Light-only (AECI-226; dark reintroduction dropped, not roadmapped), Tailwind v4 + Spartan brain.
colors:
  # Light theme, the only theme (dark token set removed in AECI-226 and not
  # roadmapped). These are the :root colour tokens in apps/web/src/styles.css:
  # 18 base tokens and 20 added by AECI-1747, 38 in all. Each opaque value
  # renders the hex in styles.css; design-tokens.hex.guard.spec.ts pins that.
  surface-base:           "oklch(100% 0 0)"
  surface-raised:         "oklch(98.43% 0 0)"
  surface-sunken:         "oklch(96.74% 0.0013 286.38)"
  surface-muted:          "oklch(96.74% 0.0013 286.38)"
  border-default:         "oklch(91.97% 0.0036 286.32)"
  border-strong:          "oklch(87.20% 0.0055 286.32)"
  border-input:           "oklch(63.63% 0.0133 286.02)"
  text-primary:           "oklch(14.48% 0 0)"
  text-secondary:         "oklch(44.19% 0.0146 285.79)"
  text-tertiary:          "oklch(55.17% 0.0138 285.94)"
  accent-primary:         "oklch(32.24% 0.0397 166.73)"
  accent-primary-hover:   "oklch(43.47% 0.0641 160.30)"
  accent-primary-soft:    "oklch(95.35% 0.0066 160.07)"
  accent-secondary:       "oklch(74.64% 0.1164 49.55)"
  accent-secondary-deep:  "oklch(51.86% 0.1245 45.13)"
  accent-rating:          "oklch(75.16% 0.1469 83.99)"
  accent-warm:            "oklch(96.13% 0.0111 89.72)"
  status-error:           "oklch(50.13% 0.1783 28.70)"
  # Added by AECI-1747. Hex in order: #26473A, #15291F, #84848D, #C5D3CA,
  # #B9C7BF, #E7E1D2, #3B6E55, #DADADC, #B5B5B5, #C6C6CA.
  surface-hero-panel:     "oklch(36.82% 0.0453 166.67)"
  surface-footer:         "oklch(26.02% 0.0324 161.25)"
  border-field:           "oklch(61.63% 0.0134 286.00)"
  text-on-brand-secondary: "oklch(85.36% 0.0195 157.80)"
  text-on-footer-secondary: "oklch(81.66% 0.0189 161.01)"
  surface-on-brand-hover: "oklch(91.04% 0.0211 88.73)"
  surface-hero-ribbon:    "oklch(49.48% 0.0689 161.11)"
  surface-sunken-hover:   "oklch(88.89% 0.0027 286.34)"
  border-underline:       "oklch(77.31% 0 0)"
  border-empty:           "oklch(82.77% 0.0055 286.28)"
  # Bone again, #F5F2EA. In styles.css text-on-brand and focus-ring-on-brand
  # are var(--accent-warm), so a copy cannot drift.
  text-on-brand:          "oklch(96.13% 0.0111 89.72)"
  focus-ring-on-brand:    "oklch(96.13% 0.0111 89.72)"
  # Alpha tokens, composited in sRGB over the ground. Bone at 10, 16, 14, 32
  # and 50 percent, Forest hover at 75 and 45 percent, white at 94 percent.
  surface-on-brand-wash:       "oklch(96.13% 0.0111 89.72 / 10%)"
  surface-on-brand-wash-hover: "oklch(96.13% 0.0111 89.72 / 16%)"
  border-on-brand-subtle:      "oklch(96.13% 0.0111 89.72 / 14%)"
  border-on-brand:             "oklch(96.13% 0.0111 89.72 / 32%)"
  border-on-brand-strong:      "oklch(96.13% 0.0111 89.72 / 50%)"
  surface-hero-glow:           "oklch(43.47% 0.0641 160.30 / 75%)"
  surface-hero-glow-soft:      "oklch(43.47% 0.0641 160.30 / 45%)"
  surface-sticky:              "oklch(100% 0 0 / 94%)"
typography:
  # The limited ramp (clashes 9 and 17, PLAN.md §4.2): ten sizes, weights 400
  # and 600. Every value is real CSS. The four fluid sizes are the clamp()
  # expressions in apps/web/src/styles.css (AECI-1748): rem bounds and a
  # rem-plus-vw middle term. AECI-1748 confirmed the weights, line heights and
  # tracking measured from mock-up 6.
  display:
    # The Display clamp the About and Home heroes and the vendor masthead
    # declare (clash 7 rules only on detail pages). Not a ramp token. It does
    # not render today: those heroes put it on the h1 element, and the unlayered
    # h1 rule wins, so they show the h1 size (--t-fig, 28 to 40px, weight 600).
    # AECI-1847 moves the size onto an inner span.
    fontFamily: '"Source Serif 4", Georgia, "Times New Roman", serif'
    fontSize: "clamp(2.25rem, 4.5vw + 1rem, 4rem)"
    fontWeight: 400
    lineHeight: 1.05
    letterSpacing: "-0.01em"
  display-detail:
    # --t-display, 40 to 72px: the product name on a detail page (clash 7). The
    # page adopts it when it is rebuilt (AECI-1778).
    fontFamily: '"Source Serif 4", Georgia, "Times New Roman", serif'
    fontSize: "clamp(2.5rem, 2.4vw + 2.375rem, 4.5rem)"
    fontWeight: 400
    lineHeight: 1
    letterSpacing: "-0.02em"
  statement:
    # --t-statement, 34 to 56px.
    fontFamily: '"Source Serif 4", Georgia, "Times New Roman", serif'
    fontSize: "clamp(2.125rem, 1.8vw + 1.875rem, 3.5rem)"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  figure:
    # --t-fig, 28 to 40px.
    fontFamily: '"Source Serif 4", Georgia, "Times New Roman", serif'
    fontSize: "clamp(1.75rem, 2.5vw + 0.75rem, 2.5rem)"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.01em"
  section:
    # --t-36, 28 to 36px.
    fontFamily: '"Source Serif 4", Georgia, "Times New Roman", serif'
    fontSize: "clamp(1.75rem, 1vw + 1.35rem, 2.25rem)"
    fontWeight: 600
    lineHeight: 1.1
    letterSpacing: "-0.02em"
  headline:
    # --t-fig, the global h1 rule. Same pixels as before the ramp.
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
  card-title:
    # --t-20. The mock-up's line-height is 1.1.
    fontFamily: '"Source Serif 4", Georgia, "Times New Roman", serif'
    fontSize: "1.25rem"
    fontWeight: 600
    lineHeight: 1.1
  lede:
    # --t-20, in the body sans.
    fontFamily: '"Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "1.25rem"
    fontWeight: 400
    lineHeight: 1.5
  body:
    fontFamily: '"Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  caption:
    fontFamily: '"Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "normal"
  field-caption:
    # --t-12 with a 20px line height (start).
    fontFamily: '"Atkinson Hyperlegible Next", system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "0.75rem"
    fontWeight: 400
    lineHeight: "1.25rem"
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
rounded:
  # The new scale (clash 12, PLAN.md section 4.3). The keys are the role names
  # and equal the utility suffix and the CSS token: mark is rounded-mark and
  # --radius-mark. Do not write rounded-sm, md, lg or xl on a redesigned
  # component. Those are Spartan's scale and render 4.8, 6.4, 8 and 11.2px.
  none: "0"
  # 8px small marks (was 0.25rem).
  mark: "0.5rem"
  # 12px controls: buttons, inputs (was 0.5rem).
  control: "0.75rem"
  # 16px, measured on nested panels in the mock-ups. Not ruled. It sits between
  # control and card so the scale ascends. See "Open values" in section 4.
  panel: "1rem"
  # 24px cards (was 0.75rem).
  card: "1.5rem"
  # Chips. Never a primary action.
  pill: "9999px"
spacing:
  # The 4-point scale (clash 17): 4, 8, 12, 16, 24, 32, 48, 64, 96px. The keys
  # are Tailwind's step numbers, so spacing.6 is p-6 (24px). The scale is steps
  # 1, 2, 3, 4, 6, 8, 12, 16 and 24. AECI-1750 adds no spacing tokens.
  "0": "0"
  "1": "0.25rem"
  "2": "0.5rem"
  "3": "0.75rem"
  "4": "1rem"
  "6": "1.5rem"
  "8": "2rem"
  "12": "3rem"
  "16": "4rem"
  "24": "6rem"
components:
  # The redesign components (clashes 19 to 25, 39 to 41 and 43). Sizes and
  # edges are starting values measured from mock-up 6, default state, in
  # docs/design/mockups/redesign-2026-11/mockups/6-product-detail.html. The code
  # issues confirm them. Section 5 "Starting values from the mock-ups
  # (components)" gives the file and line for each value.
  button-primary:
    backgroundColor: "{colors.accent-primary}"
    textColor: "{colors.surface-base}"
    fontSize: "0.875rem"
    fontWeight: 600
    rounded: "{rounded.control}"
    minHeight: "44px"
    padding: "{spacing.0} {spacing.6}"
  button-primary-hover:
    backgroundColor: "{colors.accent-primary-hover}"
  # The main button on a Forest ground (clash 3). Bone fill, Forest text.
  button-on-brand:
    backgroundColor: "{colors.accent-warm}"
    textColor: "{colors.accent-primary}"
    fontSize: "0.875rem"
    fontWeight: 600
    rounded: "{rounded.control}"
    minHeight: "44px"
    padding: "{spacing.0} {spacing.6}"
  button-secondary:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
    fontSize: "0.875rem"
    fontWeight: 600
    rounded: "{rounded.control}"
    minHeight: "44px"
    padding: "{spacing.0} {spacing.6}"
    border: "1px solid {colors.border-strong}"
  button-secondary-hover:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.accent-primary}"
  # Ghost takes the compact side padding of the mock-up's small button. The height is still 44px.
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    fontSize: "0.875rem"
    fontWeight: 600
    rounded: "{rounded.control}"
    minHeight: "44px"
    padding: "{spacing.0} {spacing.4}"
  # --shadow-card does not exist in styles.css yet. Section 4 defines it and
  # AECI-1750 adds it. The mock-up card fill is white.
  card:
    backgroundColor: "{colors.surface-base}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.card}"
    padding: "{spacing.6}"
    shadow: "var(--shadow-card)"
  input:
    backgroundColor: "{colors.surface-base}"
    textColor: "{colors.text-primary}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    minHeight: "44px"
    padding: "{spacing.0} {spacing.4}"
    border: "1px solid {colors.border-field}"
  # Focus is an outline, because forced-colours mode drops box-shadow.
  input-focus:
    backgroundColor: "{colors.surface-base}"
    textColor: "{colors.text-primary}"
    border: "1px solid {colors.accent-primary}"
    outline: "3px solid {colors.accent-primary}"
    outlineOffset: "3px"
  # The error edge is 2px in the error colour. An icon and a message always come with it.
  input-error:
    backgroundColor: "{colors.surface-base}"
    textColor: "{colors.text-primary}"
    border: "2px solid {colors.status-error}"
  # The one public pill chip (clash 22). Padding runs top, right, bottom, left.
  chip:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
    fontSize: "0.8125rem"
    fontWeight: 400
    rounded: "{rounded.pill}"
    padding: "{spacing.1} {spacing.3} {spacing.1} {spacing.2}"
    border: "1px solid {colors.border-default}"
  chip-selected:
    backgroundColor: "{colors.accent-primary-soft}"
    textColor: "{colors.accent-primary}"
    border: "1px solid {colors.accent-primary}"
  chip-dense:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text-primary}"
    fontSize: "0.8125rem"
    fontWeight: 600
    rounded: "{rounded.pill}"
    padding: "{spacing.1} {spacing.3} {spacing.1} {spacing.2}"
    border: "1px solid transparent"
  badge-pending:
    backgroundColor: "{colors.surface-sunken}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "{spacing.1} {spacing.3}"
  # The public bar meter (clash 19). One hue, no gradient, the number printed beside it.
  meter-track:
    backgroundColor: "{colors.surface-sunken}"
    rounded: "{rounded.pill}"
    height: "6px"
  meter-fill:
    backgroundColor: "{colors.accent-primary}"
    rounded: "{rounded.pill}"
  score-display:
    backgroundColor: "transparent"
    textColor: "{colors.accent-primary}"
    typography: "{typography.figure}"
    padding: "{spacing.0}"
  detail-layout:
    # The band shell (clash 16). Phone values first, then md and up, as
    # browse-layout does. Band padding and page gutter, from the mock-ups.
    # md_padding takes the band padding from md up, but its 48px gutter only
    # from lg up. Between md and lg the gutter is 32px. See "The detail page band shell".
    backgroundColor: "{colors.surface-base}"
    textColor: "{colors.text-primary}"
    padding: "{spacing.16} {spacing.6}"
    md_padding: "{spacing.24} {spacing.12}"
    sectionDivider: "1px solid {colors.border-default}"
  browse-layout:
    # Unchanged by the rulings: the standard canvas, py-8 md:py-12 and px-6 md:px-8.
    backgroundColor: "{colors.surface-base}"
    textColor: "{colors.text-primary}"
    padding: "{spacing.8} {spacing.6}"
    md_padding: "{spacing.12} {spacing.8}"
    sectionDivider: "1px solid {colors.border-default}"
  # Colour references below use the AECI-1747 token keys (surface-footer,
  # surface-hero-panel, border-field and the on-brand washes and borders).
  # The public shell (clashes 26 to 32 and 42, PLAN.md sections 4.7 to 4.10).
  # Starting values from mock-up 6, default state, in
  # docs/design/mockups/redesign-2026-11/mockups/6-product-detail.html. Section 5
  # "Navigation" gives the file line for each and the open values. Colours named
  # as var() are the AECI-1747 tokens, which are not in the colors group above
  # until that issue lands.
  header:
    backgroundColor: "{colors.accent-primary}"
    textColor: "{colors.accent-warm}"
    height: "64px"
    md_height: "76px"
    padding: "{spacing.0} {spacing.6}"
    md_padding: "{spacing.0} {spacing.8}"
    lg_padding: "{spacing.0} {spacing.12}"
  # Sign in hover (the Bone main button on Forest). Forest text is 9.46:1 on it.
  button-on-brand-hover:
    backgroundColor: "{colors.surface-on-brand-hover}"
    textColor: "{colors.accent-primary}"
  # A nav link on Forest. The hover wash is Bone at 10%. Text stays Bone.
  header-link:
    textColor: "{colors.accent-warm}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    padding: "{spacing.3} {spacing.4}"
  header-link-hover:
    backgroundColor: "{colors.surface-on-brand-wash}"
  # Active route: weight 600 and aria-current.
  header-link-active:
    fontWeight: 600
  # Panel-open cue under Browse only.
  active-bar:
    backgroundColor: "{colors.accent-secondary}"
    height: "3px"
    rounded: "3px 3px 0 0"
  # The search field needs its own edge. The wash alone is 1.33:1 on Forest.
  header-search:
    backgroundColor: "{colors.surface-on-brand-wash}"
    textColor: "{colors.text-on-brand-secondary}"
    typography: "{typography.body}"
    rounded: "{rounded.pill}"
    minHeight: "44px"
    padding: "{spacing.0} {spacing.4}"
    border: "1px solid {colors.border-on-brand-strong}"
  header-search-hover:
    backgroundColor: "{colors.surface-on-brand-wash-hover}"
    textColor: "{colors.accent-warm}"
  nav-toggle:
    backgroundColor: "{colors.surface-on-brand-wash}"
    textColor: "{colors.accent-warm}"
    rounded: "{rounded.control}"
    width: "44px"
    height: "44px"
  # The Browse panel and the mobile panel share this white ground.
  menu-panel:
    backgroundColor: "{colors.surface-base}"
    textColor: "{colors.text-primary}"
    rounded: "0 0 {rounded.card} {rounded.card}"
    padding: "{spacing.12} {spacing.12} {spacing.8}"
    shadow: "var(--shadow-menu)"
  # The stuck bar is solid. No blur (clash 13). Once stuck it takes a hairline edge.
  section-nav:
    backgroundColor: "{colors.surface-base}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.body}"
    minHeight: "64px"
    md_minHeight: "72px"
    borderBottom: "1px solid {colors.border-default}"
  section-nav-current:
    textColor: "{colors.text-primary}"
    fontWeight: 600
  section-nav-count:
    textColor: "{colors.text-secondary}"
    fontSize: "0.8125rem"
    fontWeight: 400
  # The footer ground. Ink is Bone. Labels take var(--text-on-footer-secondary).
  footer:
    backgroundColor: "{colors.surface-footer}"
    textColor: "{colors.accent-warm}"
    padding: "{spacing.16} {spacing.0} {spacing.8}"
---

# Design System: AEC Integrations

## 1. Overview

**Creative North Star: "The specifier's reference."**

AECi reads as an editorial industry reference — a published artifact closer in spirit to a printed product specification or a specialist trade journal than to a SaaS landing page. The reader is an AEC professional making a serious decision; the surface should feel built for that job, not built for a marketing demo. Restraint, density, generous whitespace, sentence case, and a serif headline that borrows posture from `ENR` or `Architectural Record` — never from a startup landing page.

The system rejects the AI-startup visual cohort entirely: no purple-to-blue gradients, no glassmorphism, no hero-metric template, no Inter / DM Sans / Plus Jakarta Sans / Geist / Mona Sans / Space Grotesk / IBM Plex Sans / Outfit / Fraunces / Newsreader / Playfair Display / Cormorant / DM Serif / Instrument Serif / Syne. It also rejects the horizontal-SaaS-directory cohort (G2, Capterra, GetApp): no equal-weight feature grids, no logo clouds as proof, no orange-and-cream marketplace cream. Forest, Bone, and Clay carry brand identity as accents; surfaces stay neutral and let content lead.

**Key Characteristics:**

- Editorial restraint over commercial enthusiasm. Sentence case everywhere (one named exception: the overline role, §3).
- Pair a refined serif (Source Serif 4) with an a11y-first sans (Atkinson Hyperlegible Next). The pairing itself is the brand statement. A limited ramp of ten sizes keeps it calm. Weights are 400 and 600, with the exceptions §3 names (clashes 9 and 17).
- Forest is the anchor accent and, in three chrome bands and one feature card, a ground: the header, the hero of a detail page, the footer and a card (clash 1). The reading area between them is white. Bone is a warm-tinted accent surface, one band per page (clash 2), and it is the ink on Forest. Never a page background. Clay is rare (≤5% per screen, decorative/fill only, Clay deep carries meaning-bearing clay). It never fills a button and never carries text (clashes 3 and 4).
- Borders separate controls. One card shadow lifts the cards that float on the page ground, and one menu shadow lifts menus. The modal shadow is the only other shadow. The focus ring is an outline (clash 11, §4). Cards are 24px, controls 12px and chips are pills (clash 12).
- One custom icon set at 1.75 stroke, drawn for the site and served by one component (clash 34, §5 "Icons"). No emoji.
- Motion gives feedback and never decorates: three durations, one easing, no decorative loop (clash 36, §5 "Motion").
- Light only: a single light theme, no toggle and no system-preference detection (AECI-226). The dark reintroduction was dropped — dark is not roadmapped (`STAGE_2_SPEC.md` §9); design once, for light.
- Scope: ruling R2 (2026-11-14) builds the public pages first. Shared components (the header, the footer, the button and the input) are one component on every surface. Portal and admin page bodies wait until Chris has verified the public pages (§5 Components, "Scope").

## 2. Colors

A neutral surface palette with three brand accents (Forest, Clay, Bone) and two near-monochrome text scales. The reading area is white. Forest may fill three chrome bands: the header, the hero of a detail page and the footer (see "Forest grounds" below). Frontmatter values are OKLCH for perceptual uniformity (and to enforce Impeccable's color doctrine); each color's documented hex equivalent is the intended sRGB value used by `apps/web/src/styles.css` and `docs/BRAND_GUIDELINES.md`. Every opaque token renders its documented hex exactly; `design-tokens.hex.guard.spec.ts` pins it.

The redesign rulings of 2026-11-13 (`docs/design/mockups/redesign-2026-11/records/design-rulings.md`) changed this section. A clash number beside a rule means that ruling set it. Where a ruling left a value open, AECI-1747 settled it under "Settled values". Light theme only still holds: no dark theme, no `dark:` variants.

### Primary

- **Forest** (`#1E3A2F` / `oklch(32.24% 0.0397 166.73)`): the primary brand color. CTAs, links, headings, the connector mark, primary badges. Hover state is **Forest Hover** (`#2E5C45` / `oklch(43.47% 0.0641 160.30)`) — measurably brighter, never a synthetic opacity reduction. Forest is also a ground: it may fill the header, the hero of a detail page and the footer (clash 1), and it is the fill of a pressed toggle (clash 5).
- **Forest soft** (`#ECF1EE` / `oklch(95.35% 0.0066 160.07)`): the Forest *wash* — fills for selected facets, selected filter chips (clash 5), verified-soft and info states. It is never a page band (clash 2). It is how Forest registers at rest without recoloring text. A wash, not a boundary (1.14:1 against white): always paired with a border or another selected-state affordance. Forest text on it measures 10.80:1.

### Secondary

- **Clay** (`#E89668` / `oklch(74.64% 0.1164 49.55)`): warm secondary accent — **decorative and fill only**. Strokes and accents are its job: the connector mark, the hero ribbon, accent strokes. It never fills a button (clash 3) and never carries text (clash 4). Existing badge fills stay, carrying `text-primary` at 8.48:1 — never white text, which is 2.33:1. It measures ~2.3:1 on white, below even the 3:1 large-text/non-text floor, so it can never carry text or meaning-bearing graphics — see the Clay restriction below.
- **Clay deep** (`#A14D22` / `oklch(51.86% 0.1245 45.13)`): the text-capable member of the Clay family — clay-colored text and icons. 5.83:1 on white, 5.59:1 on raised, 5.21:1 on Bone. Doubles as the warning hue. It stays the onboarding series colour in rating displays (clash 4). The token is `--accent-secondary-deep`, and all four final mock-ups use it. It is not the colour of kicker icons, facet-heading icons or the focus ring on public pages (clash 4).

### Rating

- **Goldenrod** (`#DAA520` / `oklch(75.16% 0.1469 83.99)`): the gold-star fill for rating glyphs (`<aec-review-stars>` and the review-form rating listboxes) — token `--accent-rating`. The conventional gold star, tuned warm to sit with the Clay/Bone family rather than a neon yellow. It measures 2.24:1 on white, *below* the 3:1 meaning-bearing-graphic floor — permitted because the star glyphs are **decorative** (`aria-hidden`): the rating is carried by the `aria-label` (and, in displays, the adjacent numeral), never by glyph color alone. In read-only displays (`<aec-review-stars>`, vendor-detail) empty stars use **Border strong** `#D4D4D8` as a faint track so the gold reads against it. The **interactive review-form picker** instead uses **Text tertiary** `#71717A` for unselected stars: it has no adjacent numeral and renders fully unselected on first load, so a faint `#D4D4D8` track would leave the whole control near-invisible until hovered. (The dedicated Goldenrod gives ratings their own recognizable color and frees Clay deep to mean "text-capable clay / warning.")

### Tertiary

- **Bone** (`#F5F2EA` / `oklch(96.13% 0.0111 89.72)`): warm-tinted *accent surface*. One tinted band per page, for its key section (clash 2). **Not a page background.** On a Forest ground Bone is also the ink: text and the fill of the main button (clashes 3 and 4).

### Neutral

- **Surface base** (`#FFFFFF` / `oklch(100% 0 0)`): default page background.
- **Surface raised** (`#FAFAFA` / `oklch(98.43% 0 0)`): cards, panels.
- **Surface sunken** (`#F4F4F5` / `oklch(96.74% 0.0013 286.38)`): inset wells, code blocks, secondary states.
- **Surface muted** (`#F4F4F5` / `oklch(96.74% 0.0013 286.38)`): interactive row hover / `focus-within` highlight on index tables. Shares the surface-sunken value by design — the two never co-occur inside a row, and a hover wants the same one-step lift sunken gives on white.
- **Border default** (`#E4E4E7` / `oklch(91.97% 0.0036 286.32)`): standard separators. A 1px hairline on the redesigned public components (mock-up 6, line 130, and mock-up 7, line 1133). Some shipped surfaces still draw 0.5px and change as each is rebuilt.
- **Border strong** (`#D4D4D8` / `oklch(87.20% 0.0055 286.32)`): emphasized borders (focus, featured states).
- **Field edge** (`#84848D` / `oklch(61.63% 0.0134 286.00)`, `--border-field`): the redesign's border for every form control (PLAN.md §4.1). 3.71:1 on white, 3.55:1 on raised, 3.37:1 on sunken, 3.31:1 on Bone. It sits beside Border input until AECI-1764 retires the old one. It fails on the hero panel (2.77:1) and on Forest hover (2.07:1).
- **Border input** (`#8A8A93` / `oklch(63.63% 0.0133 286.02)`): the boundary of a form control, the edge that tells the reader "type here" or "choose here". 3.42:1 on white, 3.28:1 on raised, 3.11:1 on sunken, so it meets WCAG 1.4.11's 3:1 for user-interface components. `border-default` measures about 1.25:1 and stays the separator token. Applied by the unlayered `.aec-field-control` class in `styles.css` (AECI-1296), which `FIELD_INPUT_CLASS` and the `aec-select` trigger carry. A border-colour utility would not apply.
- **Text primary** (`#0A0A0A` / `oklch(14.48% 0 0)`): body and headings. Near-black, not pure black — gentler against bright surfaces, lower halation.
- **Text secondary** (`#52525B` / `oklch(44.19% 0.0146 285.79)`): supporting prose, captions.
- **Text tertiary** (`#71717A` / `oklch(55.17% 0.0138 285.94)`): hints, placeholders, metadata. Re-pointed from `#A1A1AA` in AECI-230 — the old value measured 2.56:1 on white, failing even the 3:1 large-text floor. Now 4.83:1 on white, 4.63:1 on raised. **Never on sunken/muted surfaces** (4.40:1 there) — step up to text secondary.

### Status

- **Error** (`#B3261E` / `oklch(50.13% 0.1783 28.70)`): form/validation error text and icons, **and the `conflict` agreement badge** (6.54:1 on white). Always paired with an inline message or icon — color is never the sole signal. Success states use Forest; warning states use Clay deep. No additional status hues exist.
  - **The scope widened in AECI-605** from form/validation only. `conflict` — two vendors describing the same data flow differently — is the **one non-form state permitted to be red**, and the only red state in the agreement set (`STAGE_2_ATTESTATIONS_SPEC.md` §4.3). It is red because it is genuinely actionable for the reader, not because anything is broken: the copy names the disagreement ("Vendors disagree") rather than faulting either product. It carries an `✕` glyph alongside the hue so it survives greyscale and colour-vision deficiency. Do not extend Error to any further state without a spec decision — `unverified` and `single_source` are deliberately neutral, and making an unconfirmed claim look like a defect is the failure mode this system is built to avoid.
  - **Admin claim account conflict (AECI-1420, 2026-10-19).** A second sanctioned red, on admin surfaces only. When a claimant's address is a site admin or holds a seat on another vendor, `/admin/claims` and `/admin/claims/:id` show a box with the Error border (`.aec-notice-error`), a `--surface-raised` surface and an icon, and the queue disables Grant. It is red because the grant will be refused. Spec: `STAGE_2_VENDOR_PORTAL_SPEC.md` §5. No tinted Error surface token exists, so none was added.
  - **Admin email-domain signal (2026-11-02).** A third sanctioned red, on admin surfaces only. `<aec-domain-match-signal>` (`admin/claims/domain-match-signal.ts`), shared by `/admin/claims` and `/admin/claims/:id`, shows "Domain mismatch" as bold Error text with a red X. It is red because it is the fact an operator must act on before granting. "Domain matches" is bold primary text with a Forest check. "Manual review" and "Domain check pending" are bold primary text with no icon. All four are `text-xs`, and the words carry the meaning, so the icons are `aria-hidden`. Spec: `STAGE_2_VENDOR_PORTAL_SPEC.md` §5.

### Forest grounds (clashes 1 to 6)

Forest and its companions fill three chrome bands. Every pairing on them states its contrast floor. Ratios below are WCAG 2 relative-luminance ratios computed from the hex values, to two decimals.

| Role | Hex | Where it may be used | Ink on it |
| -- | -- | -- | -- |
| Forest | `#1E3A2F` | Header, hero of a detail page, footer, one feature card, primary buttons, pressed toggles | Bone 11.03:1, white 12.34:1 |
| Forest hover | `#2E5C45` | Hover states, the soft single-colour glow in the hero (existing `--accent-primary-hover`) | Bone 6.87:1 |
| Hero panel (`--surface-hero-panel`) | `#26473A` | Panels sitting on the Forest hero | Bone 9.18:1 |
| Footer ground (`--surface-footer`) | `#15291F` | Footer only | Bone 13.71:1 |
| Bone | `#F5F2EA` | One band per page, ink on Forest, the main button on Forest | Forest 11.03:1 |

Floors that hold on every ground in the table:

- Text needs 4.5:1. Large text and meaning-bearing graphics need 3:1.
- The hero panel against Forest is 1.20:1, so a panel edge is a surface cue, not a boundary. A panel that holds a control needs its own 3:1 edge. Field edge on the hero panel is 2.77:1, so a control placed on a hero panel needs a filled background to keep a 3:1 boundary.
- Clay on Forest measures 5.29:1. Clay is a stroke or accent there and still carries no text (clash 4).
- The `--text-tertiary` restrictions stand. It is never on Forest, hero panel, footer ground, Bone, sunken or muted surfaces.
- Any text colour on a Forest ground other than Bone, `--text-on-brand-secondary` and `--text-on-footer-secondary` is not allowed. The measured pairings are under "Settled values".

The rules the rulings set:

- **Forest ground (clash 1, new).** Forest may fill the header, the hero of a detail page and the footer. The reading area stays white. This rewrites the Surfaces-Are-Neutral Rule (see Named Rules).
- **A Forest feature card (clash 1, new).** The clash 1 record is titled "Forest as a full-bleed ground for the header, hero, footer and feature cards". Its new design reads "`.know` (page 8) and `.cm-card` are Forest cards" (`records/design-clashes.md`, lines 9 and 11). Chris ruled NEW, so the new design wins. Ruling R4 dropped `.cm-card`, the Browse menu's card. What remains is the "Know of one?" card in mock-up 8 (`.know`, `8-product-none.html`, line 1100). It is a card, not a band: 24px radius, 32px padding, the card shadow, a Forest fill, Bone ink and the Bone main button (`btn-hero`, `--cta-bg: #F5F2EA`, mock-up 6, lines 12 and 90). The mock-ups draw at most one per page. So the limits are: a card and never a full-bleed band, Bone ink, the Bone main button, and one per page. Its secondary text in the mock-up is `#C5D3CA`, which §2 has not measured ("Any text colour on a Forest ground other than Bone is not measured here"). The shipped plan panel (`aec-plan-cta-panel`) is such a card (§5 "Plans calls to action"). ADR 0056 says "Forest may fill the header, the detail page hero and the footer" and omits the feature card.
- **One Bone band (clash 2, blend).** The body is white. One Bone band per page. No Forest-soft bands, no deep-green bands, no alternating bands.
- **Buttons on Forest (clash 3, blend).** Clay never fills a button. On Forest the main button is Bone with Forest text. Everywhere else the main button stays Forest with white text.
- **Clay and text (clash 4, blend).** Clay does not carry text. Product names highlighted on Forest are Bone. Clay deep stays the onboarding series colour. Kicker icons, chip fills and the focus ring do not take Clay.
- **Selected states (clash 5, blend).** A pressed toggle or segmented control is solid Forest with white text (12.34:1). A selected filter chip keeps the Forest-soft wash, with a border or other selected-state cue. The view toggle is Forest, never near-black.
- **Tokens only (clash 6, blend).** Every colour is a named OKLCH token in `apps/web/src/styles.css`. The new surfaces (hero panel, footer ground) are tokens, and so is every alpha the mock-ups mixed with `color-mix()`. The mock-up's other loose values are dropped, including its extra band, soft-accent, empty-star, venn and meter tokens. No `color-mix()` in components, no tinted shadows, no hex in components, and no Tailwind opacity modifier on a colour utility (`text-(--surface-base)/70`): it mints an alpha nobody measured and blends it in OKLab. The lint (root `eslint.color-patterns.mjs`, and `apps/web/scripts/check-source-constraints.mjs` for `.html` and `.css`) catches colour literals and opacity modifiers. A `color-mix()` over two tokens is review-only.
- **Field edge (PLAN.md §4.1 and clash 23, not clash 6).** `#84848D` is the border of every form control. It is the token `--border-field`. The inputs work (AECI-1764) applies it.

Scope: ruling R2 (2026-11-14) builds the public pages first. Shared components (the header, the footer, the button and the input) are one component on every surface (Chris, 2026-11-14, see §5 Components, "Scope"). Portal and admin page bodies wait until Chris has verified the public pages, and take the new tokens and nothing more until then.

### Settled values (AECI-1747)

These were open after the rulings. The tokens are in `apps/web/src/styles.css` with their ratios beside them. Ratios are WCAG 2, to two decimals. Text needs 4.5:1, large text and boundaries 3:1.

- **Token names.** Hero panel `--surface-hero-panel`, footer ground `--surface-footer`, field edge `--border-field`, Bone ink on Forest `--text-on-brand` (an alias of `--accent-warm`).
- **Field edge and Border input.** They sit side by side. `--border-input` (`#8A8A93`) is unchanged and AECI-1764 retires it.
- **Other inks on Forest.** `--text-on-brand-secondary` (`#C5D3CA`): 7.96:1 on Forest, 6.62 on the hero panel, 9.89 on the footer ground, 4.96 on Forest hover. `--text-on-footer-secondary` (`#B9C7BF`): 8.76:1 on the footer ground, 7.04 on Forest, 5.86 on the hero panel. It is not allowed on Forest hover (4.39:1). Tertiary text is never allowed on a Forest ground.
- **Focus ring on Forest.** Bone, `--focus-ring-on-brand` (an alias of `--accent-warm`): 11.03:1 on Forest, 6.87 on Forest hover, 9.18 on the hero panel, 13.71 on the footer ground.
- **The four drifted tokens.** Forest, Forest hover, Clay and Bone now render the hex this file documents. The OKLCH values changed, the hex did not.
- **Mock-up values kept as tokens.** `--surface-on-brand-hover` (`#E7E1D2`, the one hover for the Bone main button on Forest, Forest text 9.46:1), `--surface-hero-ribbon` (`#3B6E55`, 2.08:1 on Forest, decorative only), `--surface-sunken-hover` (`#DADADC`), `--border-underline` (`#B5B5B5`, 2.05:1 on white) and `--border-empty` (`#C6C6CA`, 1.70:1 on white). The last two are never the only cue.
- **Alphas on Forest.** Bone at 10% `--surface-on-brand-wash` (fills), 16% `--surface-on-brand-wash-hover`, 14% `--border-on-brand-subtle` (hairlines), 32% `--border-on-brand`. Bone at 50%, `--border-on-brand-strong`, is the only on-Forest alpha that is a 3:1 edge: 4.01:1 on Forest, 3.61 on the hero panel, 4.53 on the footer ground. Forest hover at 75% and 45% are `--surface-hero-glow` and `--surface-hero-glow-soft`. White at 94% is `--surface-sticky`. White-ground hairlines use `--border-default`, and the selected-count wash uses `--accent-primary-soft`.
- **Mock-up tokens dropped.** `hero-accent-hover`, `hero-accent-ink`, `star-empty`, `venn-a`, `venn-b`, `accent-soft`, `meter-a`, `meter-b`, `logo-clay`, the Forest 16% focus halo of `.field:focus` (the focus ring replaces it) and Forest at 40%, which only the `html.r-btn-orig` restore toggle uses.

### Dark theme — dropped from the roadmap (not shipped)

The dark palette was removed from the active design system in **AECI-226**: AECi ships light only (see the "Light only" rule below). The Stage 2 dark-theme reintroduction was subsequently **dropped** (epic AECI-517 canceled; `STAGE_2_SPEC.md` §9) — dark is **not roadmapped**. The brand-approved dark Forest / Clay / Bone variants stay documented in `docs/BRAND_GUIDELINES.md` §3, and the prior OKLCH dark token set is preserved in git history, so *should* a later stage ever revisit dark it would be a token-block + toggle change — every component consumes the semantic tokens (`--surface-*`, `--text-*`, `--accent-*`), not a per-component rework — but nothing is planned.

### Named Rules

**The Surfaces-Are-Neutral Rule** (rewritten by clashes 1 and 2, see ADR 0056). The reading area is neutral. The `<body>` is `#FFFFFF`. Forest may fill the header, the hero of a detail page, the footer and a Forest feature card, and nothing else. Bone is *not* a page background. It is one warm-tinted band per page. Forest soft is never a band. The old form of this rule banned every brand colour as a ground. That ban is lifted for those three Forest bands and the feature card only.

**The Forest-Anchor Rule.** Forest is the primary brand accent and the anchor of the system. Every CTA, every link, every heading color, every primary badge fill: Forest. No alternative primary color exists — proposals for "a second primary" are rejected. One change (clash 3): on a Forest ground a Forest button vanishes, so the main button there is the inverse, Bone with Forest text. It is still the one primary action, and it is not Clay.

**The Clay-Restriction Rule.** Clay is the rarest color in the system. ≤5% of any screen. Clay `#E89668` is **decorative and fill only**: the connector mark, accent strokes, and badge fills carrying `text-primary` (8.48:1) — never white text (2.33:1). It measures ~2.3:1 on white, which fails not just AA body text but the 3:1 floor for large text and meaning-bearing graphics — the former "large-text allowed" clause was mathematically false and was struck in AECI-230. Anything clay-colored that *carries meaning* — text, icons — uses **Clay deep** `#A14D22` (5.83:1). (Star-rating glyphs are *not* clay: they use the dedicated **Goldenrod** `--accent-rating` — see the Rating palette above.) Clay never fills a CTA: the Forest-Anchor Rule owns every CTA, including the Bone-on-Forest inverse (clash 3). Clay does not carry text on any ground, so highlighted names on Forest are Bone (clash 4). Kept unchanged by the rulings: the 5% cap and the Clay deep rule for anything meaning-bearing. Keeping Clay rare preserves its meaning as the high-emphasis accent. (The brand policy would carry forward to Dark Clay if dark is ever revisited; dark theme is not currently roadmapped — the Stage 2 reintroduction was dropped.)

**The No-Pure-Black-Or-White Rule.** `#000` and `#fff` never appear in this system. The text-primary token is `#0A0A0A` (a near-black) on a `#FFFFFF` surface base. Pure-black-on-pure-white is harsher than the near-tones and creates unnecessary halation. (The same principle would govern the dark variants documented in `BRAND_GUIDELINES.md` §3 if dark is ever revisited; it is not currently roadmapped.)

**The Anchor-Site Rule.** When a surface uses a Mobbin reference site as its theme, components for that surface come from the *same* Mobbin site. Pulling components from a second site is a deliberate exception, not a default — and the originating theme site remains the visual anchor for composition, hierarchy, density, and atmosphere. This protects editorial coherence: AECi reads as one publication, not a mashup of unrelated apps. Record the anchor site with the surface (Linear issue or commit message) so future iterations stay aligned. Access Mobbin via the `mcp__mobbin__*` MCP server — see `CLAUDE.md` §"MCP usage rules" for auth flow and the matching design-checklist step.

**The redesign's anchor (clash 44, current).** Chris ruled CURRENT on clash 44 and left no note: the rule stands, and every surface records an anchor. The redesign's mock-ups are the anchor for the new language: `docs/design/mockups/redesign-2026-11/mockups/` (the empty pair page, the product page, the product with many integrations and the product with none), with `PLAN.md` §4 as the written form. Use Mobbin only for components the mock-ups do not cover (`PLAN.md` §9.1). The mock-ups draw the header and the footer, so they are the anchor for site chrome too. The earlier anchors stay recorded only for surfaces the mock-ups do not cover: the home page and the browse lists, until their mock-ups are approved (AECI-1789 and AECI-1790). A precedent for an in-repo mock-up as the anchor is the Free plan surfaces (§5 "Vendor portal (Stage 2)").

## 3. Typography

**Display Font:** Source Serif 4 (with Georgia, "Times New Roman", serif fallback)
**Body Font:** Atkinson Hyperlegible Next (with system-ui, -apple-system, "Segoe UI", sans-serif fallback)
**Label Font:** Atkinson Hyperlegible Next (same family as body, distinct role via size + weight)

The redesign rulings of 2026-11-13 changed this section (clashes 7 to 10 and 17). A clash number beside a rule means that ruling set it. The fonts did not change. The scope sentence under "Forest grounds" in §2 applies to this section too: ruling R2 builds the public pages first. Shared components (the header, the footer, the button and the input) are one component on every surface. Portal and admin page bodies wait until Chris has verified the public pages (§5 Components, "Scope"). Values the rulings left open are listed under "Open values (set by AECI-1748 and AECI-1749)".

**Character:** Source Serif 4 carries the editorial / industry-publication posture of a printed reference — calmer and more grounded than the SaaS-default sans cohort, but without the stylized affectation of the reflex-reject serifs (Fraunces, Playfair Display, Cormorant, DM Serif, Instrument Serif). Atkinson Hyperlegible Next is an a11y-first sans designed by the Braille Institute for low-vision readers; pairing it with a serif display face makes the trust/transparency principle visible in the typography itself. The pairing is the brand statement: a system that treats the reader's vision as a constraint to engineer for, not an afterthought to "support."

> **Why Next (AECI-230):** the classic Atkinson Hyperlegible ships only 400/700, so this system's 500 (chips) and 600 (labels) weights could not actually render — CSS font matching silently resolved 500 to 400. Atkinson Hyperlegible Next is the Braille Institute's expanded release (loaded as a 400–700 variable font), making every specified weight real. Same lineage, same a11y story.

### The type ramp (clashes 9 and 17)

Chris's note on clash 17: "I do believe we have too many font sizes and variants, see what it looks like to limit them." The plan's answer is one limited ramp. The audit of the mock-ups went from 36 distinct sizes to 10, and from 9 weights to 5 (`PLAN.md` §4.2). Clash 9 was ruled as a blend. Once AECI-1748 and AECI-1749 land, every size on a public page is one of these ten tokens.

| Token | Size | rem | Family | Use |
| -- | -- | -- | -- | -- |
| `--t-12` | 12px | 0.75 | Sans | Overlines, captions |
| `--t-13` | 13px | 0.8125 | Sans | Chips, counts, small labels |
| `--t-14` | 14px | 0.875 | Sans | Buttons, secondary text |
| `--t-16` | 16px | 1 | Sans | Body, nav links |
| `--t-20` | 20px | 1.25 | Both | Lede text, card titles |
| `--t-24` | 24px | 1.5 | Serif | Sub-headings |
| `--t-36` | 28 to 36px, fluid | 1.75 to 2.25 | Serif | Section headings |
| `--t-fig` | 28 to 40px, fluid | 1.75 to 2.5 | Serif | Score and count figures |
| `--t-statement` | 34 to 56px, fluid | 2.125 to 3.5 | Serif | The pair page statement |
| `--t-display` | 40 to 72px, fluid | 2.5 to 4.5 | Serif | The product name |

rem is px divided by 16. Once AECI-1748 and AECI-1749 land, no other size is allowed on a public page. The mock-ups hold 19px and 22px serif and 12.5px sans only under their `html.r-type-orig` restore toggle, not in the default state. AECI-1749 snaps any that reach the build to the ramp.

- **Weights are 400 and 600** (clash 9). Bold 700 stays only for inline emphasis, as before. Weight 500 survives on exactly two chips that copy the live site: the maintenance marker (`.mchip`) and the agreement badge (`.agree`). Both are 12px at 500, matching §5 Badges "The public chip". They stay at 12px, which is already today's smallest text size. It is not a general weight.
- **What may sit at `--t-12`.** Overlines, the two 500 chips above, and field captions (12px, 20px line height). Counts sit at `--t-13` (`PLAN.md`).
- **Tailwind mapping (AECI-1748).** Every `text-*` size utility resolves to a ramp token. `styles.css` overrides Tailwind's `--text-*` theme variables, so the call sites did not change. Each step keeps Tailwind's own line height, so no multi-line text lost leading. The mapping changes as little as it can: five steps keep their pixels. This applies on every surface, the vendor portal and admin included.

  | Utility | Before | Token | After, 320 / 768 / 1280 / 1920px wide | Line height |
  | -- | -- | -- | -- | -- |
  | `text-xs` | 12px | `--t-12` | 12px, unchanged | 16px (1.333) |
  | `text-sm` | 14px | `--t-14` | 14px, unchanged | 20px (1.429) |
  | `text-base` | 16px | `--t-16` | 16px, unchanged | 24px (1.5) |
  | `text-lg` | 18px | `--t-20` | 20px | 1.556, so 31px |
  | `text-xl` | 20px | `--t-20` | 20px, unchanged | 28px (1.4) |
  | `text-2xl` | 24px | `--t-24` | 24px, unchanged | 32px (1.333) |
  | `text-3xl` | 30px | `--t-36` | 28 / 29.3 / 34.4 / 36px | 1.2 |
  | `text-4xl` | 36px | `--t-36` | 28 / 29.3 / 34.4 / 36px | 1.111 |
  | `text-5xl` | 48px | `--t-fig` | 28 / 31.2 / 40 / 40px | 1 |
  | `text-6xl` to `text-9xl` | 60 to 128px | `--t-display` | 45.7 / 56.4 / 68.7 / 72px | 1 |

  - **`text-lg` lands on `--t-20`, not `--t-16`.** Most `text-lg` call sites are serif names and titles. Dropping them to 16px would break the Serif-Floor Rule, and `--t-20` is the card-title step. The sans ledes at `text-lg` carry `leading-relaxed`, so they keep 1.625.
  - **`text-3xl` and `text-4xl` both land on `--t-36`.** It is the nearest step at every width, and both are used as section headings and figures. The common `text-3xl md:text-4xl` pair now renders one fluid size.
  - **`text-5xl` lands on `--t-fig`.** Its only live use off a heading is the vendor portal's glance figure, which is a Figure. At `--t-statement` it rendered 56px at 1440px, larger than the portal's h1.
  - **`text-6xl` to `text-9xl` are unused.** They land on `--t-display` so no utility can render off the ramp.
  - **The ramp itself is exposed as `text-t-12` to `text-t-display`**, each with its role's line height: 20px for `--t-12` (the field caption), 1.4 for `--t-13`, 1.5 for `--t-14`, 1.6 for `--t-16`, 1.5 for `--t-20`, 1.25 for `--t-24`, 1.1 for `--t-36` and `--t-statement`, and 1 for `--t-fig` and `--t-display`. New code uses these names. A role that needs another leading at the same size adds a `leading-*` utility.
  - **A `text-*` utility on an `h1`, `h2` or `h3` element is still dead.** See the Unlayered-Heading Rule. Most `text-3xl` to `text-5xl` call sites sit on headings, so the remap does not move them.
- **Serif never sits on a sans-only step.** `--t-12` to `--t-16` are sans. Serif starts at `--t-20`.

### Hierarchy

- **Display** (Source Serif 4, 400): clash 7 (new) allows it on detail pages, where it is the product name at `--t-display`, 40 to 72px fluid. Start values from the mock-up: line-height 1, tracking -0.02em. The About and Home heroes declare today's Display clamp (`clamp(2.25rem, 4.5vw + 1rem, 4rem)`, line-height 1.05, tracking -0.01em), because clash 7 rules only on detail pages. That clamp does not render: both heroes put it on the `h1` element, and the unlayered `h1` rule beats it, so they show the h1 size (`--t-fig`, 28 to 40px, weight 600). AECI-1847 moves the size onto an inner `<span>`. The home hero is re-decided in its own mock-up issue (AECI-1789). The vendor masthead stays Display, as clash 7's recommendation names vendor pages. Used at most once per page. Statement is the pair page's Display use and counts toward that once. An H1 at this size follows the Unlayered-Heading Rule: put the size on an inner `<span>`.
- **Statement** (Source Serif 4, 400, `--t-statement`, 34 to 56px fluid, line-height 1.1, tracking -0.02em): the pair page statement, its H1 (clash 7, new). It is the pair page's one display-scale line.
- **Figure** (Source Serif 4, 600, `--t-fig`, 28 to 40px fluid, line-height 1, tracking -0.01em): score and count figures (clashes 8 and 9). **One large figure per band** (clash 8, blend). The figure is Forest and sits at the Score Display role (§5 → Score Display). Every other number in the band drops to inline text. The hero-metric template stays banned (§6).
- **Section** (Source Serif 4, 600, `--t-36`, 28 to 36px fluid, line-height 1.1, tracking -0.02em): section headings, the H2 on a detail page. Clash 9's blend added a larger section-heading role to the system. This is it.
- **Headline** (Source Serif 4, 600, `--t-fig`, 28 to 40px fluid, line-height 1.15, tracking -0.005em): page H1 on content pages that are not detail pages. AECI-1748 put the global `h1` rule on `--t-fig`. Its clamp is the pre-ramp h1 value, `clamp(1.75rem, 2.5vw + 0.75rem, 2.5rem)`, so no h1 moved.
- **Title** (Source Serif 4, 600, `--t-24`, 1.5rem / 24px, line-height 1.25): sub-headings and section H2 within long-form content.
- **Card title** (Source Serif 4, 600, `--t-20`, 1.25rem / 20px, line-height 1.1): the name on a card (`.card .nm` in the mock-up).
- **Lede** (Atkinson Hyperlegible Next, 400, `--t-20`, 1.25rem / 20px, line-height 1.5): lede text under a heading (clash 9, blend). The mock-ups set it in the body sans. The blend named a lede role of about 1.1875rem. The ramp snaps it to 20px.
- **Body** (Atkinson Hyperlegible Next, 400, `--t-16`, 1rem / 16px, line-height 1.6): default body and reading text, and nav links. Measure (65 to 75ch) caps prose blocks, never the page shell; see the Page-Width Rule below. **Use 700 (Bold) only for inline emphasis** — never for headings (those are Source Serif 4).
- **Caption** (Atkinson Hyperlegible Next, 400, `--t-14`, 0.875rem / 14px, line-height 1.5): metadata, hints, timestamps, helper text. Defined as a role so components stop improvising this size. `PLAN.md` also lists "captions" at `--t-12`. Field captions take `--t-12` (below). Which other captions do is open.
- **Label** (Atkinson Hyperlegible Next, 600, `--t-13`, 0.8125rem / 13px, line-height 1.4, tracking +0.01em): dense chips, counts, table headers, status badges (verified / pending), form field labels. Sentence case (not uppercase — see the rule below). Moved 700 → 600 in AECI-230: with a real 600 cut available, the calmer weight is the premium read at 13px. The taxonomy chip is weight 400 in the mock-up, so the 500 this section used to state for it no longer holds. §5 → Tags / taxonomy chips now records 400. Button text is `--t-14` in the ramp. The button size and weight belong to the button ruling (clash 20), which §5 owns.
- **Overline** (Atkinson Hyperlegible Next, 600, `--t-12`, 0.75rem / 12px, line-height 1.4, tracking +0.08em, **uppercase**; clash 10, current): eyebrows, kickers, and sidebar microheadings ("Vendor", "Categories", "Filters", "At a glance") — the print-kicker role and the *only* sanctioned uppercase in the system (see the Sentence-Case Rule). Clash 10 kept this rule and changed the mock-up. Every kicker and microheading, including the Browse menu's, uses `.aec-overline`. The mock-up's sentence-case 14px kickers, its 12.5 to 13px bold microheadings and its 11px menu overline are dropped. So are the Clay-deep kicker icons (clash 4). Shipped as the `.aec-overline` class in `styles.css`; apply it on whatever element carries the right semantics (often `h2`/`h3` — the class beats the global heading serif rule, which is the point). Default color text secondary on a light ground. Forest for emphasis. The overline colour on a Forest ground is open (set by AECI-1747).

Floors that hold whatever the ramp: the smallest text is 12px, body is 16px, prose measure is 65 to 75ch, and all text meets AA contrast (§2). No token goes below `--t-12`.

**Fluid tokens use rem.** Each fluid bound is in rem, and the middle term is rem plus vw. Each doubles by 300% zoom at every window width (WCAG 1.4.4; 300% is Safari's limit). Do not copy the mock-ups' `clamp(40px, 5vw, 72px)` style values. Px bounds and a viewport-only middle term ignore the reader's font size and zoom.

### Settled values (AECI-1748)

AECI-1748 confirmed the weights, line heights and tracking stated above. They are the values measured from mock-up 6: Display 400, 1, -0.02em; Statement 400, 1.1, -0.02em; Section 600, 1.1, -0.02em; Figure 600, 1, -0.01em; Lede sans 400, 1.5; field caption 12px on a 20px line. It settled these too:

- **The fluid clamps.** All four use rem bounds and a rem-plus-vw middle term, and all reach their upper bound by 1440px, the mock-up canvas. `--t-36` leaves its lower bound at 640px. `--t-fig` keeps the pre-ramp h1 clamp, which runs from 640px to 1120px and equals the mock-up's `2.5vw + 12px`. `--t-statement` and `--t-display` need a larger rem share to double by 300% zoom: the rem term is at least half the upper bound, and the vw term is the upper bound minus the rem term, divided by 1440.

  | Token | `clamp()` | 320px | 768px | 1280px | 1920px | Doubles at zoom: 1280 / 1920px window, worst width |
  | -- | -- | -- | -- | -- | -- | -- |
  | `--t-36` | `clamp(1.75rem, 1vw + 1.35rem, 2.25rem)` | 28 | 29.3 | 34.4 | 36 | 246% / 244%, 257% |
  | `--t-fig` | `clamp(1.75rem, 2.5vw + 0.75rem, 2.5rem)` | 28 | 31.2 | 40 | 40 | 286% / 267%, 286% |
  | `--t-statement` | `clamp(2.125rem, 1.8vw + 1.875rem, 3.5rem)` | 35.8 | 43.8 | 53 | 56 | 277% / 258%, 287% |
  | `--t-display` | `clamp(2.5rem, 2.4vw + 2.375rem, 4.5rem)` | 45.7 | 56.4 | 68.7 | 72 | 281% / 258%, 290% |

  Sizes are CSS px at 100% zoom. Browser zoom shrinks the CSS viewport and grows the rem, so a fluid size grows less than the zoom factor until it reaches its lower bound. Each token doubles by 300% zoom at every width, which is Safari's zoom limit. `design-tokens.guard.spec.ts` checks every window from 320px to 4000px. The last column gives the zoom where each token doubles, and the worst case over all widths. WCAG 1.4.4 asks that text can reach 200%. It does not require that at exactly 200% zoom.
- **The Tailwind mapping.** The table is under "The type ramp" above.
- **The Headline token** is `--t-fig`.
- **The global heading rules** sit on ramp tokens at the same pixels as before: `h1` at `--t-fig`, `h2` at `--t-24`, `h3` at `--t-20`. They stay unlayered. See the Unlayered-Heading Rule.
- **The `/docs` headings snapped to the ramp.** The page title went from 30px to `--t-36`, the article h2 from 22px to `--t-24` and the article h3 from 18px to `--t-20`.
- **Weight 500 left the public pages** except the maintenance marker and the agreement badge. AECI-1748 moved the public and shared templates' `font-medium` to `font-semibold`, keeping the emphasis the author meant. An in-text link takes no weight class at all, because it inherits the sentence's type (the Link Treatment Rule). It left 500 on surfaces another issue rebuilds: chips (AECI-1763), buttons and toggles (AECI-1758 to AECI-1762), tabs and section navs (AECI-1768), and the header and menus (AECI-1771, AECI-1774, AECI-1775). The vendor portal and admin were not edited.

### Open values (set by AECI-1749)

- Any stray size that reaches the build snaps to the ramp (AECI-1749). That covers the arbitrary `text-[…]` sizes and the `.aec-plan-price` 32px figure in `styles.css`.

### Named Rules

**The Sentence-Case Rule.** Headings, buttons, labels, navigation, table headers, page titles, section titles — all sentence case. Title Case reads as marketing copy; sentence case reads as editorial copy. This rule has exactly **one named exception: the overline role** (above) — uppercase via CSS `text-transform`, never in source strings. Eyebrows, kickers, and sidebar microheadings are overlines; *nothing else* is uppercase. Table headers and breadcrumbs are explicitly **not** overlines — they are sentence case (the uppercase table-header treatment that contradicted this rule was struck in AECI-230).

**The Serif-Floor Rule.** Source Serif 4 never renders below 1.125rem / 18px. Anything smaller is by definition a label, overline, or caption — Atkinson territory. (The global `h1,h2,h3` serif rule in `styles.css` makes small serif easy to leak; the `.aec-overline` class on small headings is the standing fix — AECI-230.) Still holds under the ramp (clashes 9 and 17), and the real floor is now 20px: the smallest serif step is `--t-20`, and `--t-12` to `--t-16` are sans. AECI-1748 moved the `/docs` article h3 from 18px to `--t-20`.

**The Unlayered-Heading Rule.** The `h1, h2, h3` block in `styles.css` (family, weight, **and size**) sits **outside any `@layer`**, and unlayered declarations beat every layered one regardless of specificity. Tailwind v4 ships its utilities in `@layer utilities`, so **a `text-*` utility written directly on an `h1`/`h2`/`h3` is silently dead** — the element keeps the global size (h1 `--t-fig`, 28 to 40px; h2 `--t-24`; h3 `--t-20`) and the author's intent never renders. Two consequences:

- **To size a heading, put the `text-*` utility on an inner `<span>`**, not on the heading element. The span inherits the display face from the heading and takes its own size. (`product-powered-hub.ts` does this for its card titles.)
- **Don't "fix" it by moving the block into `@layer base` without an audit.** Doing so silently resizes every heading that currently carries a losing `text-*` utility — at the time of writing that is ~7 surfaces, including the `/search` integration hit card (`text-base` → would drop 1.25rem → 1rem, which the Serif-Floor Rule then forbids; the product and vendor hit cards no longer use a heading element, so the rule does not reach them), `browse-grid`, `products-pair` mechanism titles, `admin-shell`, and both taxonomy `h1`s. The block being unlayered is a bug, but unwinding it is its own scoped piece of work with per-surface decisions, not a drive-by.

**The Page-Width Rule (AECI-987).** Page width and reading measure are two different constraints. The page takes the standard 7xl canvas (§5 → Layout shells); measure (`max-w-prose`, `max-w-[42rem]`, 65 to 75ch) goes on the prose blocks inside it, and form controls cap at `max-w-2xl`. The one exception is the product page's band shell, which takes a 1328px wrap with 48px gutters (§4 "The detail page band shell", clash 16). A routed page never puts a reading-width class on its outermost container: at 1280px that leaves a narrow column with a blank right half. Examples:

- *Editorial* (`/about`): 7xl canvas, the article prose capped at measure.
- *Account* (`/account`): 7xl canvas, a sticky section nav from `lg`, panels across the content column, inputs capped at `max-w-2xl`.
- *Form* (`/products/:slug/review`, the claim and correction pages, `/welcome`): 7xl canvas with the form + context rail (§5 → Layout shells).
- *Focused flow* (`/auth/login`): the one exception. A single short task with nothing to put beside it stays a narrow centered column. The focused flows are `/auth/login`, `/claims/confirm`, `/notifications/mute`, `/unsubscribe`, `/vendor/invite/:token` and the 404 shell.

Inside the docs shell the canvas is the shell's content column: the docs home and section index widen into it, and articles keep 42rem.

**The Two-Family Rule.** Source Serif 4 for display, statement, figure, section, headline, title and card title. Atkinson Hyperlegible Next for lede, body, label, overline, and caption. No third typeface enters the system. Monospace appears only when rendering literal code (in `<code>` and `<pre>`) and uses the system monospace stack — it is not a brand face.

**The Reflex-Reject Rule.** This system explicitly does not use, and will reject any proposal to introduce: Inter, DM Sans, Plus Jakarta Sans, Geist, Mona Sans, Space Grotesk, IBM Plex Sans, Outfit, Roboto, Open Sans, Arial, Fraunces, Newsreader, Lora, Crimson, Crimson Pro, Crimson Text, Playfair Display, Cormorant, Cormorant Garamond, DM Serif Display, DM Serif Text, Instrument Sans, Instrument Serif, Syne. The chosen pair (Source Serif 4 + Atkinson Hyperlegible) is the answer; the reflex list is the question that has already been refused.

## 4. Elevation

The redesign rulings of 2026-11-13 changed this section (clashes 11 to 18). A clash number beside a rule means that ruling set it. Where the record has Chris's own words, they are quoted. Where it says only NEW, BLEND or CURRENT, the rule follows the clash recommendation and `PLAN.md` §4.3. The scope sentence under "Forest grounds" in §2 applies to this section too: ruling R2 builds the public pages first. Shared components (the header, the footer, the button and the input) are one component on every surface. Portal and admin page bodies wait until Chris has verified the public pages (§5 Components, "Scope"). Values the rulings left open are listed under "Open values (set by AECI-1750, AECI-1765 and AECI-1766)". ADR 0056 records which written rules this section rewrites.

Borders separate controls. One shadow lifts the cards that float on the page ground, and one shadow lifts menus. The kept modal shadow is the only other shadow. The focus ring is an outline.

The system is still flat by default. Depth is conveyed through color (Bone callouts, sunken inset wells), spacing (generous whitespace around elevated content), border weight on controls, and one card shadow on top-level cards. Cards, menus and dialogs are the only surfaces that rise off the page, and a focus ring marks the element the keyboard is on.

### Shadow Vocabulary

The recipes are written here once. Every other section and every component points to a token name, never to a copy of the values. The two tokens are in `apps/web/src/styles.css` (AECI-1750). No component uses either yet. The card, dialog and menu issues replace the old `shadow-sm` and `shadow-lg` usages.

| Token | Recipe | Where | Clash |
| -- | -- | -- | -- |
| `--shadow-card` (`shadow-card`) | `0 1px 3px rgb(0 0 0 / 0.06), 0 16px 36px -16px rgb(0 0 0 / 0.24)` | Top-level floating cards: the product card grid, the search hit cards, the integration group card and the facts card (`PLAN.md` §4.3 calls them "the facts card and entity cards") | 11 |
| `--shadow-menu` (`shadow-menu`) | `0 8px 24px -4px rgb(0 0 0 / 0.12), 0 2px 8px -1px rgb(0 0 0 / 0.06)` | Menu panes, autocomplete dropdowns, tooltips with body content, the Browse menu panel | 11 |

- **Card shadow (clash 11, blend).** One recipe, pure black, for a card that stands on the page ground. A card nested inside another card takes no shadow of its own (see "Cards may nest" below). Chris's ruling was BLEND with no note, so the recipe is the clash recommendation and the plan's value.
- **"Entity cards (index rows)" take no shadow.** `PLAN.md` says "entity cards", but §5 already uses that name for index rows, which are table rows. They keep the hairline and take no shadow. The cards that take `--shadow-card` are the four components in the table.
- **Menu shadow.** This is the existing Dropdown / Popover recipe, unchanged. Only its name is new.
- **Both are pure black, measured.** The values are `--sh-card` and `--sh-pop` on line 15 of mock-up 6 (the same on mock-ups 5, 7 and 8). Pure black is what `PLAN.md` §4.3 rules ("One card shadow, in pure black"). It is also the form of the modal shadow and of the CDK backdrop, so the three agree. `styles.css` is the token definition site and is exempt from the colour rules, so lint is not the reason. The guard spec pins both strings exactly.
- **Forced-colors mode drops `box-shadow`.** A card that relies on `--shadow-card` has no edge there. AECI-1765 gives it a transparent 1px border, which the system colours. The token comment says so.
- **Modal / Dialog** (`box-shadow: 0 16px 48px -8px rgb(0 0 0 / 0.18), 0 4px 16px -2px rgb(0 0 0 / 0.10)`): for overlay surfaces (dialogs, command palettes). Pairs with a 50% opacity backdrop. No ruling touched it, so it is unchanged and has no token yet.
- **Focus ring** (`outline: 3px solid var(--accent-primary)` at `outline-offset: 3px`, mock-up 6, line 29): the keyboard-focus indicator. It is an outline and not a `box-shadow`, because forced-colours mode drops shadows and keeps outlines. The shipped ring is an outline too (`apps/web/src/styles.css`, the `:focus-visible` rule). Never `outline: none` without a replacement. On a Forest ground, the hero panel and the footer ground the ring is Bone (`--focus-ring-on-brand`, AECI-1747, 11.03:1 on Forest). A Forest ring there is invisible, and on the hero panel it is 1.20:1. §6 "Floors" lists this floor. The global `:focus-visible` colour rule sits in `@layer base` (AECI-1845). So a control on Forest takes the Bone ring from the plain utility `focus-visible:outline-(--focus-ring-on-brand)`, at 3px with a 3px offset. It needs no component CSS and no `!`. The shipped default ring is still 2px at a 2px offset (`focus-visible:outline-2 focus-visible:outline-offset-2`), not the mock-up's 3px. That changes only when each surface is rebuilt.
- **Buttons, chips, inputs and tabs keep borders and take no shadow** (clash 11). Hover lift on cards is clash 37 and belongs to §5 "Motion", not to this section.
- **A shadow is never the only cue for a boundary that needs 3:1.** A card is not a control, so its shadow edge may stand alone. A control placed on or inside a card keeps its own 3:1 edge (§2 "Field edge"). The mock-up's other shadow variables (`--sh-mark`, `--sh-ctl`, `--sh-btn`, `--sh-bar`) are not in the plan's table and are not part of the language.

> **`rgb(0 0 0 / α)` is the one color function lint allows** (AECI-597). The AECI-597 guard bans `rgb()`, `hsl()` and `oklch()` everywhere in `apps/web`, with a carve-out for all-zero RGB channels (`COLOR_FUNCTION` in `eslint.color-patterns.mjs`) precisely so the shadow recipes keep working, including the underscore spelling Tailwind arbitrary values use, `shadow-[0_16px_48px_-8px_rgb(0_0_0/0.18)]`. A tinted shadow will fail `pnpm lint`. The mock-ups' green-tinted shadows (clash 11) are dropped for that reason. If one is ever wanted, change it here first and widen the carve-out in `eslint.color-patterns.mjs` in the same PR.

### Radius (clash 12)

Chris's ruling was BLEND with no note. The blend is the clash recommendation: add a 24px card radius and a 12px control radius, let public chips be pills, and keep primary actions off the pill.

| Role | Radius | Frontmatter key | CSS token and utility | Clashes |
| -- | -- | -- | -- | -- |
| Cards | 24px | `rounded.card` | `--radius-card`, `rounded-card` | 12 |
| Controls: buttons, inputs | 12px, with the header search pill (clash 29) as the one named exception | `rounded.control` | `--radius-control`, `rounded-control` | 12, 20 |
| Chips | Full pill | `rounded.pill` | `--radius-pill`, `rounded-pill` | 12, 22 |
| Small marks | 8px | `rounded.mark` | `--radius-mark`, `rounded-mark` | 12 |
| Nested panels (open) | 16px | `rounded.panel` | `--radius-panel`, `rounded-panel` | 12 |

On a redesigned public component use the role utilities `rounded-mark|control|panel|card|pill`. `rounded-sm|md|lg|xl` still render Spartan's 4.8, 6.4, 8 and 11.2px and are for surfaces not yet rebuilt. The frontmatter key equals the utility suffix, so `{rounded.control}` is `rounded-control`.

- **No pill buttons** (clash 12, a rule that stands). "Sign in" is a rounded rectangle at 12px. A chip may be a pill. A button, a link styled as a button and a primary action may not.
- **The old scale stays (AECI-1750, rulings of 2026-11-14).** `--radius` is `0.5rem`, so Spartan derives 4.8, 6.4, 8 and 11.2px for `rounded-sm`, `rounded-md`, `rounded-lg` and `rounded-xl`. AECI-1750 did not remap those four utilities. This departs from the issue text ("map `--radius-sm`, `--radius-md`, `--radius-lg` and `--radius-xl` onto them so existing usages land on the new scale"). The reasons:
  - **Order of work.** Chris ruled that public pages are built first, that shared components (header, footer, button, input) are one component on every surface, and that the vendor portal and admin page bodies are restyled only after he has verified the public pages: "We will do admin pages i just want a good natural stopping point where i can verify the work." The four utilities appear 1,176 times in `apps/web/src` (admin 548, vendor portal 253, shared components 76, public 247, previews 40, mostly in the `rounded-(--radius-md)` form). A remap would reshape about 800 portal and admin page-body corners at once, before that checkpoint.
  - **The scale would stop ascending.** Mapping `lg` to 24px leaves `rounded-lg` larger than `rounded-xl`. Spartan's `2xl`, `3xl` and `4xl` stay derived from `--radius`, so they would be smaller than `lg`.
  - **Names.** A role name cannot be confused with Tailwind's meaning of `md` or `lg`. That confusion is the trap in the frontmatter below: `rounded.md` once meant 12px while `rounded-md` renders 6.4px.
- **Code tokens by role.** Each is declared on `:root` and exposed in `@theme inline`, so the utility exists. No component uses one yet.
- **Chip shape and the header's pills.** The chip vocabulary is clash 22 and §5 owns it. The header search and nav hover shapes belong to the header, and §5 Navigation owns them.

### Spacing (clash 17)

Chris's note on clash 17 was about type: "I do believe we have too many font sizes and variants, see what it looks like to limit them." The spacing blend is the clash recommendation: snap to the scale and the look survives.

- **The scale is 4, 8, 12, 16, 24, 32, 48, 64 and 96px** (clash 17). It is Tailwind's default spacing, steps 1, 2, 3, 4, 6, 8, 12, 16 and 24. AECI-1750 adds no spacing tokens, and `styles.css` declares none. It sweeps nothing.
- **Snap, do not invent.** The clash recommendation names the mock-up's strays: 22 goes to 24, 26 and 28 go to 24 or 32, and 104 goes to 96. Padding, margin and gap sit on the scale. A control's height is not spacing, and clash 20 sets it.
- **Tailwind steps off the scale** include 5, 7, 9, 10 and 11 (20, 28, 36, 40 and 44px). The half steps 0.5, 1.5, 2.5 and 3.5 (2, 6, 10 and 14px) are off the scale too.
- **Half steps snap.** Clash 17 says snap and names no optical-alignment exception, so a half step is not allowed because it looks right inside a control. A real exception needs a ruling from Chris.
- **Who snaps what.** Each redesigned public component uses the role radius utilities and on-scale spacing when its own issue rebuilds it. The remaining public and shared-shell uses are swept by a follow-up issue. The vendor portal and admin page bodies wait for Chris's checkpoint above. Counts at AECI-1750 (utilities with a spacing prefix, specs excluded): integer steps off the scale 503, half steps 869.

| Surface | Integer off-scale (5, 7, 9, 10, 11, 14, 20, `[...]`) | Half steps |
| -- | -- | -- |
| Public | 151 | 157 |
| Shared components and shell | 30 | 53 |
| Vendor portal | 109 | 161 |
| Admin | 169 | 485 |
| Previews | 44 | 13 |

### Layout: bands, grids and nesting

#### The detail page band shell (clash 16, new)

Chris ruled NEW: the new design wins. The product page drops the two-column layout with a metadata sidebar. This describes the bands. The pixel values are starting values in the table below. AECI-1778 rebuilds `DetailLayout` as a band shell. Only `product-detail.ts` and `vendor-detail.ts` use `DetailLayout` today. The vendor page and the pair page with integrations wait for their mock-ups (AECI-1791), so this section does not bind them yet.

From top to bottom, a product page is:

1. **The Forest header** (§2 "Forest grounds", clash 1).
2. **The Forest hero band**, with the soft single-colour glow (clash 13, below). It holds the breadcrumb, the name, the ratings, the actions and the hero visual.
3. **The facts card.** One elevated card (`--shadow-card`) that overlaps the bottom of the hero and carries the key facts in columns. It replaces the metadata sidebar.
4. **The sticky section nav.** It sits on a solid surface once it sticks. No frosted blur (clash 13).
5. **Full-width bands**, one per section. The first band is the one Bone band (clash 2). It runs from behind the lower half of the facts card, through the section nav at rest, and through the About band. The rest are white, and a hairline `border-default` separates two white bands.
6. **The mailing-list band and the Forest footer.** On the band shell the mailing-list band is white, so it never adds a second Bone band.

- **The page wrap** is 1328px with 48px gutters (`PLAN.md` §4.3, no clash). That leaves a 1232px content column. Gutters step down at narrower widths (starting values below). The breakpoints are Tailwind's defaults (see "Breakpoints" below).
- **No sidebar on the product page.** Resources, vendor facts and the claim and correction entries move into the facts card. The old rules for where the sidebar undocks, its docked and undocked formats and its `space-y-6` rhythm are retired for the product page. The vendor page keeps them until its mock-up lands.
- **The 608px table check is replaced.** A body table is checked against the content column, which is the viewport minus both gutters. That is 960px at a 1024px viewport and 327px at 375px. The old 608px figure and the 38rem floor came from the sidebar split and no longer apply. The mock-up's comparison table asks for `min-width: 1240px`, which is wider than the 1232px column (`PLAN.md` §10.2 lists the table view as clipped at 1440px). The table view must scroll inside its own wrapper or fit.
- **The sticky nav keeps its own slot**, bare as a direct child of the page container, because sticky is bounded by the parent's box. It marks one link `aria-current="location"`, and SSR renders the first link for every visitor. Both rules stand from the old text. The rulings did not touch them.
- **DOM order is the single-column reading order** at every width. The bands work without the layout.
- **The empty pair page** (mock-up 5) has no facts card. The pair page does not use `DetailLayout` today. The vendor page and the pair page with integrations have no mock-up yet (AECI-1791).
- **Bone fills are not bands.** Clash 2 is about full-width tinted bands as the page ground. A Bone or tinted fill inside a card is a nested fill, so the Bone stat panel in the facts card and the reviewer-update panel in a review card do not count against "one Bone band per page".
- **The legal notice band is shell chrome.** It does not count as the page's one Bone band. (Orchestrator reading, 2026-11-14, Chris to confirm.)
- **Floor: the facts card never overlaps past the hero.** The overlap never exceeds the hero's bottom padding at any width. At 128px of padding and a 96px overlap the clearance is 32px. Below `md` both are 96px and the clearance is zero, so the hero's last control has no spare room there.
- **Floor: bands clear the sticky bar.** Each band's scroll margin is at least the sticky bar's height, and a control reached by keyboard is never hidden under the bar (WCAG 2.4.11). The mock-up bar is at least 72px and today's sections use `scroll-mt-20` (80px), which clears 72px by 8px.
- **Floor: hero contrast is measured at the glow's peak.** Hero text is measured against Forest hover, where Bone is 6.87:1 and a Clay stroke is 3.29:1.

#### Hero glow, no blur, no noise (clash 13)

Chris ruled BLEND on the second pass, 2026-11-13: "Keep the soft single-colour glow in the hero. Drop the frosted-glass blur on the sticky bar. Drop the noise texture."

- The hero keeps one soft glow in a single colour, Forest hover (§2). The mock-up draws it as two radial gradients of that one colour. No second hue.
- The sticky section nav is a solid surface with a hairline `border-default` edge. Chris's words name the sticky bar. The wider ban on blur elsewhere rests on the existing §6 Don't on glassmorphism (blur, glass cards, glow borders).
- No noise texture. Bars and meters have no gradient fill (clash 19, which §5 owns).
- The rulings allow the hero glow. They do not allow other gradients, and glassmorphism stays banned (§6).

#### Cards may nest (clash 14, new)

Chris ruled NEW: the new design wins, and the old "Don't nest cards inside cards" is rewritten, and §6 now says so.

- A card may hold another card, panel or tile. The mock-ups nest one level. The rulings say nothing about two.
- **Only the outer card carries the shadow.** A nested panel is a tint or a hairline on the card's own surface. It takes no shadow of its own, so a stack shows one elevation.
- A nested panel keeps the readability floors. Text on it meets AA, and `--text-tertiary` is never used on a Bone, sunken or muted surface (§2).
- **Measured nests in the mock-ups:** rating boxes inside entity cards, score tiles, the reviewer update and the vendor reply inside a review card, the reach box inside the integrations fill, and the Bone stat panel inside the facts card. A Bone or tinted fill inside a card is a nested fill, not a band (see the band shell above).
- **Vendor replies** (rewrites the placement rule in §5 Auth & Reviews, clash 14). A reply now sits inside its review card as a nested panel, under the review text. It no longer sits below the card as an indented sibling block. It has a small leading mark, the label "Response from {vendor}" and the date. The review stays an `article` named by its title.

#### Coloured side stripes are allowed (clash 15, new)

Chris ruled NEW. The old "Side-stripe borders are banned" is rewritten, and §6 now says so. The clash recommendation had been a label colour or a small dot. Chris chose the stripe.

- A card or tile may carry a coloured stripe on its leading edge. The mock-ups use it to code the two review scores: Forest for product quality and Clay deep for onboarding experience.
- **A stripe is never the only cue.** Each stripe sits beside a text label ("Score one", "Score two" or the criterion name). The label stands alone, so the coding survives greyscale and colour-vision deficiency.
- **Stripe colours are existing tokens.** The score stripes use Forest and Clay deep. Clay deep is the meaning-bearing Clay (§2, 5.83:1 on white). Clay itself stays decorative.
- Gradient text stays banned, and so does a gradient stripe.

#### Card grids cap at three columns (clash 18, blend)

Chris ruled BLEND with no note. The blend is the clash recommendation: keep cards, cap at three columns, and break each grid with a group header or a wider lead card, as the grouped mock-up (7) does.

- **Three columns at most**, on every card grid. The mock-up steps from 3 columns to 2 and then to 1 as the viewport narrows (starting values below). The mock-ups' four-up grids go.
- **Break the rhythm on purpose.** A group header (a hairline rule, the group name and its count) breaks a grouped grid. A wider lead card breaks an ungrouped one.
- **Ruling R3 (2026-11-14) dropped the wide lead card** on the product page integrations list. Chris replied "A", accepting all six recommendations. Row 6 reads "Score figures move back up. The wide lead card goes." The integrations list breaks with group headers instead. R3 does not say whether the wide first items in the mock-up's reviews, extensions and similar-products grids go.
- The wide lead card in §5 "Product card grid" is not rewritten here. It belongs to the card work (AECI-1765).

#### Breakpoints (clash 18 and the Same-Behavior Rule)

Breakpoints are Tailwind's defaults: `sm` 640px, `md` 768px, `lg` 1024px, `xl` 1280px and `2xl` 1536px. `styles.css` sets no custom breakpoints, and a card grid reflows at the same widths on every page. The mock-ups' 760, 1040 and 1260px map to `md`, `lg` and `xl`. The mock-up's "and below" becomes "below" the Tailwind width, so 1040px and below is below `lg`. Nothing is set at `2xl` yet.

### Starting values from the mock-ups

These are measured from the default state of `docs/design/mockups/redesign-2026-11/mockups/6-product-detail.html`. The restore toggles (`html.r-*-orig`) are ignored. The code issue confirms each value. Line numbers are in that file unless noted.

| Value | Starting value | Line |
| -- | -- | -- |
| Page wrap | `max-width: 1328px`, gutter `48px` from `lg` | 15, 25 |
| Gutter | `24px` below `md`, `32px` from `md` to `lg`, `48px` from `lg` | 535, 550 |
| Column steps for cards and similar products | 3 columns from `lg`, 2 from `md`, 1 below `md` | 292, 451, 538, 599 |
| Review list columns | 3 from `xl`, 2 from `md`, 1 below `md` | 413, 530, 599 |
| Facts card columns | 4 from `xl`, 2 from `md`, 1 below `md` | 114, 526, 570 |
| Hero padding | `24px` top and `128px` bottom, `16px` and `96px` below `md` | 49, 554 |
| Facts card overlap | `margin-top: -96px`, the Bone strip starting 96px down | 113 |
| Band padding | `96px` top and bottom, first band `48px` top, `64px` and `32px` below `md` | 203, 206, 579, 580 |
| Gap between grid items | `24px` | 292 |
| Group spacing and header | `48px` between groups, `1px` `border-default` rule under the header with `16px` padding | 1131, 1133 in mock-up 7 |
| Card padding and radius | `24px` and `24px` | 293 |
| Panel padding and radius | `32px` and `24px` | 211 |
| Hero glow | Two radial gradients in Forest hover at 75% and 45% over the Forest ground | 50 to 51 |
| Side stripe | `7px` wide on a score card, `3px` inset on a score tile | 386, 416 |
| Nested panel radius | `16px` on the reply and the reach box, `12px` on a score tile | 354, 416, 428 |
| Mock-up breakpoints (mapped above) | 1260px, 1040px and 760px | 524, 534, 549 |

The mock-up builds the glow with `color-mix()`, which clash 6 bans in components. The code must get the glow from a token and an opacity, not a mix.

### Open values (set by AECI-1750, AECI-1765, AECI-1766, AECI-1778 and AECI-1790)

- **Nested panel radius (AECI-1750, still open for Chris).** The mock-ups use 16px on nested panels and 12px on score tiles. Neither value is in the ruled scale of 8, 12, 24 and pill. The 12px tile is `--radius-control`. The 16px value has a token, `--radius-panel`, so a page issue can use it without an arbitrary value. Whether 16px joins the scale or snaps to 12 or 24 is Chris's call, and deleting the token is one line.
- **Radius of a logo tile by size (AECI-1750, see §5 "Logos").** The mock-up's mark is `border-radius: 22%`, with 8px at 22 to 28px and 24px at 104px. Only "small marks 8px" is ruled.
- ~~**The `radius-xl` mapping (AECI-1750).**~~ Settled: there is no mapping. `rounded-xl` stays Spartan's 11.2px (5 uses: 2 on public pages, 3 in previews), and the 16px nested panel is `rounded-panel`. The sm, md and lg utilities stay as they are for the same reason.
- ~~**Sweep of off-scale spacing in the code (AECI-1750).**~~ Settled: no sweep in AECI-1750. Each redesigned public component snaps when its issue rebuilds it, and a follow-up issue sweeps the rest of the public and shell uses. See "Spacing" above.
- **The card border (AECI-1765).** The mock-up's card has no border. Confirm whether a hairline stays beside the shadow. Check forced-colors mode, where `box-shadow` is dropped, because a card may need a transparent 1px border that the system colours. This is a check, not a ruled rule.
- **Which surfaces take the card shadow (AECI-1765).** `PLAN.md` names the facts card and entity cards. `PLAN.md` says "entity cards", which in §5 means the index-row table rows that take no shadow, so the table in "Shadow Vocabulary" names the components instead. The mock-up also puts the shadow on panels, review cards, score cards and table wrappers. Confirm the set.
- **The nested panel fill (AECI-1765).** The mock-up's reply uses `--band-cool`, which equals the Forest-soft hex and which clash 6 drops. Pick an existing token such as `accent-primary-soft` or `surface-sunken`.
- **Wide first items in the reviews, extensions and similar-products grids (AECI-1765).** R3 dropped the integrations lead card only.
- **Page wrap for the other shells (AECI-1790, the browse mock-up).** The wrap is 1328px with 48px gutters on the band shell. The Browse and form shells still use the 7xl canvas (§5 "Layout shells"). Whether they move is Chris's call under the same-behaviour rule.
- **The glow (AECI-1766).** The token and opacity that give the glow without `color-mix()`.
- **Connector products on the band shell (AECI-1778).** Where "Built within" and "Integrations it powers" sit. Connector products are not designed, and AECI-1778 must keep every field the live page shows.

### Named Rules

**The Borders-Not-Shadows Rule** (rewritten by clash 11, see ADR 0056). Buttons, chips, badges, inputs and tabs use borders to separate from their surface (1px default on the redesigned components, `border-strong` for emphasis, 2px for featured and error states, clash 23). Some shipped surfaces still draw 0.5px and change as each is rebuilt. Box-shadows on those elements are forbidden. Cards are no longer on that list. A top-level card takes the one card shadow, and a menu takes the one menu shadow. The old form of this rule forbade shadows on cards, and that ban is lifted for `--shadow-card` only. The failure the rule was written against, a rounded rectangle with a generic drop shadow, still applies to any shadow that is not one of the recipes above.

**The Arrow Rule** (AECI-919, rewritten by clash 33). Chris ruled NEW on clash 33 and left no note: the new design wins. **An arrow may mean "go here" as well as data-flow direction.** The mock-ups use an arrow for "It does exist", "See all categories", the read-more circle on a card and the jump after "reviews". The old rule banned all of that. The failure it was written against is real, so two limits stay.

- **The direction vocabulary is unchanged.** The three directional glyphs, `→` outbound, `←` inbound and `⇄` both, mean data-flow direction. They come only from a direction helper, and every one of them is framed to the **context product** (`STAGE_1_5_SPEC.md` §3.2). There are two emitters: `directionGlyph()` (`products/pair-direction-labels.ts`) and `contextDirectionLabel()` (`search/mechanism-labels.ts`). The powered hub's flat rows call `directionGlyph()` and keep a `·` placeholder for an unknown direction at the call site (AECI-1123 folded their hand-rolled copy in).
- **A "go here" arrow is a drawn icon, never one of those text characters.** It is an arrow or a chevron from the icon set (§5 "Icons"). It is `aria-hidden` and mirrors in right-to-left text. A drawn icon cannot be confused with the direction set, and a text `→` can.

| Job | Use | Never |
| -- | -- | -- |
| Separating a pair of things (the pair-page rail, any "A and B" header) | a hairline rule (`h-12 w-px bg-(--border-default)`), or nothing | `⇄`, `↔`, `+` |
| "Activating this goes somewhere" (a row's click affordance, a card's read-more, a "see all" link) | an arrow or chevron icon from the set, `aria-hidden`, mirrored in right-to-left text | the text characters `→` and `←` |

`+` is not an escape hatch for the first row: it is already spent on the version-diff `added` marker (see the Diff markers component). The rule exists because the pair page violated it twice at once. The rail rendered a hardcoded `⇄` at `text-3xl`, louder than the `⇄` a bidirectional mechanism earned below it. The product-detail integrations row rendered a nav `→` in the same row as a direction `→`. Both are collisions of **meaning**, not of style, so a reader who learns the vocabulary in one place is actively misled in the other. The clash record names the same collision on the mock-up's integration cards, which carry a read-more arrow beside a real direction arrow ("Revu sends"). Whether a card may carry both is open (AECI-1782 and AECI-1765).

A **display name is not exempt.** A mechanism heading, a card title or a badge label that carries `A → B` asserts a direction, and on a context-framed surface it asserts an absolute one that will contradict the relative arrow beside it. The pair page's card `h2` is the shipped case: the API strips a directional pair title rather than render it (`toMechanismHeading`, `apps/api/src/lib/drizzle-helpers.ts`).

**The Link Treatment Rule** (AECI-980). **A link's styling states its ROLE, and every new tab is both drawn and announced.** Before AECI-980 the app spelled one job four ways, spelled the new-tab cue three ways, and spelled `rel` four ways. None of that was a decision; it was six years of local choices.

There are five roles. Pick by what the link does, never by where it sits.

| Role | Recipe | Where |
| -- | -- | -- |
| **Primary action** | the primary button (§5 Buttons): `accent-primary` fill, white text, 44px high, 12px radius, `--t-14` at weight 600, `no-underline`. On a Forest ground the on-brand button, Bone fill with Forest text | **One per surface.** Today that is "Visit website" on product and vendor detail. |
| **Standalone link** | `--t-14` at weight 600, `text-(--text-secondary)`, `underline decoration-(--border-strong) underline-offset-4`, `px-3 py-2`, `rounded-(--radius-md)`, `hover:text-(--text-primary)` | Every "go look at a page" link. `aec-view-public-link` is the reference spelling. |
| **Citation** | the standalone recipe minus the padding, on `rounded-(--radius-sm)` | A source hanging off a figure or a stat. The home band's "Source" is the only one. |
| **Admin metadata chip** | `rounded-full border`, `px-3 py-1`, `text-xs font-medium`, `no-underline` | **Admin console only**, and only inside a `flex flex-wrap` chip row that also holds non-link chips. The pill is load-bearing there: flattening it would break the row's grammar. |
| **In-text link** | `text-(--accent-primary)`, `underline underline-offset-2` (permanent, not hover-only), `hover:text-(--accent-primary-hover)`, `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)`. No padding, no size or weight of its own: it inherits the sentence's type. | A link that is a word or phrase inside running text: a notice, a help line, an empty state. `vendor-contest-protest.ts` (`linkClass`) is the reference spelling. The portal's product-not-found notice uses it (AECI-1102, AECI-1129). |

Clash 21 (CURRENT, no note from Chris) keeps this rule. The mock-up's bold Forest links without an underline (`.f-learn a`, `.scope a`, `.inline-link`, "See all categories", `.card .go`, `.see-all a`) are dropped. "See all" and similar links use the standalone recipe. A link inside a sentence uses the in-text recipe. One filled button stays per surface. §5 Buttons has the button recipe. The standalone link's old `text-xs font-medium` is retired, because 12px is not a link size on the ramp (§3) and weight 500 belongs to two chips only. The new size and weight are the mock-up's own standalone link (`.know-link`, mock-up 8, line 1088: 14px at 600, text secondary, underlined with a `border-strong` line at a 4px offset). They are starting values for AECI-1758 to confirm.

**Accent is spent on the primary action and nowhere else.** A second accent-coloured link on a surface competes with the one thing the reader is meant to do. AECI-980 pulled three links off accent for this: the pair page's "View listing" and "Documentation", and the integration group card's "View product".

**The in-text link is the one exception, and it earns it.** Inside a sentence the link must be told apart from the words around it. The underline is the non-colour cue axe's `link-in-text-block` rule requires, and the accent is the colour cue. Neither alone is enough (AECI-1102). The exception covers a link inside running text only. A link that stands on its own line is a standalone link, whatever surface it sits on. The underline is permanent because the reader must find the link before hovering. The hover colour is restated because a `text-*` utility overrides the base layer's `a:hover`, so without it the link gives no hover feedback.

**When a link opens a new tab.** Two cases, and only two.

1. **The destination is not ours.** Any third-party site. We do not control what it does with the reader's session or their back button.
2. **The reader is mid-task on an editing surface.** The vendor portal and the admin console hold unsaved form state, `apps/web` has no `CanDeactivate` guard and no `beforeunload` handler, and a same-tab navigation silently discards an edit. The link is a lookup, not a destination.

Everything else stays in the tab. A link from a read-only public page to another public page is a destination, and opening it in a new tab steals the reader's back button for nothing.

**The vendor portal's "Learn more" links into the vendor guide** (AECI-1253) are case 2: standalone links, new tab, `rel="noopener"`, one component (`vendor/components/vendor-docs-link.ts`). The visible text is "Learn more" and a visually hidden suffix names the page. `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.20 has the list.

**One page-scoped exception: `/vendor-program`** (Chris, 2026-10-12). It is a landing page whose job is a claim, so its links into the docs (`/docs/*`) open a new tab with the full treatment below, and the claim stays one tab away. Its conversion links ("Claim your listing", "Questions? Contact us", "Go to your portal") stay in the tab. `VENDOR_PROGRAM_PAGE_SPEC.md` §3 holds the rule. It does not extend to any other public page, `/docs/vendors/plans` included.

**One surface-scoped exception: the claim confirmation.** After a claim is sent, the request form's "How claims work" link (`requests/request-form-body.html`) opens `/docs/vendors/claiming-your-listing` in a new tab with the full treatment, so the confirmation and its "What happens next" steps stay on screen. It applies on the claim page and in the request drawer alike, and it no longer closes the drawer. No other link in the request form changes.

**Case 2 has one supersession: if the destination is one of our own request forms, open the in-place drawer instead** (`aecRequestTrigger` + `aec-request-drawer`, AECI-128). Not navigating beats navigating elsewhere: the edit is safe, and the vendor keeps the thing they are correcting on screen behind the panel. The anchor keeps its `href` and the full new-tab treatment, because the no-JS and modified-click paths do navigate. AECI-967 did this at the vendor portal's three correction links; `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.9 carries the detail.

**Every new-tab link carries `aec-new-tab-icon`** (`apps/web/src/app/shared/new-tab-icon/new-tab-icon.ts`). It is the ONLY place the `aec-icon` `external` glyph (an up-right arrow) is drawn, and it carries the `sr-only` "(opens in a new tab)" note in the same breath — because the two halves kept shipping apart. Seven links disclosed the new tab to a screen reader and showed a sighted reader nothing; eight drew a `↗` text character instead of the glyph. The note sits **inside** the anchor, not beside it: a sibling span is not read in a VoiceOver rotor or an `NVDA+F7` links list, so a disclosure parked outside reaches browse mode and nowhere else.

The text `↗` is retired. It is not a direction glyph, but it sits one character from the vocabulary the Arrow Rule above reserves, and on the pair page it rendered in the same card as a real `→`. A drawn icon cannot be confused with the direction set.

**A caller-supplied `aria-label` overrides the note**, because an `aria-label` replaces the anchor's contents for assistive tech. So any link that passes one must state the new tab in that name itself, and the name must begin with the visible text (WCAG 2.5.3 Label in Name).

**The one exception is a brand-glyph icon button** — the vendor hero's social links. A 9x9 icon button has no room for a second mark, and adding one would read as a sixth platform. Those disclose the new tab in the accessible name only, which is also their only name.

**`rel` has exactly two recipes.** Nothing else.

| Destination | `rel` |
| -- | -- |
| Our own pages (portal or admin linking out to the public catalog) | `noopener` |
| Anything external | `noopener nofollow` |

`noopener` is never optional: without it the new browsing context gets a handle on this one. `nofollow` on the external recipe is a deliberate SEO position, and it was previously half-applied — "Visit website" passed link equity to vendor sites while the pair page's "View listing" did not, which meant the same decision was made twice, differently, by accident. Vendors pay for plans, so a followed link from a paid listing would read to Google as a paid link.

**`noreferrer` is deliberately absent (AECI-1640).** AECI-980 added it, and it hid AECi from every destination: vendors saw our clicks as direct traffic and could not check Vendor Performance click counts against their own analytics. It protected almost nothing, because the site-wide `Referrer-Policy: strict-origin-when-cross-origin` (`apps/web/src/server/seo-headers.ts`) already sends only our origin on a cross-site click, never the path or query. Do not add it back to the external recipe. `<img referrerpolicy="no-referrer">` on avatars is a separate concern and stays.

## 5. Components

Components are bound to tokens via the front-matter `{...}` references. Concrete behavior, states, and Spartan brain primitive bindings below.

> **Behavior providers (ADR 0010, Accepted).** Component _behavior_ here is headless. **Spartan brain** (ADR 0005) covers the overlay primitives — buttons, popovers, dialogs. **Angular Aria** (`@angular/aria`, stable in v22) is the provider for _new_ interactive and form-control patterns: select, combobox, listbox, radio, accordion, tree, grid, menu, toolbar, tabs. Both bind to the tokens below identically, via Tailwind **`aria-*:` variant utilities** (`aria-selected:`, `aria-expanded:`, `aria-checked:`) plus the **`data-[active=true]:`** variant Aria sets on the active option — token-bound, no TS state mirror. (Three adopter-facing deviations: Aria@22 ships no `radio`/`select`, so listbox/combobox stand in; discrete-choice Aria controls bridge into Signal Forms via `[(value)]`+`(valueChange)`, not `[formField]`; and **the accordion is not used for SSR-indexable content** — its panel renders through `afterRenderEffect`, which is client-only, so the panel ships empty to crawlers. See the Disclosure group card below, and the ADR.) The behavior provider is invisible to the visual system — the **Anchor-Site Rule** governs composition, hierarchy, density, and atmosphere, not which library supplies keyboard/ARIA logic, so two providers is not a mashup. See `docs/adr/0010-angular-aria-alongside-spartan.md`.

The redesign rulings of 2026-11-13 and 2026-11-14 changed the components in this section. They are clashes 19 to 25, 39 to 41 and 43, and Chris's rulings R1, R2, R3 and R5. A clash number beside a rule means that ruling set it. Where the record has Chris's own words, they are quoted. Where it says only NEW, BLEND or CURRENT, the rule follows the clash recommendation and `PLAN.md` §4.4. The record is `docs/design/mockups/redesign-2026-11/records/design-rulings.md`. ADR 0056 records only the rewrites its table lists, which here are the shadow rule, the radius rule, nested cards, side stripes, the icon rule (clash 34) and smooth scrolling (clash 38). Values the rulings left open are listed under "Open values (components)", each with its code issue.

**Scope (R2, 2026-11-14).** Chris: "Just do public pages for now". Ruling R2 builds the public pages first. Shared components (the header, the footer, the button and the input) are one component on every surface. Portal and admin page bodies wait until Chris has verified the public pages, and take the new tokens and nothing more until then. R2 is a staging point and not a permanent limit. Page bodies are restyled later, and nothing ships to production half built. The deferred portal and admin migrations are AECI-1756, AECI-1757, AECI-1761 and AECI-1762.

**Ruling on the shared button and input (Chris, by Slack, 2026-11-14).** `BUTTON_PRIMARY_CLASS`, `BUTTON_SECONDARY_CLASS`, `FIELD_INPUT_CLASS` and `.aec-field-control` are shared with the portal and admin. The question was whether they inherit the new button and input or the classes are forked. Chris: "A. We will do admin pages i just want a good natural stopping point where i can verify the work". Option A was: the portal and admin inherit the new shared button and input. One component everywhere. AECI-1813 sweeps any layout that breaks. AECI-1758 and AECI-1764 are unblocked. The portal and admin keep their current icons and Tailwind's 150ms default until their own migrations run (§5 "Icons" and "Motion").

Four pages are not bound here because their mock-ups are not approved: the home page, the browse lists, the vendor page and the pair page with integrations (AECI-1789 to AECI-1791). This section describes components, not those pages' layouts.

**The Same-Behavior Rule.** A pattern behaves the same way on every page that has it. Listing paging is infinite scroll through `<aec-pagination-footer>`, except that the list of integrations pages by group (R5 below). (The operator console's feeds and lookup screens keep Previous/Next by an explicit ruling, `docs/ADMIN_PANEL_SPEC.md` §5.7.) Filters live in `<aec-facet-panel>`, except for the list of integrations (R5 below). Sort sits in the toolbar row and offers the same orders, except that the list of integrations has no sort control (R5 below). Filters, sort and view live in the URL, and changing one keeps the reader's scroll position. Empty, loading and error states read alike. A visitor who learns a pattern on `/products` must not relearn it on `/search` or a browse page. Anyone building or reviewing a page that departs from an existing pattern stops and tells Chris before shipping, with what differs and which page sets the pattern. He decides whether to align it or keep the difference. A kept difference is recorded in that component's entry here, with the reason. This rule exists because `/search` shipped a Previous/Next paginator while every other listing infinite-scrolled, and nobody raised it.

**Departures ruled under R5 (clash 45, 2026-11-14).** The new integrations list departs from five shipped patterns. Chris, by Slack: "A" (AECI-1736). Each kept departure becomes the rule for every page with that pattern. Planning that change on the other pages is not done in this file. Each page's code issue does it. Who adopts what, and when:

- **The product page's integrations list adopts all three kept departures now** (AECI-1782 and AECI-1783).
- **The vendor page and the pair page with integrations wait** for their mock-ups (AECI-1791).
- **`/products`, `/search` and the taxonomy browse pages keep the facet panel and the pagination footer** until the browse mock-up (AECI-1790) is approved.
- **The List filter's heading-row placement and the Disclosure group card still govern** every integrations section that has not adopted the departures: the vendor page, the pair page with integrations, and the connector products' two sections (AECI-1778).

| Departure | Ruling | The rule |
| -- | -- | -- |
| Integration filters in their own panel | Kept | A list of integrations puts its filters in one panel of its own, not in `<aec-facet-panel>`. The panel holds the name filter, direction, data objects and partner category. |
| A long list groups by category with a sticky jump rail | Kept | Rows group by partner category under a group header. A sticky rail jumps between groups. The rail and the filter chips show the same count for the same category. |
| "Show more" per group plus a load bar | Kept | Each group opens a short peek and a "Show more" button reveals the rest. "Show more" and "Show fewer" are both the bordered secondary button. The "Load more" bar shows how far the reader is (the meter below). Every row stays in the server HTML. "Show more" reveals rows and does not fetch them. |
| Illustrated empty states | Rejected | Empty states stay text. They read alike on every page. |
| A sort control on the integrations list | Rejected | No sort control. The order is fixed, see R1 below. |

Ruling R3 (AECI-1734, 2026-11-14, "A") sets the default for the long list. Decision 20 reads "The 58-integration list is grouped by category by default". The size at which a list counts as long, and the one-list mode in pages of 12, belong to AECI-1783.

**Order (R1, 2026-11-14).** Chris, by Slack, on AECI-1732: "Maintain orders as they are. If its a new feature a to z". Existing orders stay. Every new on-page list is A to Z by name, with the id as the tie-break, through the collation rule in `CLAUDE.md`. The via-lane groups and the powered-hub groups keep their count order. The pair page list keeps integrations first, then evidenced pairs. In the grouped list, the groups run A to Z by category name with the id as the tie-break (AECI-1783). "Confirmed by both companies" is a label only. No filter and no sort reads it. The mock-up's "Most evidence first" sort cannot ship (`PLAN.md` §7.3).

### Buttons

Spartan `BrnButton` directive provides the headless behavior, and Tailwind utility classes bind to tokens. The redesign rewrites this subsection (clashes 20, 21 and 37, recorded in `design-rulings.md`, and clash 12's radius, see ADR 0056). AECI-1758 builds one `aecButton` directive for `<button>` and `<a>`.

Chris's note on clash 20 was "I kind of like same size buttons". The ruling is BLEND: one height, a 12px radius, a bordered secondary and no shadow.

- **One height: 44px** (clash 20). Every button of every variant has it. The survey found no shared button and five heights in use (32, 36, 40, 44 and 48px). The mock-up's `.btn` sets `min-height: 44px`, and its small button keeps the same 44px with less side padding (mock-up 6, lines 88 and 98). The height is a minimum, so a label that wraps grows the button. An icon-only button is 44 by 44px. That clears the 24 by 24px target floor (WCAG 2.5.8) by 20px, so no button needs its own target-size check. A segmented control is one frame of 44px holding 36px segments (mock-up 6, lines 255 and 256). Each segment is above the floor.
- **Shape: 12px** (`rounded-control`, clash 12). Never a pill. "Sign in" and every primary action is a rounded rectangle. A chip may be a pill. A button, a link styled as a button and a primary action may not.
- **Label:** 14px (`--t-14`) at weight 600, sentence case (mock-up 6, line 88). This is not the 13px `label` role. §3 leaves the button size to this subsection.
- **Padding:** 24px at the side (`spacing.6`) and 16px on the compact variant (`spacing.4`). The icon and the label sit 8px apart (`spacing.2`).
- **Primary** (`button-primary` and `button-primary-hover`): Forest fill, white text at 12.34:1. Hover brightens to Forest hover. Never a pill, never Clay.
- **On a Forest ground** (`button-on-brand`, clash 3): Bone fill with Forest text, 11.03:1 (§2). It is the one main action in the Forest hero. Clay never fills a button.
- **Secondary** (`button-secondary` and `button-secondary-hover`): `surface-raised` fill, `text-primary` text and a 1px `border-strong` edge. "Secondary buttons are bordered." Hover sinks the fill to `surface-sunken` and the text to Forest (mock-up 6, lines 96 and 97). `border-strong` measures 1.48:1 on white, 1.42:1 on raised and 1.32:1 on Bone. WCAG 1.4.11 does not require a boundary on a button when its text label identifies it, so the mock-up's edge stays. The 3:1 boundary rule applies to form controls whose boundary is the only thing identifying them: inputs, selects, checkboxes and switches (see Inputs below). A text-labelled button is identified by its label.
- **Ghost** (`button-ghost`): transparent fill, `text-primary` text, no border, 44px high. Used for tertiary actions in dense surfaces. Hover shifts the text to Forest.
- **One filled button per surface** (clash 21, the Link Treatment Rule stands). The filled primary, or the on-brand button on Forest, is the surface's one main action. Everything else is secondary, ghost or a link. The clash record found three filled primaries in view on page 6 ("Visit website", the sticky bar's "Write a review" and the review panel's "Write a review"). Only one of them stays filled. Which one is the product page's call.
- **No shadow** on any button, resting or hovering (clash 11). Press movement is clash 37 and §5 "Motion" owns it. The mock-up presses with `translateY(1px) scale(.98)` (line 89). The old line "no transform, no scale" is rewritten by clash 37, and the movement is off under reduced motion.
- **States:** `:focus-visible` draws a 3px outline at a 3px offset in Forest. On a Forest ground, the hero panel and the footer ground it is Bone, set by AECI-1747 as `--focus-ring-on-brand`. A Forest ring on the hero panel is 1.20:1 and must not be used (mock-up 6, line 29). It is an outline and not a box-shadow, because forced-colours mode drops shadows. `:disabled` reduces opacity to 0.6 and disables pointer events. It does not change colour.
- **Scope:** one button on every surface. The portal and admin inherit it (Chris, 2026-11-14, see the section introduction). The page restyle is public pages only (R2). AECI-1813 sweeps any portal or admin layout it breaks.

### Cards

Used for vendor profiles, integration cards, the `/search` result tiles (see Search & discovery below — they are the canonical instantiation of this primitive), and content modules. Distinct from the **Entity cards (index rows)** below, which despite the shared "card" name render as `<tr>` table rows and do _not_ use this primitive. The redesign rewrites this subsection (clashes 11 and 12, see ADR 0056, and clash 18, recorded in `design-rulings.md`). AECI-1765 builds the card surface.

- **Corner style:** `rounded-card` (24px, clash 12).
- **Background:** `surface-base`, which is white (mock-up 6, line 293). The old text said `surface-raised`.
- **Shadow:** `--shadow-card` (§4 "Shadow Vocabulary", clash 11). The old "Shadow Strategy: None" is rewritten. Only the components named in that table take it. A card nested in a card takes none (clash 14).
- **Border:** the mock-up's card has no border. A hairline beside the shadow is open (AECI-1765, §4 "Open values").
- **Internal padding:** `spacing.6` (24px, mock-up 6, line 293). Dense list contexts may use `spacing.4` (16px).
- **Hover, when interactive:** the card lifts. The mock-up moves it `translateY(-4px)` on hover and `-1px` on press (lines 294 and 295). Clash 37 sets this and §5 "Motion" owns the timing. It is off under reduced motion. It replaces "raises to 1px `border-strong`, no shadow, no scale".
- **Grids** cap at three columns with a 24px gap (clash 18, §4).
- **A card that is one link** names the product or vendor and nothing more. The whole card text is not the link name (`PLAN.md` §10.2). AECI-1765 checks it.

### Disclosure group card

`apps/web/src/app/products/integration-group-card.ts` (AECI-841). One bordered card per group, used by
both product-detail integration sections. The header bar is the disclosure control; the body is the
group's rows.

- **Frame:** `rounded-card` (24px), `--shadow-card`, `overflow-hidden`. The §4 table names this card. The old 0.5px `border-default` and "no shadow" are rewritten by clashes 11 and 12. A hairline beside the shadow is open (AECI-1765).
- **Header:** `surface-sunken` fill with a `border-default` bottom rule. Contents in order: a chevron
  (the `chevron-down` icon, rotated 180° when open), the subject's logo, the subject name at
  `--t-20` (the card title role) on an inner `<span>` (the Serif-Floor Rule — the size cannot go on the `<h3>`, see the
  Unlayered-Heading Rule), and the group size at `--t-13` in text secondary. The shipped code says `text-lg`, which AECI-1748 maps to `--t-20`, so the name renders 20px.
- **Behavior is hand-rolled, not Angular Aria.** A `<button aria-expanded aria-controls>` inside the
  `<h3>`, over a `role="region"` panel hidden with the `hidden` attribute. Aria's accordion renders
  its panel through a client-only `afterRenderEffect`, which would ship an empty card to crawlers on
  an SSR page — see ADR 0010's deviation (c). **The panel content stays in the DOM when collapsed.**
- **A link never nests inside the header button.** When the group's subject has its own page, that
  link sits beside the button in the same header bar as a compact "View product" anchor.
- **That anchor stays in the tab.** It is the **standalone-link role** under the Link Treatment
  Rule above, and an ordinary in-app link: `routerLink`, no `target`, no `rel`, no
  `aec-new-tab-icon`. A product page linking to another product page is a destination, so neither
  new-tab case applies, and Back restores the reader's scroll position. (It opened a new tab until
  AECI-1125, as "a lookup, not a destination". That was the rule's only exception on a public page,
  and it is gone.) **The accessible name names the product and begins with the visible text**
  ("View product: Agave ERP Sync"). The visible "View product" repeats on every card, so the name
  has to say which product, and starting with the visible text keeps WCAG 2.5.3 Label in Name so
  speech input can target it. The link keeps a 28px target, over the 24px floor (AECI-1079).
- **Open by default.** Collapsing is a reader action; nothing is hidden from a crawler or a no-JS
  reader on first paint.
- **Clash 24 (blend) and the mock-up.** The integrations section is built from shipped parts: this card, the table, the row and the List filter. Every row stays in the server-rendered HTML. The mock-up draws one card per partner product in a three-column grid, not one disclosure card per counterpart. Whether this card stays as that card is open (AECI-1782). The listing sort select is not one of the parts, because R5 rejects a sort control on the integrations list.

**Vendor portal variant (AECI-999) — superseded 2026-09-28 by the integration detail page, AECI-1156.**
The portal's Integrations tab used to nest the same pattern three deep: `vendor-counterpart-group.ts`
(`<h2>`), `vendor-integration-card.ts` (`<h3>`) and the data-flow lane, each retired. What replaced it
is described under "Vendor portal (Stage 2)" → "Integration detail page" below: the list still groups
by counterpart, but a row is a link to its own page rather than a disclosure trigger, and nothing on
this surface nests three deep any more.

### List filter

`apps/web/src/app/products/integration-list-filter.ts` (AECI-841; moved into the heading row and
freed of its row threshold by AECI-848). The name filter over a section of groups.

- **Placement (shipped):** *(2026-11-14: for the list of integrations, R5 puts the filters in one panel of their own, and the name filter becomes one control in that panel. AECI-1782 decides where the panel sits. This passage describes the shipped heading-row placement and the other sections that use it.)* In the section's heading row, right-aligned opposite the `<h2>`. The caller
  supplies that row (`flex flex-wrap items-center justify-between`); the filter's own host is the
  right-hand flex item. Below `sm` it goes full width and drops onto a second line under the
  heading. The host also carries `sm:ms-auto`, which holds the right edge when a long `<h2>` pushes
  it onto a second line at `sm` and above: `justify-between` puts a lone item on a wrapped line at
  flex-start, so without the auto inline-start margin a wrapped filter would render at the start
  edge.
- **Shape:** a `type="search"` input (the browser supplies the clear control), `surface-base` fill, `w-96` from `sm` up. *(2026-11-14: the shipped code still uses `rounded-sm`, a 0.5px `border-default` edge and `text-sm`. A `border-default` edge measures about 1.25:1, so it fails the 3:1 floor. The input takes the Inputs recipe below: 44px high, the field edge, 12px radius and 16px text, and the row grows to hold it. AECI-1764 applies it.)* That width is set by the placeholder
  ("Filter by product or connection") reading in full rather than by the row's spare space, so the
  control looks like somewhere to type. *(AECI-966 widened that string from "Filter by product
  name" when the filter learned to match the mechanism label; `w-96` still holds it in full.)*
- **Label:** visually hidden. The section `<h2>` carries the visible name; a second visible label
  would be chrome.
- **Result count:** a `role="status"` paragraph immediately left of the input, present from first
  paint with empty text and gaining "Showing 3 of 12" once a query starts. A live region created at
  the same moment its text arrives is frequently not announced at all, which is why it is not
  conditionally rendered — and why it is never hidden with `[hidden]` or an `@if` either, both of
  which take it out of the accessibility tree. It is `whitespace-nowrap`, so the filter row never
  wraps internally.
- **No row threshold.** Any section that renders rows renders a filter. AECI-841 originally gated it
  at ten rows; that was reverted because the two integration sections sit next to each other on a
  connector page, and one carrying the control while the other does not reads as a bug rather than
  as restraint. Living in the heading row is what makes this free: an idle filter costs no vertical
  space, which is the cost the threshold existed to avoid.

### Entity cards (index rows)

Listing rows render through `ProductCard` (Phase 2 Spec §11.2, `apps/web/src/app/products/product-card.ts`). Despite the "card" name it renders as a **table row**: it uses an attribute selector on `<tr>` (`tr[aec-product-card]`) so the rendered DOM stays a valid `<tbody>` child — a custom element placed directly inside `<tbody>` is foster-parented out by the HTML tree builder (the same pattern Angular CDK uses for `tr[cdk-row]`). AECI-190 split the products catalog into two views: this `<tr>` component is the **table view** (shared by the `/products` table and the taxonomy browse-page tables), while a separate `ProductCardGrid` (below) is the **card-grid view** and the default for `/products`.

> **Formerly three.** §11.2 also specified `VendorCard` (`tr[aec-vendor-card]`) and `IntegrationCard` (`tr[aec-integration-card]`), the row primitives of the `/vendors` and `/integrations` index pages. AECI-165 removed both index pages (orphaned from the nav after AECI-160; the URLs now 301 to `/products`), leaving the two components with no consumer. They were deleted in AECI-657 along with `IndexLayout`. `/vendors/:slug` detail pages are unaffected — they never used `VendorCard`.

Row behavior:

- **No card shadow, no card radius** (clashes 11 and 12). `PLAN.md` §4.3 and §4.4 say "entity cards", and in this file that name means these table rows. They keep the hairline and take no `--shadow-card`. The card shadow applies only to the components §4 "Shadow Vocabulary" names.
- **Host:** `text-primary`; `hover` and `focus-within` raise the row fill to `surface-muted`. No shadow, no scale.
- **Cells:** `spacing.4` horizontal / `spacing.3` vertical padding. Numeric cells (counts, founded year) are `text-end` and `tabular-nums`. Linked cells shift to `accent-primary` on hover with a `focus-visible` ring.
- **Empty states:** a missing optional field renders an en-dash (`–`) in `text-tertiary` carrying an i18n-wrapped `aria-label` (`@@{entity}.card.{field}.none`) — never a bare blank, and color is never the sole signal.

Cell content:

- **ProductCard** (`tr[aec-product-card]`) — a monogram (`LogoOrInitial`, 32px) beside the name (→ `/products/:slug`), vendor (→ `/vendors/:slug`; nullable per AECI-115), the overall rating as a `RatingSummary` (`variant="cell"` — gold star + average + review count, or an en-dash below the §5.5 ≥5-review gate; `hidden md:table-cell` so it collapses with the vendor column on mobile, where the card-grid view carries the rating), and the integration count as an `IntegrationStat` (graceful "Not yet connected" at zero). AECI-190 folded this richer treatment in so the `/products` table view and the taxonomy browse-page tables share one row.

### Search & discovery (Phase 3)

The Phase 3 search surface (`/search`, the listing-page filters, and the header autocomplete) adds one page shell and several small headless-behavior components. Search itself runs **browser-side against Algolia** with the search-only key (Spec §7.5) — the admin key is never shipped (see the CSP / key handling note in §6). Every component renders correctly via tokens and i18n-wraps (or is passed) every visible string. Components live in `apps/web/src/app/search/` (search experience) and `apps/web/src/app/shared/facets/` (listing-page filters).

- **Search page shell** (`<app-search-page>`, `search/search-page.ts`) — the `/search` experience: a `role="search"` query box (seeded from `?q=`), the **entity tablist**, and an empty state, all inside the shared **`BrowseLayout`** (the `/products` shell: breadcrumb, `minmax(0,1fr)`/`minmax(0,3fr)` rail and results columns, `min-w-0` on both). The tablist sits on the header's bottom rule. The facet rail is the shared **`<aec-facet-panel>`**, so `/search` gets the same mobile "Filters" disclosure, active-count badge and "Clear filters" action as `/products`. Results use the `/products` grid breakpoints (`sm:` 2 columns, `lg:` 3), the sort control sits in the results column's toolbar row at the 42px height of `aec-listing-toolbar`, and the mailing-list band closes the page. Results infinite-scroll like `/products`: the same `<aec-pagination-footer>` ("Showing X of Z", a scroll sentinel that loads the next page, a "Load more" button as the keyboard floor), fed by `connectInfiniteHits`, which accumulates pages and resets to page 1 on any query, filter or sort change. The grid dims only during that reset, never while loading more. Search used a Previous/Next paginator until 2026-10-26; it was removed under the Same-Behavior Rule. The footer renders a `<button>` here, not an anchor, because `/search` has no SSR'd `?page=2` (it is `noindex` and fetched browser-side). The toolbar carries the shared `<aec-listing-view-toggle>` (`?view=`, remembered through `createListingView()` as on `/products`). The table view reuses the `/products` row, `tr[aec-product-card]`, fed from the Algolia record. The Vendors tab gets `tr[aec-search-vendor-row]`, the same row rhythm with Name, Headquarters and Integrations. Filters, tab and sort ride the URL (`search-url-state.ts`), so reload, Back and a shared link keep them; a filter change keeps the scroll position, as on `/products`. A failed search shows the `/products` "Couldn't load" message when no results are on screen (`role="alert"`). "Clear filters" clears both tabs, as `/products` clears everything; it shows when either tab has a filter. Uses `surface-base` / `text-primary`; the query input follows the **Inputs / Fields** style. Unlike the other shells this page is **non-cacheable** (`private, no-store` — it is deliberately absent from `ROUTE_CACHE_PATTERNS`) and **`noindex`** (`MetaService.setSearchMeta`, §4.6 — search results aren't canonical content). **Graceful degradation:** when the public Algolia config is absent (local dev / an unprovisioned env / CI) the shell renders a `role="status"` "temporarily unavailable" notice and never constructs the controller — this is also the path the bound e2e exercises. Search/connector logic lives in `search-controller.ts` (the `instantsearch.js` + connectors → signals deviation, ADR 0014); the shell only binds the resulting signals.

- **Entity tabs** — the products / vendors / integrations switcher (`role="tablist"` with `role="tab"` / `role="tabpanel"`), implementing the APG tabs pattern: roving `tabindex` (active = 0), `aria-selected` / `aria-controls` / `aria-labelledby`, and ←/→/Home/End key handling that moves and activates. Active tab carries a 2px `accent-primary` bottom border (the **Navigation** active-route treatment); inactive tabs are `text-secondary` with a transparent border. Per-tab hit counts render as `tabular-nums` `text-secondary`. Switching tabs is pure show/hide of already-materialized signal slices — it never re-queries.

- **Search hit cards** (`<aec-search-product-card>` / `<aec-search-vendor-card>` / `<aec-search-integration-card>`) — grid hit tiles for the `/search` results, the **canonical instantiation of the Cards primitive** (the Cards entry above: `rounded-card` at 24px, `--shadow-card`, `spacing.6` padding. The old 0.5px border, 1px `border-strong` hover and "no shadow" are rewritten by clashes 11 and 12). Distinct from the **Entity cards (index rows)** above: those are `<tr>` table rows for the index/browse pages; these are tiles bound to the **denormalized Algolia record** (Spec §7.1), so there is no follow-up fetch. **The product and vendor tiles are the `/products` card-grid tile** (`product-card-grid.ts`), field for field: the whole card is one link; `aec-logo-or-initial` (the record's `logo_url`) and the `aec-integration-stat` badge share the top row; the name (the card title role, `--t-20`, truncated) and vendor sit beneath, with "Independent" when there is no vendor; products end with the inline rating. The vendor tile puts headquarters where the vendor line goes. Neither shows a description, taxonomy chips, product count or founded year, because the `/products` tile does not. The product tile carries the tile's connector/hybrid `RoleBadge` row too, from the record's `product_role` (AECI-1086); a record indexed before that field existed shows no chip. The integration tile reuses the shared `mechanism-labels` so badges match the `/integrations` table exactly, and is empty until integration seeding returns (AECI-86).

- **In-page facet widgets** (`search/widgets/`) — four generic, **i18n-free chrome** widgets bound to InstantSearch connector render-state slices; the page passes each one its localized heading and the localized labels for any boolean/"all" values (facet _values_ are data and render verbatim). Each names its group with `<fieldset>` + `<legend>` and wraps every control in its `<label>`, and renders nothing when its slice is empty (keeps the rail clean for an empty index):
  - **`<aec-search-refinement-list>`** — checkbox group (multi-select) over string facets (`accent-(--accent-primary)` checkboxes). Shows the first 10 values plus any checked value further down, then a "Show more (N)" text button (`aria-expanded`, `aria-controls`) that reveals the rest in place and becomes "Show fewer" (2026-10-26). The `/products` sidebar renders through it too, so both pages collapse alike. `/search` asks Algolia for up to 100 values per facet, its default cap; it used to ask for 12 and silently dropped the rest.
  - **`<aec-search-numeric-menu>`** — radio group over count buckets (`0 / 1–10 / 11–50 / 51+`, §7.2); radios share a page-supplied tab-unique `name` so two same-attribute menus never collapse into one group.
  - **`<aec-search-range-input>`** — a min/max number-input pair (vendor `founded_year`); index-wide bounds become placeholders + native `min`/`max`; each field has an sr-only `<label>`.

- **Listing-page facet sidebar** (`<aec-facet-sidebar>`, `shared/facets/facet-sidebar.ts`, AECI-143) — the filter rail for `/products` and the taxonomy browse pages (fills the `BrowseLayout` `filters` slot). Deliberately **NOT Algolia-backed**: it reads scoped counts from `GET /api/products/facets` via `httpResource` (captured in the SSR transfer cache), so the host pages **stay edge-cacheable** — their cache key includes `category_id` / `audience_id` / `phase_id` via `LISTING_CACHE_KEY_PARAMS`. **Single-select per dimension** (the API takes one `{kind}_id` per dimension): clicking the active term clears it, another replaces it, `page` resets to 1. Browse pages pass `lockedKind` + `lockedId` to scope to (and hide) their own taxonomy. Renders its term lists through the shared `<aec-search-refinement-list>` widget, plus a "Clear filters" link when any filter is active. The mobile disclosure around the groups (the `< md` "Filters" trigger with its count badge, collapsed by default) is the shared **`<aec-facet-panel>`** (`shared/facets/facet-panel.ts`), which `/search` uses too, so the two rails cannot drift.

- **Header search autocomplete** (`<aec-search-autocomplete>`, `search/search-autocomplete.ts`, AECI-144) — the search-as-you-type field in the site header (the home hero and its pair finder reuse it). This is the project's **first Angular Aria combobox** adoption (ADR 0010): `ngCombobox` + `ngListbox`/`ngOption` supply the `role=combobox/listbox/option` semantics, `aria-expanded`/`aria-controls`/`aria-activedescendant`, the Arrow/Home/End/Escape model, and the CDK-Overlay-positioned popup; we supply only token CSS (`data-[active=true]:` highlight on `surface-sunken`, popup on `surface-raised` with `border-default`). A real `<label for>` names the input (never placeholder-as-label). The default placeholder is **"Search directory"** (`@@app.search.autocomplete.placeholder`), one i18n source for the header, compact trigger and mobile menu. The home hero passes its own (`@@home.hero.search.placeholder`). It says "directory" because the suggestions are products and vendors, not integrations (AECI-985). The `/search` box keeps its own placeholder, "Search products and vendors", which names its two tabs. It **SSR-renders only the static `<form>`/`<label>`/`<input>`** (visitor-state-neutral, so it is safe inside the cached header) and is hydration-enhanced; when the Algolia config is absent it stays a plain submit-to-`/search` field with no error UI (correct for a header control). The listbox is rendered **only when there is ≥1 hit**, so a zero-hit query shows no empty floating panel (keeps it `role=option`-only), and the combobox collapses whenever it has no row, so `aria-expanded` never claims a listbox that does not exist (AECI-1308); Enter with no selection routes to `/search?q=`, which owns the "no results" empty state. A third mount, the claim dialog's Find it step (`shared/claim-dialog/`, AECI-1293), uses the optional hooks the header leaves at their defaults: a visible `label` (`labelVisible`) and a taller `inputHeightClass` (`h-11`). The `searchSettled` output reports each settled result set and each clear. It was written for Find your product on `/vendor-program` (AECI-1287), removed 2026-10-12, and nothing listens to it today. The home pair finder (AECI-1555) uses three more optional inputs, all defaulting to the header's behavior: `kinds` filters suggestions (`['product']`), `ownForm = false` drops the wrapping `<form>` so a parent form holds two fields without nesting, and `fillOnSelect` writes the chosen title into the field. The owned `<form role="search">` is named by `searchName`, default **"Site search"** (`@@app.search.autocomplete.landmark`), which the three header mounts keep. Any mount that can share a page with the header passes its own, so a landmarks list never shows two identical "search" entries: the hero passes "Search the directory" and the claim dialog "Find your listing" (AECI-830).

- **Per-tab sort dropdown** (`<aec-listing-sort-select>`, `shared/listing-toolbar/listing-sort-select.ts`, AECI-175 / ADR 0014; shared with the listing toolbar since AECI-1486) — the sort control above the `/search` results, the same one `/products` and the taxonomy pages render (see "Listing toolbar" below). Products offer the five `/products` sorts with the same default, Newest; Vendors offer Name A–Z. There is no Relevance option (ruled 2026-10-26). A **non-editable Angular Aria combobox + listbox-in-overlay**, the same discrete-choice pattern as the review-form role picker (ADR 0010): `ngCombobox` + `[(expanded)]` trigger, with a `cdkConnectedOverlay` (`usePopover:'inline'`) supplying the floating layer since `ComboboxPopup` renders in-flow. A real label names the trigger (`aria-labelledby`), the active sort shows in the trigger with a ✓ on the chosen option, and labels are `$localize`d. On `/search` it is backed by Algolia **replica indexes** (`SEARCH_RANKING.md` §5a); the active sort mirrors to `?sort=`. There it mounts browser-side once results load (it reads the controller's sort options), so the degraded/SSR shell shows no sort control.
### Extensions: "Built within" (AECI-710)

Two components in `apps/web/src/app/products/product-extensions.ts` render the `product_extensions` relation on product detail (`STAGE_1_5_SPEC.md` §13.3b). Anchor site: **Faire**, the catalog's anchor. Its "Shop more from {brand}" parent strip is the pattern for the sidebar card, and its brand tile row for the body grid.

- **Resources** (AECI-1309, `product-detail.ts`): a "Resources" overline in the metadata sidebar, after the taxonomy groups and before Actions, with up to two inline Forest text links, "Integrations page" and "API documentation". Each opens a new tab with `aec-new-tab-icon` and `rel="noopener nofollow"`, like "Visit website". The group renders only when the product has at least one of the two URLs, on any plan. *(2026-11-14: this describes the shipped page. The redesigned product page has no metadata sidebar (§4, clash 16), and AECI-1778 decides where Resources moves. Nothing here is changed.)*
- **`ProductBuiltWithin`** (`section[aec-product-built-within]`): a "Built within" overline and one link card per host, in the metadata sidebar directly under Vendor. Same card shape and surfaces as the vendor card, because it is the same kind of fact. *(2026-11-14: this describes the shipped page. The redesigned product page has no metadata sidebar (§4, clash 16), and AECI-1778 decides where Built within moves. Nothing here is changed.)*
- **`ProductExtensionsSection`** (`section[aec-product-extensions-section]`, `#extensions`): an `h2` "Extensions built within {product}", one sentence in the reader's terms, then a one-column (two from `sm`) grid of link tiles: logo, name, vendor. Tiles take a `--surface-sunken` wash on hover.
- **The extension's empty Integrations state** (`ProductIntegrationsSection`, `hosts` input) opens with one plain sentence, "{product} runs inside {host}; see Built within.", above the usual empty copy. Unlinked, and only when the section has no rows.
- **Never integration vocabulary.** No table, no lane, no `IntegrationGroupCard`, no direction, **no chevron** and **no count** in the heading. The missing chevron is what keeps a tile from reading as an integration row, so do not add one. One verb, *built within*, names the relation in both directions.

### Product card grid (AECI-190)

`ProductCardGrid` (`aec-product-card-grid`, `apps/web/src/app/products/`) is the **default view** of every product listing — `/products` and, since AECI-657, the four taxonomy browse pages — a buyer-facing catalog grid (anchor site: Faire). The table view above stays available on both via the toolbar toggle (`?view=table`). This is the card-grid variant the note above anticipated.

**Listing toolbar** (`<aec-listing-toolbar>`, `apps/web/src/app/shared/listing-toolbar/`) — the control strip above every product listing: the sort control (`<aec-listing-sort-select>`) on the start edge, a cards/table segmented toggle on the end edge. Extracted from the `/products` template by AECI-657, which is when the taxonomy browse pages got one; before that they had no sort control at all, against `STAGE_1_SPEC.md` §4.5. Presentation-only — the host owns `?sort=` / `?view=` in the URL (both fork the edge cache key), and the shared `productSortOptions()` supplies the option set to both surfaces so they cannot drift. The toggle buttons carry `aria-pressed`; the "Sort" label names the combobox trigger through `aria-labelledby`. Both halves are their own components, `<aec-listing-sort-select>` (`listing-sort-select.ts`) and `<aec-listing-view-toggle>` (`listing-view-toggle.ts`), so `/search` renders the identical two controls in its own toolbar row. The sort control SSRs here, so its ids come from a root-scoped counter (`ListingSortIds`) that restarts for every render, never a module-level counter, which would keep climbing across requests in a Worker isolate and break the label association after hydration. Two details that look cosmetic but are load-bearing: the component sets `host: { class: 'block' }`, because a custom element is `display: inline` by default and the hosts' `space-y-6` on the grid slot silently collapses against an inline box (the first card sat flush against the toolbar until it was fixed); and the sort trigger's `py-2.5` is chosen so both controls measure 42px, matching the toggle group's `border + p-1 + py-1.5 + text-sm` stack. Change one side and change the other. *(2026-11-14: both controls measure 42px today. The 44px button height (§5 Buttons) applies to controls like these on public pages. The browse mock-up (AECI-1790) re-decides the toolbar, so nothing here is changed.)*

  Until 2026-10-26 this was a **native `<select>`**, kept so sorting worked with no JS, while `/search` used the Aria combobox. Chris ruled for one control on every listing (AECI-1486), so the toolbar now renders the `/search` combobox. The cost is accepted: with no JS the trigger does not open, though a `?sort=` in the URL still renders that order.

- **Layout:** responsive `grid` — 1 / 2 / 3 columns (`sm:grid-cols-2 lg:grid-cols-3`), which already caps at three (clash 18). The grid is deliberately *broken* (per the anti-reference against identical SaaS grids): the lead product gets a wide featured card spanning two columns on a warm **Bone** (`accent-warm`) band. The host enables the lead only on page 1 at the newest sort, so its "Recently added" eyebrow stays truthful; otherwise the grid is uniform. *(2026-11-14: ruling R3 decision 6, "The wide lead card goes", is about the product page's integrations list (AECI-1734, §4 "Card grids cap at three columns"). It does not name this `/products` grid. The browse mock-up (AECI-1790) re-decides this grid, so the lead card stays here until then.)*
- **Tile:** one whole-card `<a>` to `/products/:slug`, so the role renders as a **non-link** chip (`RoleBadge`, never an `<a>`-based badge — nested anchors are invalid + an axe failure). The tile carries no category: a product can sit in several, and none is its "main" one. Monogram (`LogoOrInitial`), name (Source Serif), vendor, the overall rating as a `RatingSummary` (`variant="inline"` — the line is **omitted entirely** below the §5.5 gate, so the card reflows with no orphaned label; `RatingSummary` is non-link, safe inside the whole-card anchor), and the integration count as an `IntegrationStat` badge. The tile takes the Cards entry above: 24px radius and `--shadow-card`. Hover lifts per clash 37. The old "borders not shadows" and border-raising hover are rewritten by clashes 11 and 37.

### Integration stat

`IntegrationStat` (`aec-integration-stat`) renders a product's `integration_count` as a deliberate metric — the directory's whole thesis is "which tools connect to what" — in three weights: `inline` (number over noun; table cells + grid), `badge` (a bordered pill with a "link" icon), `headline` (a large Forest figure on the featured card). It pluralizes the noun (1 → "integration"). The glyph is `aria-hidden` — the number + noun carry the meaning. Clash 25 rewrites the zero rule for the large figure.

- **Inline and badge at zero** render "Not yet connected" in `text-secondary`, never a bare `0`. Neither the ruling nor the mock-ups change them, and `product-card.component.spec.ts` pins the card. Whether they follow the large figure is open (AECI-1767).
- **The large figure may read 0** (clash 25, NEW). Chris: "I like the new design". The figure is Source Serif 600 in Forest at `--t-fig` (§3 Figure). A "0" is allowed only with honest supporting text in the same block. The text says what the number counts, what zero means and how to correct it (a "Know of one?" link). `PLAN.md` §5.2, "Copy fixed by legal review for this state", fixes the words. The heading is "We have no integrations for {product} on record". The caveat is "Not on record means we have not found one. It is not proof that none exists." Use them exactly. Mock-up 8 draws the shape at lines 1405 to 1410, but its short form, "integrations on record" and "Not found yet. Not proof that none exists.", is unreviewed copy and is not approved. A zero with no supporting text is never allowed.
- **Say it once.** The numeral is `aria-hidden`. The sentence carries a visually hidden "0 " so a screen reader hears "0 integrations on record" once (mock-up 8, line 1407).
- **One large figure per band** (clash 8). The zero counts as that figure.
- **The glance band** in the vendor portal is not a public page. R2 keeps its sentence-at-zero rule (see "Vendor portal (Stage 2)").
- **Public demand counts** (clash 43, BLEND). "Know of one?" ships first, because it is a correction prompt with no number. No public count of look-ups or demand ships until its rule is written. **A look-up count or an "I need this too" count does not ship before the Privacy Policy text is live** (AECI-1825, ruling R7 on AECI-1738). Settled: the source is pair page views over 90 days with automated visits removed (`PLAN.md` §6.1). The wording is "Looked up {n} times in the last 90 days. Visits we identified as automated are not counted." The count is hidden below 10, and "I need this too" shows its count only above the same floor of 10 (R7, 2026-11-14, Chris "A"). The repeat-click guard is server-side and keyed on a hashed IP and day. Still unwritten: the rule for the count itself, and the code issue that owns it.

### Role chip

One non-link chip for the card grid. It is a public chip (see Badges: "The public chip"), so it is a pill and shares the Tags / Taxonomy-chip surface (bordered, `surface-raised`, `text-secondary`). *(Clash 22 rewrites the AECI-841 metrics: `px-2.5 py-1` and 29px are replaced by the public chip recipe.)*

- **RoleBadge** (`aec-role-badge`) — the product's `product_role`, shown **only** for `connector` / `hybrid`; the default `application` renders nothing, so the chip earns attention by appearing selectively. The grid gates the whole chip row on the role, so an application's tile carries no empty row. The `/search` product card (`<aec-search-product-card>`) uses the same chip and the same gated row, from the Algolia record's `product_role` (AECI-1086).

### Home (Phase 4)

The home page (`/`, `apps/web/src/app/home/`) assembles the §4.1 surface: four bands in `home.ts`, whose doc comment holds the order (epic AECI-1554). Anchor site: **Faire** (`docs/design/home-direction.md`, AECI-181); the page plan is `docs/design/unified-home-direction.md`. Two grounds only: Bone (`accent-warm`) on the hero band and the closing CTA, white (`surface-base`) between them with a hairline `border-t` per band. *(2026-11-14: this describes the shipped page. The redesign allows one Bone band per page (§2, clash 2), so two Bone bands will not both survive. AECI-1789 decides the home bands. Nothing here is changed.)* One card recipe: white fill, 1px `border-default`, `radius-lg`. Every string is i18n-wrapped. Stats data is SSR-resolved from `GET /api/stats/home` (`home-stats.resolver.ts`); browse counts come from the **live** `GET /api/taxonomy` (`home-browse.resolver.ts`), never the stats_cache.

- **Home hero** (`<aec-home-hero>`, `home/home-hero.ts`, AECI-1555) — two columns at `lg`, one below, on the Bone band. Left: the eyebrow, the page's only **Display**-face `<h1>`, the lede, the reused `<aec-search-autocomplete>` with its own placeholder, and the "Popular:" row: up to five product links from `popular_products` in the stats payload, the most-viewed products over 30 days among views the traffic classifier judged a person or could not decide about, recomputed nightly (AECI-1572, AECI-1586). It ships in the SSR HTML. When the list is empty, the row names the five largest categories instead, browser-only from `TaxonomyNavStore`, so the fallback never reaches the cached HTML. Right: the **pair finder**, a bordered white panel ("Do these two connect?") with two product-only autocomplete pickers and a Forest submit. It routes to the product-pair page, a product page, or `/search`. Without JS it is a real `GET /search` form.
- **Credibility row** (`<aec-home-credibility-strip>`, `home/home-credibility-strip.ts`) — the hero band's last row: coverage counts in Forest, each suppressed at 0, a tabular-nums "+{n} in the last 30 days" note after the integrations count (`integrations_added_30d`, shown only above 0), and "Independent. Rankings are algorithmic." with a balance-scale glyph (never a check or shield). The home's only figure row.
- **Browse block** (`<aec-home-browse-block>`, `home/home-browse-block.ts`) — one `<h2>` over four **browse grid** rows (`<app-browse-grid>`, `home/browse-grid.ts`): category, trade (published trades only, linking to `/trades/:slug`), project phase, audience (a curated role list). Each row opens with a one-sentence lede. One chip style: the `TaxonomyBadge` count-chip, count shown only above 0.
- **Argument band** (`<aec-home-why>`, `home/home-why.ts`, AECI-1558) — eyebrow, `<h2>`, two paragraphs, three cited figures as a hairline spec-sheet row with a CSS-only citation reveal and a uniquely named "Source" link each, then three "what we do instead" cards. No reviews claim (AECI-1557).
- **Closing CTA** (`<aec-home-closing-cta>`, `home/home-closing-cta.ts`, AECI-1564) — a Bone band with one bordered white two-column panel: the vendor call to action (Forest link to `/vendor-program`) and "Suggest a tool", which `@defer`-loads `home-feedback-dialog.ts` + `home-feedback-form.ts`.
- **Trust pillars** (`home/home-trust-pillars.ts`) — not on the home. Mounted on `/about` only.

### Unclaimed note

**Unclaimed note** (`<aec-unclaimed-note>`, `shared/unclaimed-note/unclaimed-note.ts`, AECI-1618, ADR 0051): the sentence "Unclaimed · not affiliated with or endorsed by this vendor", word for word as counsel gave it. It is plain muted text in `text-secondary`, 13px. It is never a chip, a badge or a header, and no public label says Claimed.

- **Placement.** An unclaimed vendor, product or pair page keeps its subject's logo, smaller. The 64px header logo gives way to a 32px logo under the `h1`, with the note directly beside it, so a screen reader hears the two together. On the pair page the two subjects are centred, and below `sm` the note sits under the logo instead of beside it, because beside it the sentence would wrap to a sliver. It shows even when the listing has no logo.
- **Elsewhere.** Lists, cards, rows and search show the initial tile for an unclaimed listing, never the logo and never the note. The API returns `logo_url: null` there, so no client has to decide.
- **Cached pages.** `claim_status` is listing state, not visitor state, so the note is safe on cached SSR routes.

### Company facts

**Company facts panel** (`<aec-company-facts>`, `vendors/company-facts.ts`, AECI-1310): a sidebar section on the vendor page *(2026-11-14: this describes the shipped page. The vendor mock-up (AECI-1791) decides where the facts go. Nothing here is changed)*, an overline over a definition list. Each row is a label, the value, then a source note in `text-xs text-secondary`: "Set by AEC Integrations on {date}" with a citation-role "Source" link, or "Set by the vendor". A fact with no value is not a row, and with no facts the panel renders nothing. It replaces the hero's HQ and Founded chips. The product page's vendor card carries one summary line in `text-xs`.


**Company facts note** (`<aec-company-facts-note>`, `shared/company-facts-note/company-facts-note.ts`, AECI-1310): the Open Government Licence attribution, one caption line in `text-secondary`. It is a blanket note at the foot of the vendor page's sidebar and of `/search`, on both tabs. Its licence name is the link and opens in a new tab.

### Auth & Reviews (Phase 5)

Phase 5 adds the authenticated surfaces — sign-in, review submission + display, account, and the admin moderation queue (`apps/web/src/app/{auth,reviews,account,admin}/`, plus the reviews section on the product page). They were built through the v0 → Angular workflow and reuse the established catalog token + type vocabulary so the signed-in experience reads as the **same publication** as the public directory (the Anchor-Site Rule). Every component is token-only (zero hardcoded color), i18n-wraps every visible string, and ships **light-only** (AECI-226 — no `dark:` variants). New form controls follow **ADR 0009** (Signal Forms) and the **Angular Aria** ADR (0010, Accepted — overlay primitives stay Spartan); the cacheable product page stays visitor-state-neutral (see the cache-neutrality constraint in CLAUDE.md).

- **Login** (`<aec-login-page>`, `auth/login.ts`) — the `/auth/login` page: a magic-link email field (a real `<label for>`, never placeholder-as-label) and a Google OAuth button, driven by Signal Forms with a validated `return` path. Non-cacheable, `noindex`. Degrades gracefully when Supabase is unconfigured (the field still renders; no console error). A centred header carries the favicon italic-i mark (decorative, `aria-hidden`) over "Sign in to AEC Integrations". A "Last used" pill (after Resend's sign-in page) sits on the top-right edge of the method this browser started last. The method lives in `localStorage` (`auth/last-sign-in-method.ts`), is read in `afterNextRender` so the SSR HTML stays visitor-neutral, and reaches screen readers through the button's `aria-describedby`.

- **Review form** (`<aec-review-form>`, `reviews/review-form.ts`) — the `/products/:slug/review` submission form and the project's **first Angular Aria form** (satisfies AECI-133). The two 1–5 **star-rating controls** (overall + onboarding) are horizontal Aria **listboxes** (`role=listbox`/`option`, roving tabindex, `aria-selected` highlight); role-at-company is a non-editable Aria **combobox**; optional fields (years-using, would-recommend) are held as signals and merged at submit. Signal Forms own validation (`SubmitReviewSchema` from `@aeci/shared`); a confirmation replaces the form on success, errors are retryable inline. The headline (5–100) and body (50 min) length floors are stated in persistent help text under each control per the §5 → Inputs named rule, not held back until the error fires. **Layout (AECI-987):** the form + context rail (§5 → Layout shells). The rail names the product and its vendor (logo, name, vendor off the resolver's `ProductDetail`), says a person checks every review before it is published, and links the reviewing guide. The sign-in notice, already-reviewed and success states keep the same canvas and rail, in columns 1 to 7.

- **Star display** (`<aec-review-stars>`, `reviews/review-stars.ts`) — the **read-only** rating display used by the summary averages (decimals, e.g. 4.3) and per-review rows. Glyphs are decorative (`aria-hidden`); the precise value is announced via `aria-label`, so shape/color is never the sole signal.

- **Rating summary** (`<aec-rating-summary>`, `reviews/rating-summary.ts`) — the **compact, editorial** rating for product **cards and table rows** (the list-surface counterpart to the five-star `ReviewStars`, which stays on the detail page). Deliberately numeral-forward — a single gold star (`--accent-rating`, `aria-hidden`), the average (Source Serif, `tabular-nums`), and a review-count caption — so a catalog reads like a publication, not a G2/Capterra ratings wall (a PRODUCT.md anti-reference). It **owns the §5.5 visibility gate** (`RATING_VISIBILITY_MIN_REVIEWS`) so it behaves identically bound to a `ProductListItem` or a denormalized `AlgoliaProductRecord`: shown only at ≥5 reviews and a non-null average. Two variants for the two empty-state needs — `inline` (grid + search cards) renders **nothing** when gated and collapses the host to `display:none` so it leaves no flex/gap; `cell` (dense table) renders the `–` en-dash empty state (the same convention as the vendor / category cells). The value is announced once via `role="img"` + `aria-label`, never by glyph color alone. Closes the 2026-06-12 trust-audit P0 ("zero social-proof on cards"); the existing "Highest rated" / "Most reviewed" sorts now have a visible counterpart.

- **Product reviews section** (`<aec-product-reviews>`, `products/product-reviews.ts`) — the reviews block on the product detail page. Enforces the **≥5 summary gate** (§5.5): `reviewCount === 0` → a "Be the first to review" empty state; `0 < count < 5` → the list + an overline threshold note, no averages; `count ≥ 5` → the list + the bordered averages summary. "Load more" paginates client-side. Section labels use the AECI-230 **overline** role (`aec-overline`). Each review is an `article` named by its title. **Vendor replies** (AECI-1178, rewritten by clash 14) sit inside that article and inside the review card, as a nested panel under the review text. The old rule put them below the card as an indented sibling block (`ms-6`, `sm:ms-10`) on `--surface-sunken` with a full `border-default` border, to avoid a card in a card. Clash 14 lifted that ban (§4 "Cards may nest"). The panel has a small leading mark, the label "Response from {vendor}" and the date, and it takes no shadow of its own. Its fill token is open (AECI-1765, §4 "Open values"). Reuse it for any answer that belongs to a parent item but is written by someone else.

- **Review CTA** (`<aec-review-cta>`, `reviews/review-cta.ts`) — the **cache-neutral** call-to-action embedded in the (cacheable) product page. SSR / pre-hydration renders a neutral "Write a review"; **client-side hydration** (`afterNextRender`) reconciles to `anon` ("Sign in to review" → `/auth/login?return=…`) or `authed` ("Submit a review"), so the cached HTML never carries session state.

- **Account** (`<aec-account-page>`, `account/account.ts`) — the `/account` page (non-cacheable): a read-only email, an editable display name (Signal Forms `PATCH`), and a **delete-account** flow gated behind a Spartan dialog confirmation that calls the GDPR `DELETE /api/account` (anonymizes the user's reviews). Sign-out is menu-only (AECI-986): the page manages profile, review history, and deletion; session exit lives in the account menus (§Navigation → The Overflow Rule). **Layout (AECI-987):** the 7xl canvas. From `lg` a sticky section nav (Profile, About you, Your reviews, Delete account) takes columns 1 to 3 and the sections take 4 to 12, in the `ACCOUNT_ONBOARDING_SPEC.md` §7.2 order. The nav links are plain anchors with absolute hrefs (`/account#profile`), never a bare `#id` (the `<base href>` trap); each target carries `scroll-mt-8`. Inputs cap at `max-w-2xl` inside the Profile panel. "Your reviews" is a divided list across the full column, with the date and status badge at each row's end. No side-by-side forms: Profile and About you differ in height and would leave a blank half.

- **Admin shell** (`<aec-admin-shell>`, `admin/admin-shell.ts`) — the `/admin` layout + role gate. A non-admin resolver result renders the global 404 surface (the admin area is never *revealed* to non-admins); an admin sees the header, nav, and **live queue badges** seeded from `GET /api/admin/summary` and decremented in-place by each queue via `AdminSummaryStore` (no round-trip). Since AECI-922 that is one badge per Operations queue — pending reviews, open correction requests, open vendor claims — with their **sum** on the closed Operations category trigger and on the header account menu; a zero renders no badge at all (`ADMIN_PANEL_SPEC.md` §5.0c). The Re-index queue badges its own entry only and is in neither sum.

- **Moderation queue** (`<aec-review-queue>`, `admin/reviews/review-queue.ts`) — the `/admin/reviews` child route. Lists pending reviews with product, reviewer email, queue age, body, and toxicity score; **client-side sortable** (default: toxicity high→low, nulls last — worst content first). One-click **approve**; **reject** opens a Signal-Forms reason field (required, Aria textbox). On success the row leaves, a live region announces it, and the shell badge ticks down. A toxicity score ≥ 70 gets a warning highlight — flag, never auto-block.

### Requests & Moderation (Phase 6)

Phase 6 extends the admin area with **vendor-request moderation** (`/admin/requests`) and **reviewer ban management** (`/admin/reviewers`) (`apps/web/src/app/admin/{requests,reviewers}/`), plus the repeat-offender → ban flow grafted onto the Phase 5 moderation queue. Both new pages are children of the existing `<aec-admin-shell>` (same role gate + live badge), reuse the established catalog token + type vocabulary so the moderation surfaces read as the **same publication** as the public directory (the Anchor-Site Rule), are token-only (zero hardcoded color), i18n-wrap every visible string, and ship **light-only** (AECI-226 — no `dark:` variants). Spartan stays for the one overlay primitive (the ban dialog).

- **Public request form** (`<aec-request-form-body>`, `requests/request-form-body.html`) — the shared body behind both the routed `/{products,vendors}/:slug/{claim,correction}` page and the in-place `RequestDrawer`. One Signal Forms model; the active `kind` picks the shared Zod schema (`ClaimFormSchema` / `CorrectionFormSchema`). Both free-text bodies carry a **20-character floor**, so both state it in persistent help text under the textarea along with what to actually write — the claim's "Anything we should know?" reads as an optional afterthought otherwise, and its `body` column is NOT NULL (see the §5 → Inputs named rule). In the **drawer** variant the panel is a clipped flex column with **one** scroll port: the eyebrow/title/close/subtitle block is pinned above it and the submit control is pinned below it in a bordered `--surface-raised` bar, so only the fields scroll and "Send claim"/"Send correction" is never scrolled out of reach. The bar full-bleeds past the port's horizontal padding and owns the panel's bottom padding (the port has none), which is what keeps content from showing beneath it. The routed **page** variant keeps normal flow — it has no scroll port of its own and the browser window is the scroller. **The context rail lives on the routed page only** (`requests/request-form.html`, AECI-987): the form + context rail pattern, naming the company and the product page a claim came from (the claim resolver's data), the claim or correction next steps, and a docs link. It leaves once the request is sent, because the confirmation carries its own next steps. The body owns the page header, so below `lg` the rail follows the form. The drawer has no rail.

- **Request queue** (`<aec-request-queue>`, `admin/requests/request-queue.ts`) — the `/admin/requests` child route. **Corrections only since AECI-922** (`ADMIN_PANEL_SPEC.md` §5.0c): the request pins `kind: 'correction'`, the heading reads "Correction requests", and vendor **claims** live on `/admin/claims`. Lists corrections as cards with a status badge, the linked target product/vendor, submitter, and submitted-age. **One** client-side filter (status: open / resolved / rejected), an `aria-pressed` toggle-button group. Each row surfaces the **possible-duplicate** flag computed at submit (an open sibling request for the same target) — informational, never auto-deciding; the admin resolves every request by hand. The **domain-match** chip left with the kind filter: it compared a *claimant's* email domain to the vendor's, and a correction identifies nobody. The linked **Linear issue** opens out. **Resolve** is one-click; **reject** opens an optional reason field. On success the row leaves, the Operations nav badge ticks down, and a `role=status` live region announces it; a capped-note shows when the server holds more rows than the page loaded.

- **Reviewer bans** (`<aec-reviewer-bans>`, `admin/reviewers/reviewer-bans.ts`) — the `/admin/reviewers` child route: the list of **currently-banned** reviewers (newest ban first) and the home for **unbanning** (`PATCH /api/admin/reviewers/:id` `{action:'unban'}`; the in-flight row's button disables, a live region announces the result, an already-unbanned row degrades gracefully). The ban *action* itself is raised from the moderation queue's repeat-offender flow (below), not here.

- **Repeat-offender prompt + ban dialog** (in `<aec-review-queue>`, `admin/reviews/review-queue.ts`) — when an admin rejects a review and that pushes the reviewer past the rejection threshold, the `PATCH /api/admin/reviews/:id` response carries a `repeat_offender` payload that raises a dismissible prompt. Confirming opens a **Spartan ban dialog** (`BrnDialog`) with a required reason; the dialog is driven **imperatively** from the event handler (`openBan()`), never from an `effect()` (a `BrnDialog.open()` inside an effect throws NG0602). Banning calls `PATCH /api/admin/reviewers/:id` `{action:'ban', reason}`.

### Removal election and removals section (AECI-1618)

Two small surfaces, both built from existing parts. **Anchor reference:** Base44, "Delete your account" (Mobbin screen `6abe261c-e5ce-4cad-933f-a80daae66e7a`), for the irreversible-action dialog. Components for the surface come from the same site, per the Anchor-Site Rule.

- **The removal election** (`<aec-vendor-removal-election>`, `vendor/components/vendor-removal-election.ts`) sits on the vendor plan panel's `ended` state, owner seats only. It is a quiet block, not a banner: a small overline heading, one sentence with the closing date, and a secondary button, "Remove my text". The button opens a confirmation dialog from the click handler, never from `effect()`. The dialog lists the exact fields it will blank, says plainly that this cannot be undone, and says what stays. Its confirm button uses the primary style, and the warning is in the words, not the colour. After an election the row reads "You removed your text on {date}." A failed read says so and offers a retry, because a missing control would hide a right the vendor has.
- **The removals section** (`<aec-brand-asset-removals>`, `admin/vendors/brand-asset-removals.ts`) sits under the `/admin/vendors` table as an `h3` and a plain table. It has no paging, because the API returns the full set and the set is small. This is a deliberate difference from the table above it, not a lapse in the Same-Behavior Rule. The hold and lift controls open a reason field that is recorded in the audit trail. A failed load offers a retry. `/preview/admin-brand-asset-removals` renders it over a fake API.

### Operator console (Phase 8.3)

Phase 8.3 (`docs/ADMIN_PANEL_SPEC.md`, epic AECI-572) turns the moderation area into the **operator console**: `<aec-admin-shell>`'s `h1` becomes "Admin", its nav groups into **Insights / Catalog / Operations**, and `/admin` opens on the Overview. **No new Mobbin anchor was picked, deliberately** (spec §9.10): the console inherits the Phase 5/6 admin queues' visual language and the home stats cards' card vocabulary — bordered `--surface-raised`, border not shadow, Forest figures, `tabular-nums`, Bone/Clay-deep for anything cautionary. One publication, one voice (Anchor-Site Rule). Token-only, i18n throughout, light-only.

- **Overview** (`<aec-admin-overview>`, `admin/overview/`) — the `/admin/overview` child route and the 05:00 analytics digest as a live page. A traffic-classes card leads (AECI-1346), then four `<aec-stat-tile>`s plus a catalog-totals card, a 30-day chart of requests by traffic class, ranked top-sources / top-products lists, and a five-item status strip. A **Recompute** button re-reads the bundle with `?recompute=1` to fill the two network-dependent status items, announcing via a polite live region.

- **Resolution honesty is a visual rule here, not just a data one.** Every tile's caption states the window it covers, and the unique-visitors definition renders *next to the number* rather than in a tooltip. The response's caveats render through `<aec-admin-notes>` — a Note/Caveat chip plus localized prose keyed off the API's machine-readable `code`, placed where the reader meets the figures it qualifies: above them on Overview and Catalog, and as a closing "About these numbers" section on the screens that read top-down. **One component renders it everywhere** (AECI-835), so a caveat's wording cannot differ by screen. Unmeasured values read "Not measured", never `0`.

- **Charts are hand-rolled SVG** (`admin/charts/`, spec §8 / §13 D3): `<aec-sparkline>` and `<aec-stacked-bar-chart>`, geometry from pure functions so they are SSR-safe, sized by `viewBox` rather than measurement, series in Forest and Clay-deep (distinct in hue **and** lightness) by default. A chart is never the only representation of a number: the stacked bar carries a visible legend and a visually-hidden `<table>` of the full series, and a sparkline only ever accompanies a figure already rendered as text. An empty series renders nothing rather than a flat line implying a measured zero.

- **Three column marks on `<aec-stacked-bar-chart>`, each legend-and-table only when present** (AECI-877, AECI-1346). **Degraded**: dimmed and hatched, for a day measured without its inputs. **Not measured**: a dashed `--border-input` outline in place of bars, for a day with no measurement at all; never a zero-height column, and a window of nothing but outlines still draws. **Boundary**: a dashed `--text-secondary` rule in the gap before a column, for a change in how the data was counted, with one legend entry per distinct change. They compose on one column. A caller passing none draws exactly as before. A chart with more than two series passes `seriesFills`; the traffic classes use `--text-secondary`, `--border-input`, Forest and Clay-deep, each at least 3:1 on the surface and each touching pair distinct in hue or lightness (`admin/overview/traffic-classes.ts` carries the measured ratios).

- **Operator lists are tables, not cards** (AECI-694). The rule is the shape of the data, not the surface: when every field is short and every row has the same fields, the operator is comparing a column down the page and a card makes them read a paragraph per row. `/admin/vendors` and `/admin/users` were cards and are now tables; the moderation queues stay cards because a review's body is long free text. The console's table markup is one pattern, first written in `admin/system/system-status.html`: `overflow-x-auto` wrapper, `min-w-[…]` on the table, a visually-hidden `<caption>` naming it, `th[scope=col]` in the head, `th[scope=row]` on each row's identity cell, `text-end tabular-nums` on counts, and the Entity-cards en-dash-with-`aria-label` for a genuinely absent value. **Table headers are sentence case**, per the Sentence-Case Rule, which explicitly strikes the overline treatment for them.

- **A sortable header selects a sort on the first click and REVERSES it on the second.** `<th aec-sort-header>` (`shared/sort-header/sort-header.ts`) renders a button plus a ↑ or ↓ and sets `aria-sort` to the direction currently in effect for that key. Clicking an inactive header adopts that column's **natural** direction — one copy, in `ADMIN_VENDOR_SORT_DEFAULT_ORDER` / `ADMIN_USER_SORT_DEFAULT_ORDER` (`packages/shared`), which the API's `apps/api/src/lib/sort.ts` also resolves its ORDER BY from, so the arrow cannot disagree with the list. Clicking the active header sends `?order=asc|desc`. *(It originally did not flip, because no list endpoint took an `order` parameter; that held over a two-key API and became a defect at seven — an arrow on a clickable header reads as a toggle, and a second click that silently no-ops is the worse lie. `ADMIN_PANEL_SPEC.md` §5.7 carries the full reasoning.)* The corollary is unchanged and matters more: **a column the API cannot order by gets no control at all**, and stays plain `<th>` text with no hover state. A header that looks clickable and reorders the 25 rows on the current page presents a page as a ranking, which is worse than no control. (`/admin/users` Last sign-in was the standing example until the API began ranking the whole filtered set before it chooses the page, `ADMIN_PANEL_SPEC.md` §5.8.)

- **Relative time is for ledgers, and it always carries the exact instant** (AECI-694). `<aec-relative-time>` (`shared/relative-time/`) renders a compact span ("4h", "2d") beside an info control **whose accessible name IS the full `medium`/UTC datetime** — not an `aria-describedby` pointing at the panel, so a screen-reader or keyboard user never depends on a transient overlay to learn when something happened. Sighted users get the panel on hover, focus or click. It is used **only** in the audit trail, where "how long ago" is the question being asked; every other timestamp in the console is absolute `medium`/UTC, because "Profile created" is a date, not a staleness signal. Two implementation notes worth keeping: the panel is a `cdkConnectedOverlay` rather than the cheap CSS tooltip (`home/home-why.ts`) because every table it appears in sits inside `overflow-x-auto`, which clips an in-flow panel; and `now` is read once at construction, matching the console's no-live-updates rule, so the stamp is as fresh as the fetch that produced the row.

- **Explanatory copy that does not deserve a paragraph is an `<aec-info-hint>`** (`shared/info-hint/`, AECI-915) — a 16px "i" button next to the thing it explains, with the text in a `cdkConnectedOverlay` on hover, focus and click. It generalises the control `<aec-relative-time>` introduced above and keeps that component's binding rule: **the accessible name of the button IS the text**, and the panel is `aria-hidden`. Not a `title` attribute (not reliably keyboard-reachable, inconsistent in screen readers, unstylable) and not an `aria-describedby` pointing at the panel (which makes assistive tech depend on a transient overlay and double-announces). Reach for it when the copy is a sentence or two of *optional* orientation; if a reader needs it to complete the task, it is body text, not a hint. First consumers: the vendor portal's taxonomy cards, at two levels — the facet hint beside the heading and each term's description beside its row. **Never nest one inside a heading**: an accessible name is computed from descendants, so a hint inside an `<h3>` makes the whole paragraph part of that heading's name and wrecks the screen-reader heading list. Put it in a wrapper row *beside* the heading. Nothing lints this and axe cannot see it.

- **Console detail screens carry a breadcrumb, not a back link** (AECI-777, spec §5.0b). `<aec-admin-breadcrumb>` renders once in the shell, under the category row, as `Admin › Operations › Vendors › Acme Corp`. It replaces the four hand-rolled "Back to …" links the parameterised routes each carried, which had drifted into four class strings and two wrapper shapes for one job. Three rules. **It follows the public site's breadcrumb treatment** rather than inventing a console one, per `docs/ADMIN_PANEL_SPEC.md` §9 item 10 — the same `<nav aria-label="Breadcrumb">` + `<ol>`, the same `›` separator marked `aria-hidden`, the same `aria-current="page"` on the last crumb, sentence case (the Sentence-Case Rule names breadcrumbs explicitly as *not* overlines, so the uppercase variant on `/taxonomy` is the outlier, not the model). **Only ancestors are crumbs** — never siblings — so it is a location readout and not a second navigation surface; the category crumb is plain text because there is no route behind it, and neither is the page you are on. **It contains no heading**, because the shell owns the only `h1` and each screen the only `h2`; a heading in the trail would sit between them and break heading order, which is the same conclusion the nav's group labels reached twice already. Its consequence for the screens: with the trail carrying the way back, a detail `h2` names **which** vendor / account / claim / catalogue rather than the entity type, showing the same fallback word the trail does until the fetch resolves.

- **An audit action is rendered in English, with the raw token beneath it.** `describeAuditAction()` maps the vocabulary `apps/api` actually writes; an action this build has never heard of humanises its token rather than rendering blank, which is mandatory because `audit_log.action` is deliberately an open string and the table is excluded from the retention prune. Keeping the token visible is not redundancy: the description is what makes the ledger readable to someone who has not memorised the vocabulary, and the token is what makes a row greppable against a log line.

### Vendor portal (Stage 2)

The signed-in vendor's portal (`apps/web/src/app/vendor/`): the vendor-level row
(Vendor Overview / Profile / Products / Messages / Seats) or, once a product is open,
the product-level row (Profile / the four facet tabs / Integrations / Reviews, plus Catalogue on a `connector`-role product; Reviews since AECI-1179), plus the AECI-606
Integrations section. Gated by
`vendorMeResolver`, `noindex`, non-cacheable.

**Every section has its own address: `/vendor/:vendorSlug/<section>`** (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.2). The sections are `routerLink` anchors over a `<router-outlet/>`, not buttons over an in-page switch, so a section is linkable, bookmarkable, and reachable with Back — and `aria-current="page"` is driven by `routerLinkActive` rather than by hand. The vendor slug leads because the address should say which company is being edited; bare `/vendor` resolves the caller's own vendor and redirects. The nav's first item reads **"Vendor Overview"**, not "Overview": it sits inside a page whose `h1` is the company name, and it has to stay self-describing in a screen-reader's link list and a history entry.

**One header, and it follows the context** (`vendor/vendor-dashboard-tabbed.ts`,
§6.11). A breadcrumb sits where the eyebrow was: `Vendor portal › Company` on vendor pages,
`Vendor portal › Company › Products › Product` once a product is open. The `h1`, the "View
public page" link and the tab row all switch to the open product, and a quiet "← Back
to Company" link sits at the end of the breadcrumb line. Never stack a second heading
or a second nav row under the first: two headers of different sizes left it unclear
which one owned the page, and a segmented product row beneath an underlined vendor row
read as a button group rather than navigation. Breadcrumb links are `text-secondary`,
hover Forest, no underline, with the current crumb in `text-primary`, matching the
public product page.

**The tab row is a horizontal row under the title**
(`vendor/vendor-portal-nav.ts`, §6.4) — a 14rem side rail spent a seventh of a wide
page on five short links, and the editors it fronts are what want the width. The
active item carries the 2px `accent-primary` bottom border over the row's hairline
(`-mb-px` + `border-b-2`, the `/search` entity-tab treatment); the header gives up
its own rule so the row reads as attached to the panel it switches. Narrow viewports
**scroll the row sideways** rather than wrapping it — a wrapped tab row breaks its
own underline across two lines — and `overflow-y-hidden` prevents a second scrollbar
axis. There is exactly one row at every width, never a `md:hidden` duplicate. It is
deliberately **not sticky**: `section-nav.ts` is sticky because it is an in-page jump
nav on a long scroll, and a router nav has no such coupling. The same component draws
the product row, so the two can never drift apart visually.

> **The underline colour is `.aec-nav-tab[aria-current]` in `styles.css`, not a Tailwind utility.** `styles.css` sets `border-color` on `*` **outside any cascade layer**, and an unlayered rule beats every layered rule regardless of specificity — so `border-transparent` and `border-(--accent-primary)` silently never reach the tab and it renders `border-default` grey in both states. This defeats every border-color utility in the app (~165 usages); the `/search` tabs now use the same class, matched on `aria-selected="true"`; the real fix is moving that `*` rule into `@layer base`, which is an app-wide visual change and wants its own issue.

- **Products is a plain link to a product list** (`sections/vendor-product-list-page.ts`, §6.11). The list is one bordered `--surface-raised` card of whole-row links: a small logo, the name, and a quiet "Primary" tag. Primary first, then by name. Since AECI-1218 each row ends with the checklist score ("Checklist" over "2 of 3") and the plan badge in a fixed-width column, so Free and Managed line up down a long list. It replaced a search-box dropdown in the nav, which had to go once "Products" became a breadcrumb destination.
- **A product page shows one product** (`sections/vendor-products-page.ts`). The form opens with its read-only name block, and a URL naming a product the vendor does not own says so, with a link back to the list, rather than quietly rendering a different one.

- **Each taxonomy facet is its own tab, edited inline** (AECI-994, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.12). Categories, Trades, Audiences and Phases each render the full vocabulary as a checklist, a `<label>` around a real checkbox with the term description beside it, and one page Save. Under a ticked Audience or Phase sits a bullet list (`vendor/components/vendor-bullet-list-editor.ts`): an input per point, a plus button that adds at the bottom, and bordered 32px icon buttons to move up, move down and remove. Reordering is buttons rather than drag so it needs no second interaction model. Unticking a term with points confirms in a `BrnDialog` that lists what will be lost. The history below is superseded.
- **(Superseded) Taxonomy reads as a summary and writes in a modal** (AECI-915). The four facets shipped as fieldsets of `aria-pressed` toggle chips — 107 chips on one screen — which made "what is this tagged as" a visual diff and left the per-term descriptions nowhere to go. Now each facet is a card in a **two-column grid**: name, a right-justified pencil, and one row per *assigned* term. This is the exception the "Don't use modals as the first thought" rule contemplates — the alternatives were tried and shipped, and the read case and the write case genuinely want different densities. The picker (`vendor/components/vendor-taxonomy-facet-dialog.ts`) is a `BrnDialog` opened imperatively from the click handler (never an `effect()`, NG0602), and every row is a `<label>` wrapping a real `<input type="checkbox">` so the whole row is the click target and the keyboard and ARIA behaviour is native rather than re-implemented over `role="checkbox"`. **Its Save persists**, because there is no `CanDeactivate` guard on this app and a Save that only staged would lose work silently; a failure keeps the modal open with the draft and puts the error inside it.

- **The Overview is a landing page, not an inventory** (AECI-983, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.10). Three blocks: the access strip, a glance band, and a "What needs you" list of whole-row links (`rounded-(--radius-md)` bordered rows, a Lucide severity icon, a status pill, an `aria-hidden` chevron with `rtl:-scale-x-100`). Row hover moves the **surface** (`hover:bg-(--surface-sunken)`), never the border, for the cascade reason recorded above. Pill border tones are the unlayered `.aec-pill-conflict` / `.aec-pill-attention` classes in `styles.css`, the same escape hatch as `.aec-nav-tab`.
- **The glance band reuses the former home stats-card vocabulary, with two departures** (`vendor/components/vendor-glance-band.ts`). The home cards were deleted in AECI-1554; the vocabulary stands here: three `rounded-(--radius-lg)` `--surface-raised` cards, a `font-display text-5xl` figure, a quiet `--text-secondary` line, and every label row `min-h-9 md:min-h-12` so the figures align even when a label wraps at `md`. **A zero is never a bare 0**: it renders a sentence ("No conflicts", "None open"). *(2026-11-14, R2: the portal takes the new tokens and nothing more. Clash 8's one large figure per band and clash 25's large zero are public-page rules, so the three figures and the sentence at zero stay here. AECI-1748 maps `text-5xl` to `--t-fig`, so the figures render 28 to 40px.)* **Departure one: a non-zero conflict figure is `--status-error`**, not Forest. `conflict` is the one sanctioned red, and a conflict count that reads like good news defeats the tile. At zero there is no figure, so red never appears for good news. **Departure two: tile hover moves the surface**, not the border, because a border-colour utility does not apply here. **Only a tile with something to do is a link.** At zero, In conflict and Suggestions are plain cards with a 32px Forest check badge. With work waiting, the tile is a link with a badge beside the figure: a red X for conflicts, a Forest "!" for open suggestions. The badges are `aria-hidden`; the figure and the link's `aria-label` carry the state.
- **The Views period toggle is an `aria-pressed` button set, not Angular Aria.** The tile was removed on 2026-10-13 (Chris). The glance band shows two tiles until AECI-941 rebuilds Views with a real figure and this toggle. Aria@22 ships no radio group (ADR 0010), and the admin date-range control (`admin/traffic/traffic.html`) already made this call, so the vendor surface follows the shipped precedent: a `fieldset` with an sr-only legend, a sunken segmented track, and the pressed segment filled Forest by the unlayered `.aec-period[aria-pressed='true']` rule, which also sets the pressed segment's focus ring to Forest so it does not vanish. Visible "1d", accessible name "1d, last day" (WCAG 2.5.3).
- **The connector seat's Catalogue tab (labeled "Catalog" since AECI-1262) is a row card, not a table** (AECI-1083, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.16). It shows only on a `connector`-role product, last in the product row. The listings sit in the product list's bordered `--surface-raised` card, one row each: the name in the body face at 16px (on a span, because the `h3` element rule is unlayered serif), a "View listing" link, then each match as a phrase with a quiet `--surface-sunken` "Counts toward reach" pill. The admin triage table needs 64rem, so the portal does not borrow it. Edit opens the form inline under its row, capped at `max-w-2xl`; one form at a time, focus moves in on open and back to Edit on close. Disabled buttons swap to the sunken surface rather than dimming. Text blocks are capped at 52ch, because `npx impeccable detect` measured ~96 characters a line at 65ch in Atkinson.
- **(Superseded by AECI-1218) The plan panel had a compact strip for the quiet state.** Plans moved to the product level (`STAGE_2_PAID_TIERS_SPEC.md` §13.1 decision 2), so the full panel lives on each product's overview. The vendor overview first carried a one-line plan summary; that is gone too, and the vendor checklist takes the full width (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18). The compact strip and the "Account access" heading are gone.
- **The Free plan surfaces** (AECI-1218, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.18). **Anchor: the in-repo mockup** (`docs/design/mockups/free-plan-portal/`) **and DoorDash Merchant's "Get ready to go live" setup list on Mobbin** (numbered steps, one action each, the optional step marked in words).
  - **Checklist card** (`vendor/components/vendor-checklist.ts`): a bordered `--surface-raised` card, the `font-display` heading with an "x of y done" score at the right, a segmented bar (`aria-hidden`; the text carries the score), then a divided `<ol>` of steps. Each step has a 28px round marker: the number, a Forest-filled check when done, or a lock when the step is outside the product's plan. An sr-only "Done" / "Not done" / "Not done, optional" rides in the title, so state is never colour alone. Optional steps carry a borderless `--surface-sunken` "Optional" tag. One action per step: a bordered link-button, "Looks right" (`vendor-looks-right.ts`), or a sunken "Available on Managed" note.
  - **Plan badge** (`vendor-plan-badge.ts`): the word "Free" (outlined) or "Managed" (sunken fill, strong border). Text, never colour alone. Portal only. No public page carries a plan or account badge (AECI-1264).
  - **Product plan panel** (`vendor-plan-panel.ts`): "Free includes" / "Managed adds" lists under `aec-overline` microheadings (a size utility cannot beat the unlayered `h3` rule), a plain price line (no "Draft price" tag since the 2026-10-08 ruling; it follows the per-vendor override, `STAGE_2_PAID_TIERS_SPEC.md` §13.13), one bordered call to action, and decision 10's line under a hairline. No box inside the card: `npx impeccable detect` flags a bordered price box as a nested card.
  - **Plan-ended banner** (`vendor-plan-ended-banner.ts`): above the tab row on every portal page, the warm Bone wash with a strong border, two columns ("Still works" / "Now read-only"), the Forest primary button. Calm: no status colour, no alert role, no dismiss button.
  - **Product-ended banner** (`vendor-product-ended-banner.ts`, AECI-1408): the plan-ended banner's sibling for one product, under the product header on every product tab. One Bone band with a strong border: the heading and one dated line on the start edge, the Forest "Go to Billing" button on the end for an owner seat, wrapping below on narrow screens. No lists, because the plan panel on the product's overview already names what Managed adds. Hidden whenever the vendor-wide banner shows. Anchor: the vendor-wide banner itself (Anchor-Site Rule), so no new Mobbin reference.
  - **Legal notice band** (`legal-notice-band.ts`, AECI-1592): the site-wide notice of a material legal change, in the app shell under the header on every page, while its 30-day window is open. One full-width Bone band with a strong bottom border: the bold dated sentence, the one-line summary and the "Read the new version" link on the start edge, an icon dismiss button on the end. Calm like its anchor: no status colour, no alert role, no live region. Unlike its anchor it can be dismissed, because it runs on every page for a month. Anchor: the product-ended banner (Anchor-Site Rule), so no new Mobbin reference.
  - **Locked field**: the control stays `readonly` on the sunken surface, and a lock glyph plus a one-line reason sits between the label and the control, tied with `aria-describedby`. One notice above the form names every locked field once.

**It is not a static page — it live-updates while it is open** (AECI-516, shipped 2026-08-19; `docs/STAGE_2_REALTIME_SPEC.md`, transport decision ADR 0023). A poll loop (`vendor-live-sync.ts`) reads a per-vendor freshness cursor — every 20 s focused, 60 s unfocused, **paused with no timer when the tab is hidden** — and asks the shared store (`vendor-portal-store.ts`) to refetch only the sections that actually moved, so a claim approved or a plan activated by an admin lands without a reload. There is no socket. Two visual consequences are binding: **a background refresh must never reflow the control under the pointer or steal focus** (staleness is the lesser harm), and **a section holding unsaved edits is never overwritten** — it defers and offers a quiet "Updated elsewhere — reload this section" affordance instead. Toggle-shaped writes (Yes / No, and pressing either again to clear it) render optimistically and **roll back with a visible error**; form-shaped writes stay pessimistic, because "Saved" before it saved is a worse lie than a short wait.

**No new Mobbin anchor was picked, deliberately** — the same call the operator console made above (`ADMIN_PANEL_SPEC.md` §9.10), and recorded here because the Anchor-Site Rule's "record the anchor site with the surface" had never been satisfied for `/vendor`. The portal inherits the Phase 5/6 admin-queue and Phase 8.3 console vocabulary: bordered `--surface-raised` cards, border not shadow, the eyebrow-then-heading header, Forest figures, `tabular-nums`. The §6.11 breadcrumb reuses the public product page's breadcrumb, so it does not introduce a second anchor. It is an internal, signed-in surface reading the same catalog the public directory renders, so a second reference site would make AECi read as two products. One publication, one voice (Anchor-Site Rule). Token-only, i18n throughout, light-only.

- **Integrations tab: a list of links, not a list of cards** (`<aec-vendor-integrations-section>`, `vendor/components/`, reshaped 2026-09-28 by AECI-1149). Rows still group by the counterpart product, but each row is now a link to that integration's own page: the counterpart's mark and name, one line saying what is shared, and a status pill. Nothing on the tab expands in place any more.

- **Daily reminder email switch** (AECI-1204, `vendor/components/vendor-nudge-mute-toggle.ts`, on Messages above the notification list). **Anchor site: Shopify admin** settings cards, the same anchor as the integration detail page below (Mobbin screens `e53a5210-9e2c-405c-ab2d-87de1432dd5e` and `f6ea66fe-de5c-4239-aaf8-30d7bb3f85f2`). A bordered `--surface-raised` card, title and a two-sentence description on the start edge, the switch on the end, and a status line ("On" or "Off since {date}"). It is a native `<button role="switch">` with `aria-checked`, because Angular Aria has no switch (ADR 0010). ON means "email me". The off track is `--text-tertiary`, which keeps 3:1 against the card (WCAG 1.4.11). No switch renders until the saved state has loaded: a same-size `--surface-sunken` pill holds the place, so the control never shows a state it does not know. The write is optimistic and rolls back with a visible error.
- **Product picker** (AECI-1244, `<aec-product-combobox>`, `shared/product-combobox/product-combobox.ts`). The one way to pick a published product by name. It serves the vendor "Add an integration" counterpart, the vendor catalogue match form and the admin connector mapping edit. **Anchor site: Shopify admin**, its product search dropdown (Mobbin screens `b5b15af1-6439-49ed-98e3-de1377b29f00` and `54fca623-f156-426f-adcc-10b701e2d3b1`). A text box with a leading search glyph and a trailing clear button. It searches as you type after a 250 ms pause, from two letters, and the latest query wins. The popup lists rows A to Z, each a 32 px `LogoOrInitial`, the name and the vendor, with the active row on `--surface-sunken`. Searching, no match and a failed search show as one quiet line in the popup, never an empty listbox. It is an editable Angular Aria combobox over an Aria listbox inside a `cdkConnectedOverlay` (ADR 0010), the `aec-select` wiring. Enter picks and never submits the form. The caller owns the label, the hint, the error and the chosen state, which reads as the product plus a Change button. Focus moves to Change after a pick and back to the box after Change. The result count reaches the page's one live region through the `announce` output. The control has no region of its own. There is no Search button: a picker that waits for a button press reads as dated.
- **Integration detail page** (AECI-1149 to AECI-1153, `vendor/integration-detail/`, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17). **Anchor site: Shopify admin** (Settings → Checkout; an order detail page), chosen for the same reason as the rest of the portal — non-technical staff use it daily. A title block (the two product marks, the title, the status pill, "View public page"), then a two-column body: a left `<nav>` of section links with scroll-spy (`aria-current="location"` on the item under the sticky bar) and five bordered `.id-card` sections on the right, in order — Overview, Data that's shared, Integration links, Change requests, Settings. Below `lg` the nav sits above the cards and is not sticky. Once the title block scrolls out of view a slim bar pins to the top of the viewport with the same marks, title, pill and "View public page" link, browser-only (SSR renders no bar).

- **Every coloured border on the page is component-scoped CSS, not a Tailwind utility** (`integration-detail-styles.ts`'s `ID_STYLES`), for the same reason `.aec-nav-tab` and `.aec-pill-*` are unlayered in `styles.css` above: an unlayered `border-color` rule on `*` beats every layered `border-(--…)` utility everywhere in the app. The status pill's tone (`.id-pill[data-tone]`), the Settings danger area's red border (`.id-danger`), the Yes/No segmented control's pressed state (`.id-seg-btn[aria-pressed]`) and the section nav's current-item rule (`.id-navlink[aria-current]`) all live in `ID_STYLES`, and every component in the folder includes it.

- **Tooltips are built exactly like `shared/info-hint`, everywhere on the page.** Every label, pill and flag carries an `i`-style trigger: a real `<button>` with a `cdkConnectedOverlay` panel that is hoverable (a grace period across the gap), dismissible on Escape, and persistent until the pointer or focus leaves. The full text also sits in the trigger's `aria-describedby`, always in the DOM, so assistive tech never depends on the overlay opening (WCAG 1.4.13). No panel holds a link or a control.

- **Direction is always the caller's own frame.** Rows render "To {other}" / "From {other}" / "Both ways" — the same idea the public pair page uses, reframed per caller. The stored `a_to_b`/`b_to_a` never reaches the browser as-is.

- **The row status pill is its own component, not `<aec-agreement-badge>`.** `Data that's shared` renders a caller-seat pill (`.id-pill[data-tone]`: `ok` Forest, `conflict` red, everything else neutral) rather than reusing the public badge component, because the two name different things — the portal's pill is the *caller's* position, the public badge is the *agreed* state. Their wording still cannot disagree: the pill's tooltip quotes the same `STAGE_2_ATTESTATIONS_SPEC.md` §6.2 outcome sentence verbatim, and `conflict` stays the one red state on both surfaces.

- **A disagreement shows both positions in the row, not as an error.** The Change requests section's disagreement item is a title naming the data and each side's stance, the caller's answer and reason beside the other company's, with "They have not given a reason" when there is none. Two companies describing a flow differently is a disagreement to resolve, not a defect in either product — red belongs to the status pill alone.

- **Yes / No are plain, `aria-pressed` toggle buttons in a segmented control** (`.id-seg`), because they are commands that write on activation, not values you pick and submit (ADR 0010 governs the latter). Pressing the pressed button again clears the answer. **The toggles show only on a row the caller has not answered** (AECI-1246): an answered row reads as plain text ("Yes" or "No" with its icon) and a **Change** link, which reveals that row's toggles until a save or Escape, because a stray click on a filled toggle changed answers vendors meant to keep. "The direction is wrong" folds its corrected row into a "You submitted a change" box under the denied row (`.id-change-box`: sunken fill, accent inline-start border, no divider above it, so it reads as part of the row and not as another data row), with Change and Cancel. The reason form opens *inline, under the row*, never behind a second disclosure. Native `<select>` elements pick the data type and direction (ADR 0010 deviation (d), unchanged in shape by this page, just relocated) — not an Aria combobox or `<aec-select>`, because each is one value from a closed, plain-text list in an ordinary form.

- **One polite live region on the surface, many assertive ones.** Successful writes announce through the one channel; failures are alert text beside the control that failed. The region lives in the dashboard shell, not on this page, fed by `VendorPortalAnnouncer` (`vendor/vendor-announcer.ts`), unchanged by this page's rebuild. **Never add a second persistent one.** A **local** `role="status"` is still allowed only for immediate feedback on an action the user just took, beside the control they took it with — this page has none: even the "row already exists" case on Add a data flow announces through the shared channel rather than a local region. Rule and audit: `STAGE_2_REALTIME_SPEC.md` §6.3 / §6.5.

- **The status pill's tooltip says what happens next**, not a permanent sentence under the row. It lists, in order, the caller's reason, the other company's reason, and the §6.2 outcome sentence verbatim, so a vendor who says no to a false row and sees no visible consequence can still find one without a second click. A "Things that need you" callout above the sections surfaces the same information as one-sentence links for anything that currently needs the caller. Contract: `STAGE_2_ATTESTATIONS_SPEC.md` §6.2, `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.17.2.

- **Copy never says attestation, claim, provenance, data object, contest, counterparty, mechanism or iPaaS** (§6.17.8). It says "Company", never "vendor", and a change is written "from X to Y" in words — never the arrow glyph, which this surface reserves for a data flow's direction (the Arrow Rule, above).

- **Copy carries the trust promise.** Nothing implies answering Yes or No affects ranking or placement; the only search reference is that search refreshes within a day; "Verified" is framed as an account status arranged with AEC Integrations, and the unverified state explains what verification unlocks rather than 403-ing a vendor out of their own data.

### Product docs (Stage 2, AECI-1104; layout AECI-1259)

Three surfaces, home → section → article (`apps/web/src/app/docs/`), all inside one **help-center shell** between the site header and footer. **Anchor site: Devin (DeepWiki)**, Mobbin screen `c3936cdb-13b2-4b54-b2a2-c7ccf723dd1b`, which replaced the Zendesk anchor on 2026-10-09 (AECI-1259). DeepWiki supplies the structure, density and restraint. AECi keeps its own type, tokens and Forest links. It is a public, edge-cached reading surface, so it reuses the `/legal/*` and `/methodology` prose vocabulary rather than the portal's cards. Everything is built from the docs manifest, so a section with no pages shows nowhere (AECI-1248).

*(2026-11-14: the docs chrome below describes the shipped sizes and weights. Weight 500 (`font-medium`) is outside §3, which keeps 500 for two chips only. No issue owns snapping it yet. It is raised for Chris.)*

- **Shell** (`docs-shell.ts`, the `/docs` layout route). From `lg`: a 16rem sidebar on `--surface-raised` behind a hairline end border, spanning the shell's full height, and a content column. The shell carries a hairline top border under the site header. A per-guide search box sits under the guide toggle (AECI-1270). There is no "Ask" box.
- **Guide toggle** (AECI-1271): the first thing in the sidebar on every docs page, a `nav` named "Guides" holding two links, "General" (`/docs`) and "For vendors" (`/docs/vendors`). It replaced the vendor guide's "Back to the help center" link. The current guide's link carries `aria-current="true"`, never `"page"`, because a deeper page is not the guide's landing. It is the `.aec-nav-tab` underline on a hairline: `text-sm` medium `--text-secondary` links, the current one `--text-primary` over a 2px `--accent-primary` bottom border. It is navigation, not a segmented control, so it never takes the `aria-pressed` button-group look. Derived from the URL alone, no cookie or storage. Mobbin anchor: Devin (DeepWiki) screen `470ef8ee-da99-4893-9a15-bde5f3744177`, whose sidebar puts its top-level destinations above a hairline and the scoped page tree below. The per-guide docs search box (AECI-1270) sits directly under it.
- **Docs search box** (AECI-1270, `docs-search.ts`): directly under the guide toggle, full sidebar width, searching the current guide only. Its label names the guide: "Search General" or "Search For vendors" (visually hidden `label`, placeholder "Search"). An input on `--surface-base` that takes the Inputs recipe: 44px high, the field edge, 12px radius, 16px text, and a leading `--text-secondary` magnifier. *(2026-11-14: the shipped box is 36px with a 1px `--border-default` edge, which is about 1.25:1 and fails the 3:1 floor. AECI-1764 applies the recipe.)* Client only: the SSR HTML holds a fixed 44px slot so the tree does not jump, and the slot goes when there is no docs index in the config. Results open in a top-layer popup (an Angular Aria combobox in `cdkConnectedOverlay`): a `--surface-raised` panel with a hairline border and the menu shadow (`--shadow-menu`, §4, AECI-1770), up to 24rem wide. Each row is a `text-xs` `--text-secondary` trail ("Section / Page"), the heading in `text-sm` medium `--text-primary`, and a two-line `text-xs` snippet. Matched words are `mark`: underlined in the heading, `--text-primary` medium in the snippet, never a highlighter fill. The active row is the `--surface-sunken` pill the tree uses. No hit shows "No matching sections" as plain text, and a polite live region announces the count. With no row, settled or still in flight, the combobox stays collapsed (AECI-1308). Mobbin anchors: DeepWiki's search field (screen `470ef8ee-da99-4893-9a15-bde5f3744177`) and Devin's results list (screen `e37a4e69-9a61-4f36-803d-edbd89c1229d`), whose rows lead with a breadcrumb trail.
- **Sidebar tree** (`nav` named "Help center" on the General guide): "Help center" first, then each General section in manifest order, its pages indented under a `--border-default` start-edge guide line. A single-page section is one item. **On a vendor guide page the tree is the vendor guide's own** (AECI-1265): a `nav` named "Vendor guide", then "Vendor guide" and its pages, overview and claiming first (AECI-1271). The URL alone picks the tree, so the SSR HTML is the same for every visitor. All groups are expanded. Items are `text-sm` `--text-secondary`, no icons. The current page is a `--surface-sunken` rounded pill with `--text-primary` medium text and `aria-current="page"` (`routerLinkActive`, exact match, so a section item is current only on its own index). From `lg` the tree is sticky at the viewport top, at most one viewport tall, and scrolls on its own when it is longer. The site header is not sticky, so nothing sits above it.
- **Top bar** over the content only, with a hairline under it. Left: a slash breadcrumb derived from the URL *(2026-11-14: clash 31 rules the separator `›`, and AECI-1777 moves this trail onto the shared breadcrumb, §5 Navigation "The breadcrumb")*. "Help center", then the section, on the General guide. On the vendor guide the trail starts at "Vendor guide", which is its one section (AECI-1271). Ancestors are links. The current place is text with `aria-current="page"`. On an article the trail stops at the section, as DeepWiki's does, because the `h1` names the page. Right, articles only, from `sm`: the pre-formatted "Last updated" line in `--text-secondary`.
- **Below `lg`** the tree becomes a panel under the top bar, closed by default. A bordered icon button at the start of the top bar ("Docs menu", `aria-expanded`, `aria-controls`) toggles it. Escape and any navigation close it. DOM order is top bar, panel, page at every width, so the SSR HTML is identical for every visitor.
- **Article column** (`docs-page.ts`): a centred 42rem column. A Source Serif `h1` at `--t-36`, 28 to 36px (`.aec-docs-title`, the Headline role brought down from a hero), one muted lede line from the frontmatter description, then `.aec-prose aec-docs-prose`. No overline. Docs `h2`s are `--t-24` and `h3`s `--t-20`, both serif at or above the 20px floor. *(AECI-1748 moved them from 1.875rem, 1.375rem and 1.125rem, which were off the type ramp (§3).)* Below `sm` the "Last updated" line moves under the lede.
- **Heading ids.** Every body `h2` and `h3` has a stable GitHub-style slug id, unique per page, built at manifest time (`docs-markdown.ts`). The template renders the headings itself, because the `[innerHTML]` sanitizer strips `id`. Headings carry `scroll-margin-top: 1.5rem`.
- **"On this page" rail** (`docs-toc.ts`), from `xl` only, sticky at the far right of the content. One short dash per `h2`, the closing "Related" excluded, none at all below two headings. The current dash is longer and `--text-primary`. Others are `--text-tertiary`, which holds the 3:1 non-text floor because a closed dash is the link's only visible mark. Each link is at least a 24px target (WCAG 2.2 target size), which sets the dash pitch. Hover or keyboard focus opens it into a bordered `--surface-base` panel listing the headings. The labels are visually hidden, never removed, so the links stay named. Links are plain anchors to the article path plus `#id`, opted in to the smooth in-page jump. This lands with AECI-1752, in review. Until then they are router links with a fragment. The first dash is current in the SSR HTML; an `IntersectionObserver` moves it only after the first browser render.
- **Plans comparison** (`docs-plans-comparison.ts`, `/docs/vendors/plans` only; its two cards are `shared/plan-cta/plan-cards.ts`, shared with `/vendor-program`): the one place the docs use cards. Placed by a `<!-- docs:plans-comparison -->` widget line and rendered outside `.aec-prose`. Two plan cards side by side from `sm` (stacked below): `--surface-raised`, 1px `--border-default`, `rounded-lg` (24px on the new scale), no shadow. Only the components §4 names take `--shadow-card`, and whether the plan cards join them is open (AECI-1765). Managed carries the 2px `--accent-primary` featured border. Each card: a 20px serif plan name, a one-line summary, a 2rem serif price with a `text-sm` unit, one action (Free: a hairline-ringed "Claim your listing" button at the Managed button's size; Managed: the Forest-filled "Claim your listing", the surface's one accent action; both actions open the claim dialog, AECI-1293. E8.1 removed the inquiry line and reply promise, and E8.2 retired "Start with Managed", both 2026-10-19), then a benefit list ("Includes" / "Everything in Free, plus"). Under the cards, the sort rule on a Bone (`--accent-warm`) band. Then a three-column comparison table: hairline row rules, uppercase `text-xs` group rows (`th scope="colgroup"`), a Forest check or a `--text-tertiary` dash per cell with a visually hidden "Included" / "Not included", or a printed value (price, billing). Labels say what the vendor gets, not the portal control's name. Unshipped work never appears in it. Classes are unlayered `.aec-plan-*` in `styles.css`. Mobbin anchor: Mintlify's billing page, screen `c74405c6-a307-4e35-b8eb-21a1129ce5f3`.
- **Plans calls to action** (`shared/plan-cta/plan-cta.ts`, on `/docs/vendors/plans` and `/vendor-program`, AECI-1285, reworded by AECI-1293). One claim workflow (`VENDOR_PROGRAM_PAGE_SPEC.md` §15): every main control opens the claim dialog and reads "Claim your listing", the Managed card, the rail and the phone bar included (E8.2 retired "Start with Managed", 2026-10-19). Never "Get Managed", "Buy" or "Start now": public pages still lead with the claim, and paying appears only on the portal's Billing tab ("Pay by card", AECI-1396). Each control stays a link to `/search` for no-JS and new-tab clicks (`/vendor-program#find-your-product` until that section was removed on 2026-10-12). Claim is the only plan action. Questions go through a text line, "Questions?" plus an underlined "Contact us" link (`aec-plan-contact-link`), a plain link to `/contact` with no topic and no form (E8.1, 2026-10-19; it replaced the plan inquiry dialog). It sits in the closing panel and, on `/vendor-program`, under the FAQ. It is not on the hero. Placements: (1) a row under the intro, the Forest "Claim your listing" at the one button height (44px) on its own; (2) the Managed card's button, full card width at 44px, and the Free card's button at the same height as a secondary button with its hairline edge instead of the Forest fill. Clash 20 retires the `py-3 text-base` and `py-3.5 text-base font-semibold` sizes. From `sm` each card is a row subgrid of the pair, so the two buttons sit on one line although the Managed price row is taller; (3) on the docs Plans page only, from 90rem, a `w-44` `.aec-plan-card` under the rail's dashes (plan, price, a "Claim your listing" button at 44px), sticky with them; (4) below `lg`, a slim bar fixed to the bottom on `--surface-base` behind a hairline, shown only after the intro row scrolls away and hidden while a full call to action is on screen, with `scroll-padding-bottom` and body padding reserved so it never covers a focused link or the page end; (5) the "Getting Managed" panel, the page's closing block: a full-width Forest band, a 24px serif headline in `--surface-base`, one terms-and-safety line (the monthly and the annual price), an on-brand "Claim your listing" button (Bone fill, Forest text, clash 3) beside the contact line in `--surface-base`, and two numbered next steps that describe the claim dialog (find your listing and send your claim, then a person reviews it and emails the result), shown only while the button opens the dialog. *(2026-11-14: the "Getting Managed" panel is `aec-plan-cta-panel` (`shared/plan-cta/plan-cta.ts`), one shared component. It is a rounded Forest card inside the content column that closes the page, not a full-width band. It is the Forest feature card clash 1 allows (§2), where the shipped card differs in two ways: its ink is white and not Bone, and its button is white with Forest text and not the Bone main button (clash 3). AECI-1802 restyles it. Nothing here is changed.)* On `/vendor-program` the panel is its own section (an `h2`). A signed-in vendor seat sees "Go to your portal" wherever a control would open the claim dialog. The docs Plans page has a muted intro line above the hero button, linking to `/vendor-program` with an always-underlined Forest link. Every click fires `plan_cta_clicked` with its placement and page (`docs/ANALYTICS.md` §4).
- **Vendor program page** (`vendor-program/vendor-program.ts`, `/vendor-program`, AECI-1284 to 1286, `VENDOR_PROGRAM_PAGE_SPEC.md` §3). A plain editorial landing page, not a SaaS hero. Mobbin anchor: **Mintlify** (marketing home, screen `4cc8ee93-cf4e-4b9f-a905-8e11b2b9da9e`, for the hero: a left-aligned serif headline, one lede, a filled and an outlined button side by side; the plan cards already follow its billing page). **The rule:** No narrow column with a blank right half: fill desktop width by layout. (Chris, 2026-10-12.) From `lg` every section uses the whole `max-w-7xl` container, by split, grid or side by side, never by stretching prose; there is no rail column (the rail card stays on the docs Plans page only). Layout: a Bone hero band, a 12-column grid from `lg`: the `h1`, the lede (`max-w-[52ch]`) and the button pair in seven columns, no eyebrow (`impeccable detect` bans a kicker above the `h1`), and "How claiming works" in five, a `surface-base` card of three Forest-disc numbered steps (a `p` label, not a heading; hidden below `lg`). Then `h2` sections, most split five and seven: the heading left, the content right. Section patterns: "What changes when you claim" (second, after the hero) splits five and seven, with two bordered `rounded-lg` cards side by side from `sm`, each an overline ("Before you claim", "Once you claim and update it"), the real `aec-maintenance-marker` chip and one line; "What a free claim gets you" and "What Managed adds" are one pattern (Chris, 2026-10-12): each splits four and eight, the heading and lede on the left (Free's seat line, Managed's terms line), and on the right a hairline-ruled two-column list from `md` of the shared item `li[aec-vendor-program-benefit]` (`vendor-program/vendor-program-benefit.ts`). An item is a plain semibold title, never a link, then the body in `--text-secondary`, then, when the line has a docs page, a standalone semibold Forest "Learn more" link with the new-tab cue, whose sr-only suffix names the title. No subgroup headings in either section; "How listings are sorted" is a rounded Bone panel, split in halves; the "Coming soon" section and its "Not available yet" pill were removed on 2026-10-13 (the page shows only what ships); the FAQ is native `<details>` rows between hairlines, a chevron icon that turns on open (`motion-reduce` off), so every answer is in the SSR HTML. Find your product, the search section that sat third, was removed on 2026-10-12: the claim dialog starts with the same search. The closing Forest panel splits six and six from `lg` with its actions stacked, then seven and five with the actions in a row from `xl` (its `split` input). Prose measures stay at `52ch` (`text-lg`) and `56ch` (`text-base`) on phones; inside a split's seven columns a paragraph fills its column, which is about 80 characters at 1280px. Atkinson's `ch` is a wide digit, so `65ch` measured about 87 characters a line. The plan cards carry `data-plans-cta="card"` here, so the phone bar also hides over them. Every docs link, including each "Learn more", opens a new tab with `aec-new-tab-icon` (the page-scoped exception in the Link Treatment Rule); inside a sentence the in-text link class keeps the icon inline (`[&_svg]:inline`).
- **Claim dialog** (`shared/claim-dialog/`, AECI-1293, `VENDOR_PROGRAM_PAGE_SPEC.md` §15): one per page (`aec-claim-dialog-host`), `@defer`-loaded on the first claim click, so the cached HTML carries none of it. The one exception is the listing request page (AECI-1474, §2.5): it embeds the flow inline (`ClaimDialogFlow` with `embedded`), not the dialog, so its SSR HTML carries the empty typed-in You step. Mobbin anchor: Mercor's "Complete your profile" modal (screen `a39d82f4-c61a-44cb-be88-f81eec9320a8`): the title and "Step N of 4 · name" with a thin Forest progress bar in the header, a hairline under it, the step body scrolling, a hairline footer with a bordered "Back" left and the Forest primary right. The shell is a BrnDialog over the CDK overlay on `--surface-base`, no shadow, after the home feedback dialog. Type: a 24px serif "Claim your company", which becomes "Claim <Company>" once a found listing names it (AECI-1364), a `text-sm` line ("Claiming is free. We set up your account when we approve your claim."), a 44px close button. From `sm` a centred `w-[min(92vw,36rem)]` panel, `rounded-lg`, hairline border, scrolling inside at `85vh`; below `sm` a full-screen sheet (`100dvh`, no radius) so the footer stays above a phone keyboard. Each step opens on a 20px serif `h3` that takes focus. Step 1 is the site's search box with a visible label and an in-text "Type it in" button; step 2 shows the chosen listing on a `--surface-raised` strip with "Change", or the name and website fields, then the claim form's identity fields (`requests/claimant-fields.ts`); step 3 is three full-width radio rows (`min-h-11`, the checked row on `--accent-primary-soft`); step 4 the "Additional comments" textarea. The receipt reuses the claim confirmation (a Forest check disc, "What happens next" on `--surface-raised`) and its one action is "Done". Errors are `role="alert"` lines under their field, and Continue focuses the first bad field.
- **"How did you find us?" field** (`<aec-found-via-field>`, `shared/found-via/found-via-field.ts`, AECI-1063, `docs/ANALYTICS.md` §11b). One optional question on the claim dialog's comments step, the claim page and drawer, the mailing band, `/updates` and the feedback form. Mobbin anchor: Grain's "How did you hear about Grain?" select, whose list names ChatGPT beside search and colleagues (screen `ec616781-d530-45c0-ac6b-1ec13cb7bd31`), with the conditional box from User Interviews' "Other" row (screen `47fb20dd-38db-4ec9-9783-17a47e3186e6`). The choice is the stacked `aec-select` with the "Clear answer" row once answered, like the "About you" questions. A follow-up text box (200 characters) appears under it for AI tool, search, vendor, event and other, and its label follows the choice. The field owns one polite `sr-only` live region that says when the box appears. Moving to a choice without a follow-up empties the box. Never required, never blocks a submit. Hosts bind it through `value`/`valueChange` and `detail`/`detailChange` (ADR 0010), not `[formField]`.
- **Listing request page** (`vendor-program/list-your-product.ts`, `/vendor-program/list-your-product`, AECI-1474, `VENDOR_PROGRAM_PAGE_SPEC.md` §2.5). The claim dialog's form out of its dialog, so the dialog's Mobbin anchor carries over. The standard canvas, then from `lg` a 12-column grid with `gap-x-12`: the explainer in columns 1 to 5, sticky at `top-8` (a serif `h1` at the vendor program hero's size, one `max-w-[52ch]` lede, then a semibold `h2` "What happens next" over a four-item `<ol>` in the `/vendor-program` "How claiming works" style: a 28px `--accent-primary` number disc, `aria-hidden`, beside a semibold title and a `--text-secondary` line, `space-y-5`), and the form panel in 6 to 12. The list keeps the left column from reading blank beside the tall form. The panel is the dialog's surface: `--surface-base`, hairline, `rounded-lg`, no shadow, a 24px serif `h2` "Request a listing" over the flow's progress bar, `h3` steps and hairline footer. Opened on the typed-in step, the indicator reads "Step 1 of 2" on You and "Step 2 of 2" on Comments. Find, reached by Back, shows none. Embedded, the flow drops its inner scroll and the receipt has no "Done". Focus starts in "Product or company name" without scrolling. Below `lg` they stack: explainer, list, then the form.
- **Previous / next pager** at the article foot (`nav` named "Previous and next articles"): a hairline, then two text links, "Previous" left and "Next" right, each a muted label over the neighbour's title in Forest. No cards. It walks one section in order and never crosses into the next section.
- **Docs home** (`/docs`, `docs-home.ts`): widens into the shell's content column (`max-w-6xl`, AECI-987). The header keeps 42rem and summaries `max-w-[36rem]`; from `lg` the audience split and "All sections" run two columns, each row carrying its own hairline. It lists General sections only, never the vendor guide (AECI-1265). Vendors reach their guide, claiming included, through the guide toggle (AECI-1271). The `h1` "Help center" and a one-line intro, then the **audience split** as a divided list: readers and reviewers. Each audience is an Atkinson 600 subhead (`.aec-docs-subhead`), a one-line summary and its section links. An audience with no section yet drops out. Below it, "All sections" under an overline: a divided list of each section's linked name, summary and page links.
- **Section index** (`/docs/<section>`, `docs-section.ts`): widens like the docs home (AECI-987). The header and the intro prose keep 42rem; from `lg` the page list runs two columns. The section label as `h1`, its summary as the lede, then a divided list of the section's pages, each a linked title with its one-line description. A section intro, when declared, renders as `.aec-prose`: its lead above the list, its headed parts below with bound heading ids. The vendor guide's landing (`/docs/vendors`) uses it to say who the guide is for, point readers and reviewers back to General, and carry its "Current limits" note.
- **Reading order:** top bar, sidebar, then the page. On an article: the article, the rail, then the pager.
- No screenshots in content at v0 (`STAGE_2_PRODUCT_DOCS_SPEC.md` §4). Light only. Token-only. The docs chrome takes no shadow of its own. The search popup takes the menu shadow, named above. Chrome is i18n-wrapped, and the Markdown body is content. The docs classes live unlayered in `styles.css` after `.aec-prose`, for the reasons the Unlayered-Heading Rule and `.aec-nav-tab` record.

### Inputs / Fields

Native inputs driven by Signal Forms today (ADR 0009); richer controls use Angular Aria per the provider note above (ADR 0010, Accepted) — `select`/`radio` are realised via combobox/listbox (Aria@22 ships neither), and these discrete-choice controls bridge into Signal Forms via `[(value)]`+`(valueChange)`, not `[formField]`. Styling binds to tokens. Clash 23 (NEW) rewrites the look. The floor stays: every form control has a visible edge at 3:1 (WCAG 1.4.11). AECI-1764 builds it for `FIELD_INPUT_CLASS`, `.aec-field-control` and `aec-select`.

- **Style (clash 23):** 44px high, `rounded-control` (12px), a 1px solid **field edge** (§2), a `surface-base` fill, and 16px of side padding (`spacing.4`). Body typography role at 16px (`--t-16`). A leading icon moves the text start to 48px (mock-up 6, lines 251 and 254). The field edge measures 3.71:1 on white and 3.55:1 on raised (§2). The shipped `.aec-field-control` still paints `--border-input` (3.42:1). Which token survives is open (§2 "Open values", AECI-1747 and AECI-1764). The shared recipe (`shared/form-field/form-field-classes.ts`) and the `aec-select` trigger draw the colour through `.aec-field-control`, an unlayered class in `styles.css`. Do not reach for `border-(--token)` utilities on a control: the unlayered `* { border-color }` rule beats every layered utility, so they never apply.
- **The fill is always `surface-base`.** The mock-up's pre-ruling look was borderless with a shadow, and it is dropped because the edge is what carries the 3:1.
- **A control on Forest or on the hero panel** takes a `surface-base` fill. Field edge on the hero panel is only 2.77:1 (§2). A white fill on Forest is 12.34:1, so the boundary holds. A translucent Bone wash is never a field's only boundary. It measures about 1.29:1 on Forest. The header search belongs to AECI-1744.
- **Placeholders** are `text-tertiary`, which is 4.83:1 on white. They sit on the field's white fill, never on Bone or sunken.
- **Focus:** the edge shifts to Forest, paired with the 3px outline at a 3px offset (mock-up 6, line 29). The outline survives forced-colours mode. The mock-up's `.field:focus` sets `outline: none` and draws a 4px halo from `color-mix()` (line 253). Both are dropped, because `color-mix()` is banned in components (clash 6) and a box-shadow halo vanishes in forced colours. No halo, no underline animation. On a Forest ground, the hero panel and the footer ground the ring is Bone, set by AECI-1747. A Forest ring on the hero panel is 1.20:1 and must not be used.
- **Error (clash 23):** the edge thickens to 2px in `status-error` (`#B3261E`, 6.54:1 on white, see §2 → Status). The mock-up draws 1px plus a 1px ring, which is 2px (line 465). An icon and an inline message come with it. The message is 14px at weight 600 in `status-error`, with the icon 8px before it (line 463). Colour is never the sole error signal. The mock-up's Clay-deep edge on a Clay-soft fill is dropped, because §2 reserves red for errors and Clay deep for warnings. The fill stays `surface-base`. The red edge is `.aec-field-control[aria-invalid='true']`, so the attribute that tells a screen reader is the one that paints the border. Set `aria-invalid="true"` (or `AecSelect`'s `invalid` input) and the border follows.
- **Segmented control:** a 44px frame (3px padding, 1px `border-strong`, 12px radius) around 36px segments with an 8px radius and 14px text at 600. The pressed segment is solid Forest with white text (mock-up 6, lines 255 to 258, clash 5). It also takes a tick. The mock-up does not draw that tick. The tick rule and the forced-colours mapping are in Badges, "A selected filter chip".
- **Form footer** (`FORM_FOOTER_CLASS`): a hairline, then the secondary action at the start and the primary at the end. Below `sm` the two stack full width with the primary on top (`flex-col-reverse`). The DOM keeps secondary then primary, so the keyboard order matches the row from `sm` up. The secondary takes `sm:me-auto`. A bare `me-auto` would stop it stretching in the stacked column. First used by `/welcome` (AECI-1296).
- **Submit stays enabled.** A form's primary action is disabled only while the request is in flight. Pressing it with a bad answer shows every error and moves focus to the first bad field. A disabled submit gives no reason, and it also swallows Enter in the form's text fields. `/welcome` and the `/account` "About you" save follow this (AECI-1296), as the claim dialog's Continue already did. Sign-in, the review form and the `/account` display-name save follow it too (AECI-831). Sign-in's button is also disabled until hydration: event replay never cancels a native submit, so a click on the SSR HTML would still run the native form submit and drop `?next=`. On the review form the four required controls carry `aria-required="true"`.
- **Disabled:** background fades to `surface-sunken`, text-secondary text. Pointer events disabled. **Never via opacity** (AECI-982): `disabled:opacity-50` on the Logo URL field took `#0A0A0A` over white to ~3.7:1 — below the AA 4.5:1 floor — and no token review can pin an opacity's ratio because it composites against whatever sits behind the element. The token pair is measurable: text-secondary on surface-sunken is 7.0:1. Axe cannot catch this class of defect — it exempts disabled controls from color-contrast — so field text treatments are regression-tested as class assertions.
- **Help text:** the Caption role (`--t-14`, §3), `text-secondary`, directly under the control, always rendered. Optional-field marking (`(optional)` on the label) is unchanged — unmarked still means required.

**Named rule — URL and read-only field text stays readable in every state (AECI-982).** A field that displays a URL, a stored reference, or any value the reader may need to copy back out keeps WCAG AA contrast in every state it can render: default, hover, focus, read-only, disabled, invalid, browser-autofilled, and long-overflow. Read-only uses the sunken-surface tell with `--text-primary` text (the §8 promise that a downgraded vendor's data is still there and still readable); disabled uses the recipe above; invalid keeps the field's own text tokens and carries the failure in the `--status-error` border, inline label and icon, never by dimming the value. Browser autofill is pinned by the global `:-webkit-autofill` guard in `styles.css`, which repaints the UA's autofill background with `--surface-base` so the declared text token keeps its measured ratio. The shipped case was the shared Logo URL field (`apps/web/src/app/shared/logo-input/logo-input.ts`), whose disabled dim was the AECI-982 production defect. Any field carrying a rule the user can trip — a minimum length, a range, a format, an expected kind of answer — states it in persistent help text under the control, with the constraint sentence itself set in `<strong class="text-(--text-primary)">` so it survives a skim of the surrounding guidance. A requirement that only appears in the error message after the user has already failed is a defect, not a validation strategy: the user writes an answer, gets rejected, and has to reverse-engineer what was wanted. The rule has an a11y half that is not optional: the hint's `id` is in the field's `aria-describedby` **from first render**, and the error `id` is *appended* to it when the error fires (`'x-hint x-error'`) rather than replacing it — so the requirement is announced on focus and survives the failure. Because the hint now carries the requirement, the error states the *failure* tersely ("Add at least 20 characters.") instead of restating the instruction — the two render stacked, and a paraphrase of the hint reads as noise. Shipped on every field in the app with a length floor: the claim body and correction body (20 chars, `requests/request-form-body.html`) and the review headline (5–100) and review body (50, `reviews/review-form.html`).

### Badges

> **No verification iconography on public surfaces.** This rule applies through Stage 2
> and later. No checkmark, shield, tick, or "Verified" fill may imply that AECi endorses
> a vendor, product, or integration. Provenance and account state are carried by visible
> text because text can state the exact claim. The legacy `vendors.verified` mirror is a
> paid-entitlement signal. It rendered as a neutral account-status label until AECI-1264
> removed that label (2026-10-09), and it must not come back as a glyph or a badge. This is also why `home-credibility-strip` uses a balance scale rather than
> the shield-check it originally shipped with.

**The public chip (clash 22, BLEND).** Chris ruled BLEND with no note. The blend is the clash recommendation: one public pill chip with an optional leading icon, one dense variant, and no Clay-soft category chip. This rewrites the AECI-841 "one chip spec" (`px-2.5 py-1`, `0.75rem`, `font-medium`, `rounded-mark`, 29px). The AECI-841 lesson stands: **chip metrics travel with the vocabulary, not the component**. A second set of padding is a second vocabulary. AECI-1763 builds `aec-chip` and moves the badge components onto it.

- **Recipe** (mock-up 6, `.tagchip` line 130 and `.aud` line 223): a pill (`rounded-pill`), `surface-raised` fill, `text-primary`, a 1px `border-default` edge, 13px (`--t-13`) at weight **400**, sentence case. Padding is 4px 12px 4px 8px (`spacing.1`, `spacing.3`, `spacing.2`). The leading icon is 14px with an 8px gap (line 131). The chip is about 31px tall: 13px text at the 1.6 line height it inherits from the body, plus 8px of padding and a 2px edge. That clears the 24px target floor. The mock-up never draws a chip without an icon, so the padding for one is open (AECI-1763).
- **A link chip** (taxonomy) hovers to a `border-strong` edge and Forest text (line 225).
- **A selected filter chip** (clash 5) takes `accent-primary-soft` fill, Forest text and a 1px Forest edge, with `aria-pressed` (lines 265 and 273). **Selection is never colour alone.** A selected filter chip and a pressed segment each show a tick, as the mock-up draws on the filter chips (lines 268 and 269, and `.cat .on` at lines 274 and 275). The mock-up's pressed segment has no tick, so it needs one. The tick marks selection, not verification, so the no-verification-icon rule at the top of this subsection does not apply. In forced-colours mode a pressed or selected state maps to `Highlight` fill and `HighlightText` text, because the wash and the Forest fill both vanish there.
- **A filter chip is a button.** It is a pill at `min-height: 44px`, 14px at weight 600, with a 1px `border-strong` edge, and may carry a count (lines 260 and 270). It is a chip and not a primary action, so the pill is allowed. The mock-up sets the count inside at 12px. §3 allows `--t-12` only for overlines, the two weight-500 chips and field captions, so the count sits at `--t-13`.
- **The dense variant** is for a chip inside a card or a table row. The mock-up's `.mini` (line 303) is a pill with a `surface-sunken` fill, no visible edge, 13px at weight 600 and a 4px icon gap. It keeps the same padding as the public chip. The old dense badge (`px-2.5 py-0.5`, `text-xs`, `font-bold`) retires, because weight 700 leaves chips (clash 9) and 12px is not a chip size. Whether row density needs less padding is open (AECI-1763). The old reason stands: at row density extra height pushes a row off one line.
- **Weights:** 400 on the public chip, 600 on the dense chip and the filter chip. **Only the maintenance marker and the agreement badge keep weight 500.** Both are 12px at 500 with tracking +0.01em and 4px 10px padding (mock-up 6, lines 503 and 504). They take the chip shape. The mock-up copies the live site and draws them at a 4px radius, which is not on the ruled scale and is not a pill. AECI-1763 confirms the pill.
- **Never a Clay-soft chip.** The mock-up's Clay-soft category chip (`.mini.ct`) is dropped (clashes 4 and 22).
- **Portal badges.** The vendor plan badge and the review status badge sit in the portal. R2 gives the portal the new tokens only, so whether they also take the pill shape is open (AECI-1763).
- **Chips are sentence case**, like everything else. The Sentence-Case Rule's single exception is the overline role, and a chip is not an overline. The product-detail "Not yet rated" chip was uppercase at `0.08em` tracking, an overline in a chip's clothing. Fixed in AECI-841.

What actually renders today:

- **Maintenance marker** (`shared/maintenance-marker`): neutral chip — `border-default` /
  `surface-raised` / `text-secondary`, **no dot**, no icon. (It shipped with a 6px decorative
  `text-tertiary` dot; AECI-841 removed it. On a chip with exactly one state a leading dot reads as
  a status light, which is precisely the trust signal this component exists **not** to give — the
  same reason there is no checkmark on it. The agreement badge's dots stay, because there the dot
  is the only thing separating `unverified` from `single_source`.) On product detail, vendor
  detail, and the pair page. It is a **label, not a sentence, so it carries no terminal
  period**, and the date clause is joined with a middot. Four readings, all **live** since
  AECI-616, reworded by AECI-1142. Ruling 2026-09-28 (Chris): the maintenance chip uses exactly two labels everywhere, "AEC Integrations maintained" and "Vendor maintained". The four readings are
  `AEC Integrations maintained` · `AEC Integrations maintained · Reviewed <date>` · `Vendor
  maintained` · `Vendor maintained · Updated <date>`. The company is never in the visible label.
  Clash 40 (CURRENT) confirms this. The mock-up's "Maintained by AEC Integrations" pill with a Clay pencil pip is dropped, and so is any icon. Ruling R3 decision 12 (AECI-1734, 2026-11-14, Chris "A"): the "Reviewed" date returns on the chip.
  Where the page can prove who wrote (the vendor page, and the product page's vendor), an sr-only
  suffix names it for screen readers: "Vendor maintained: Procore Technologies keeps this up to
  date". The pair page cannot prove it, because any endpoint vendor or the owner can flip a pair
  row, so it passes no name. The pair page also passes no date: each card's At a glance strip
  states its own "Last checked". The date renders only
  when `last_reviewed_at` is set, and it is `null` on almost every record because **nothing
  was backfilled** — bare attribution is the honest default, not missing data. Never wire the
  date to `updated_at`: it is `$onUpdate` and promote restamps it, so the date would refresh
  itself on every bulk re-promote (60 production products share one `updated_at` day). The
  vendor branch is driven by real vendor work: an attestation, or — since AECI-981 — any
  vendor-authorized catalog save in the portal (a profile edit, a product edit, a version
  write). A save both flips the branch and supplies the date, which is why the vendor
  wording reads `Updated` where the AECi wording reads `Reviewed`: they are the same stored
  column describing two different acts, and swapping the verbs would misattribute one party's
  work to the other. Dates are formatted in **UTC**, not the
  ambient zone — SSR runs UTC and the browser does not, so a zone-local format would trip a
  hydration mismatch either side of midnight.
  - It **coexists** with the agreement pill below rather than replacing it, deliberately: the
    marker is page-header attribution ("who is on the hook for this page"), the pill is
    per-claim state on the mechanism cards ("do the two vendors agree about this one data
    object"). Two distinct signals share the pair page — marker and agreement chip — and
    collapsing them would lose information. (The account-status label left this page in
    AECI-1131 and was deleted everywhere in AECI-1264; see below.)
- **Agreement pill** (`products/agreement-badge`): same neutral chip tokens. Renders
  `Listed by AEC Integrations` on most claims (AECI-1142; `Unverified · AECi` before it), the
  honest posture, not a warning. The other three states are in the Agreement badge table below.
- **Pending** (`badge-pending`): surface-sunken fill, text-secondary text, a `border-default` edge (0.5px as shipped. Chip work in AECI-1763 sets the width). Indicates "submitted, not yet reviewed" — never confused with confirmed.
- **No public label says "Claimed"** (clash 39, CURRENT). The wording is counsel's, and changing it is a legal decision, so none of the redesign's labels may say it. The mock-up's hero pill "Listing claimed by Bluebeam", its facts-card caption "Listing claimed by …" and the pair ledger's "Claimed by {vendor}" against "Not claimed" are dropped. The Unclaimed note stays word for word (§5 "Unclaimed note", ADR 0051).
- **No account or plan label on public pages** (AECI-1264, removed 2026-10-09, marketing review B1). `aec-vendor-account-badge` ("Active on AEC Integrations", AECI-965, relabeled AECI-1131) is deleted. "Active" implied a vendor without it was inactive, and it marked publicly who pays. Do not build a replacement public marker of plan or payment. The `vendors.verified` mirror still drives the claim CTA's copy on the vendor and product pages, which is copy, not a badge. Inside the portal the plan reads as the **Plan badge** above.
- **Agreement badge** (`aec-agreement-badge`, AECI-300 / AECI-605): the per-claim state on the product-pair page's data-flow lanes — whether the two vendors agree that a `data_object` flows between their products. Its agreement-specific wording and tonal ladder keep it distinct from the maintenance marker. Four states, and the tonal ladder between them is the point:

  | State | Treatment | Label |
  |---|---|---|
  | `unverified` | `border-default` / `surface-raised` / `text-secondary`, tertiary dot | "Listed by AEC Integrations" |
  | `single_source` | the **same neutral chip**, `text-secondary` dot | "Confirmed by {vendor}" |
  | `confirmed` | Forest-soft wash + Forest text + Forest border (10.80:1) | "Confirmed by both companies" |
  | `conflict` | `--status-error` text + border on `surface-base`, `✕` glyph | "Companies disagree" |

  Labels reworded by AECI-1142 to plain buyer words ("company", not "vendor"; no "Unverified",
  no "AECi" abbreviation). The `unverified` accessible name adds "Neither company has confirmed it
  yet", so "Listed" is never heard as an endorsement.

  Three rules hold this together. **`single_source` shares the neutral chip with `unverified` on purpose** — one vendor affirming while the counterparty stays silent must never borrow the affirmative Forest treatment, so the only difference is a slightly stronger dot; the badge names the vendor and its `aria-label` states the other's silence outright. **`confirmed` is the only badge that earns the wash**, and only for two *distinct* vendors. **`conflict` is the only red**, and it reports a difference between vendors, not a defect in either product. Colour is never the sole signal (WCAG 1.4.1): every state carries a distinct visible label and accessible name, and the dot/glyph is `aria-hidden`.

  **The row roll-up (AECI-1781, ruled 2026-11-14, Chris "A", `STAGE_2_ATTESTATIONS_SPEC.md` §4.3).** A row with several flows shows one state. The weakest flow decides. Any conflict makes the row `conflict`. A row is `confirmed` only when every flow is confirmed by both companies. A flow that every voting company denied is left out. A row at `single_source` names no vendor and reads "Confirmed by one company". The attributed "Confirmed by {vendor}" form is for a single claim. The state is a label only. Nothing sorts or filters by it.

  Clash 41 (CURRENT, no note from Chris) confirms the four-state ladder. **Only "Confirmed by both companies" is green.** A one-company confirmation looks neutral. The mock-up drew all three confirmed wordings ("Confirmed by both companies", "Confirmed by Sage" and "Confirmed by Bluebeam") as the same bold Forest text with a link icon, and drew "Listed by AEC Integrations" with an info icon and no chip. That is dropped, and the cards render `<aec-agreement-badge>`. "Confirmed by both companies" is a label only, with no filter and no sort (R1). **No summary count of agreement states ships** (`PLAN.md` §7.7 names "a filter or a summary count" as the placement risk, and confirmation is a Managed-only capability). That rules out an agreement-state count in a group header (`.gs`, mock-up 7, line 1137) and the rail's "Evidence for these N" panel.

- **Version diff markers** (AECI-303, `STAGE_2_ATTESTATIONS_SPEC.md` §9): on the product-pair page's claim rows, what the selected product-version pair *changed*. Deliberately **not badges** — a rule and a label, not a chip:

  | State | Treatment | Label |
  |---|---|---|
  | `unchanged` | **nothing** | — |
  | `added` | `border-s-2` Forest **start rule**, `+` glyph, `.aec-overline` in `text-secondary` | "New in {version}" |
  | `removed` | `border-s-2` `border-strong` start rule, `−` glyph, name steps to `text-secondary` + `line-through` | "Removed in {version}" |

  Four rules, each of which rules something else out. **Position carries the separation:** the marker sits at the row's *start*, the agreement badge at its *end* — left is what changed in this version, right is who agrees about it. Two questions, two zones, no competition. **`added` gets the rule, not a wash:** `--accent-primary-soft` is the `confirmed` chip's, and a wash inches from a neutral chip reads as "confirmed" by proximity; a single vertical mark is unmistakably structural, and doubles as a scannable gutter down the lane (borders-not-shadows, and the same spirit as the Score Display's range marker). **`removed` is never `--status-error`:** `conflict` is the only red, and a second red on the same row would collapse "vendors disagree" into "no longer supported". Clay is excluded on both counts — `added` is not a warning, and the Clay-Restriction Rule caps that hue at ≤5% of a screen, which a per-row marker blows instantly. And **`unchanged` renders nothing**, which is both the overwhelming majority state and what keeps the default latest × latest view byte-identical to a pair page with no version data at all.

  `text-secondary` only, never `text-tertiary`: these rows sit on `surface-base` inside a `surface-raised` lane, and the tertiary token is forbidden on sunken/muted surfaces. Logical `border-s-*` keeps the mark on the correct edge under RTL. Every state carries a glyph **and** a visible text label (WCAG 1.4.1), and `removed` adds a decoration change on top.

  **No Mobbin anchor was picked for this surface, deliberately** — the same call the AECI-605 agreement badge recorded. The pair page has three shipped layers and a settled chip/token vocabulary; the diff markers inherit it rather than importing a second site's visual language onto the page that is most editorial. This is the standing precedent for anchorless surfaces (see the Phase 8.3 operator console: "One publication, one voice").

**Superseded treatment:** the earlier Forest-filled `badge-verified` placeholder must not ship.
Vendor agreement is represented by the explicit `AgreementBadge` labels above, including
"Confirmed by both companies" when two distinct vendors affirm the same claim.

### Field caption

`aec-field-caption` (`shared/field-caption/`, AECI-1614, `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.8). One quiet line under a group of fields: "Maintained by {vendor} · updated {date}", "Maintained by {vendor} until {date}", "Corrected by AEC Integrations on {date}" then a source link, or "Removed by AEC Integrations on {date}" (AECI-1628) in the slot a cleared value would fill. **It is not a badge, and must never become one:** the field-caption role (`--t-12` with a 20px line height, §3), `--text-secondary`, no fill, no border, no chip, no icon. Clash 40 (CURRENT) confirms the wording "Maintained by {Vendor} · updated {date}", always with the date. The mock-up's pencil icon under Categories is dropped. It repeats down a page, so anything heavier reads as an endorsement or an ad. The maintenance marker labels the whole record once as a chip; this attributes one group. `--text-secondary`, not tertiary, because it sits on base, raised, Bone and a hovered row. Dates in UTC, `MMMM d, y`, like the marker. The source link is the Link Treatment Rule's citation role, with the new-tab cue. Mobbin anchor: **v0**'s extension marketplace listing (screen `bcc629fe-8ac0-4b61-919f-4ddf02953ea4`), whose "Published" and "Last released" facts sit in plain muted text beside the content they describe, with no chip or status mark. Where values share one wrap of chips, the line names its field ("Website: Corrected…"), and so does a removal whose slot is gone ("API documentation: Removed…") and the logo line under the h1 ("Logo: Corrected…"). A vendor's own link on a pair card reads "Link from {vendor}" in the same style. On a table row it sits under the meta line in the partner cell and wraps there, so it adds no column and leaves the 34rem floor alone.

### Tags / Taxonomy chips

Chip-style links to category / audience / phase browse pages (the `TaxonomyBadge` component). Distinct from the status badges above — these are navigational, not state indicators. The taxonomy chip is the public chip (Badges: "The public chip", clash 22), so this entry only records what is its own. AECI-1763 moves `aec-taxonomy-badge` onto `aec-chip`.

> **The non-link card-grid chip** (`RoleBadge`, see "Role chip" above) is the same public chip without the link hover.

- **Shape:** a pill (`rounded-pill`), no longer `rounded-sm`.
- **Surface:** `surface-raised` fill, a 1px solid `border-default` edge raising to `border-strong` on hover. The mock-up draws 1px (line 130). The shipped 0.5px is confirmed or replaced by AECI-1763.
- **Typography:** Atkinson Hyperlegible Next at weight **400**, 13px (`--t-13`). The 500 this entry used to state is gone (clash 9). The mock-up sets 400 (line 130). `text-primary` shifts to `accent-primary` on hover.
- **Case:** sentence case, per the Sentence-Case Rule.

### Score Display

The signature data component for review scores. Source Serif 4 numerals in Forest, no chart-junk decoration, no sparkline behind the number — the score *is* the visual. Clashes 8 and 19 and ruling R3 rewrite it.

- **Numeric value:** the Figure role (§3). Source Serif 4 at weight 600, `--t-fig` (28 to 40px fluid, line-height 1, tracking -0.01em), Forest (`accent-primary`). It replaces the old Headline clamp. Mock-up 6 sets it on `.score .bn b` (line 392).
- **Ruling R3 decision 6 (AECI-1734, 2026-11-14, Chris "A"):** "Score figures move back up." Clash 8 had dropped them to 40px, and the score cards looked half empty (`PLAN.md` §10.3). The ruling does not say how far they move. The ramp has no figure size above 40px, so the size is open (AECI-1767, with AECI-1748). Mock-up 6 shows two score figures side by side in the reviews band, and clash 8 allows one large figure per band. The orchestrator's reading is that R3 decision 6 ("bring the figures back up") makes the reviews band a ruled exception to clash 8's one-figure rule. Chris to confirm on AECI-1767.
- **Label below:** Atkinson Hyperlegible label scale, text-secondary color. Each score card also prints its name ("Score one", "Score two" or the criterion) beside its stripe (§4 clash 15).
- **Stripe:** a 7px leading stripe, Forest for product quality and Clay deep for onboarding experience (mock-up 6, lines 386 and 387). It is never the only cue (§4).
- **Range marker** (optional, sparse): a vertical mark per score on a 1-10 axis, with no fill, no gradient and no animation. The mock-up's "On the same scale" panel draws a 1px line, 2px pins 28px tall and tick labels at `--t-12` (lines 397 to 408). Two pins on one axis are two scores. Each pin carries its printed label and number, so colour never tells them apart. Clash 19 rebuilds the scale to this spec and drops the gradient gap bar.

### Meter (clash 19)

Clash 19 was ruled BLEND with no note. The blend is the clash recommendation: allow one public bar-meter pattern. The old "multi-series data visualisation is operator console only" stands for charts. A meter is not a chart. AECI-1767 builds `aec-meter`.

- **One hue.** Forest fill on a `surface-sunken` track. No gradient. The mock-up's ledger meters with gradients are dropped.
- **The number is always printed** beside the bar as text, never only in the graphic. The bar is a second way to read it. The track and fill are not carrying the meaning, so the 3:1 graphics floor is met by the number. The meter is `aria-hidden` or carries `role="meter"` with the same text, and AECI-1767 picks one.
- **Size:** 6px high with a full-pill end. The dimensions come from mock-up 7 only (lines 1129, 1130, 1149 and 1150). The evidence panel that the mock-up's meter sits in is dropped (see Agreement badge). Mock-up 8's category bars are the chart R3 decision 19 cut.
- **Clay deep** appears only when a bar stands for the onboarding score, beside its printed label (clash 4).
- **The load bar** ("Showing 24 of 58") is the same meter at 260px wide, with a "Load more" secondary button under it (mock-up 7, lines 1148 to 1152).
- **Admin charts** keep their own rules below. The meter does not touch them.

### Starting values from the mock-ups (components)

Measured from the default state of the mock-ups in `docs/design/mockups/redesign-2026-11/mockups/`. The restore toggles (`html.r-*-orig`) are ignored. The code issue confirms each value. Line numbers are in mock-up 6 (`6-product-detail.html`) unless the first column names another.

| Value | Starting value | Line |
| -- | -- | -- |
| Button | `min-height: 44px`, `border-radius: 12px`, 14px at 600, padding 0 24px, gap 8px, 1px transparent border | 88 |
| Compact button | The same height and radius, padding 0 16px | 98 |
| Button press | `translateY(1px) scale(.98)`, clash 37 | 89 |
| Secondary button | White-grey fill, 1px `border-strong`, hover sunken fill and Forest text | 96, 97 |
| On-brand button | Bone fill, Forest text. Its hover fill `#E7E1D2` is a hex and not a token | 12, 90, 91 |
| Focus ring | `outline: 3px solid`, offset 3px, radius 12px. Bone on a Forest ground | 29, 12 |
| Segmented control | 3px padding, 1px `border-strong`, 12px radius, 36px segments, pressed Forest | 255 to 258 |
| Field | `height: 44px`, padding 0 16px (48px left with an icon), 12px radius, 1px field edge, 16px text | 251, 254 |
| Field error | A 1px edge plus a 1px ring, 2px in all. Message 14px at 600 with an icon | 465, 463 |
| Public chip | Pill, 1px `border-default`, `surface-raised`, 13px at 400, padding 4px 12px 4px 8px, 14px icon | 130, 131 |
| Link chip hover | `border-strong` edge, Forest text | 225 |
| Filter chip | Pill, `min-height: 44px`, 14px at 600, 1px `border-strong`. Selected: Forest-soft fill, Forest edge | 260, 265, 270, 273 |
| Dense chip | Pill, `surface-sunken`, 13px at 600, 1px transparent edge | 303 to 306 |
| Maintenance and agreement chips | 12px at 500, tracking +0.01em, padding 4px 10px, 4px radius | 503 to 508 |
| Card | White fill, 24px radius, `--shadow-card`, padding 24px, lift `-4px` on hover | 293 to 295 |
| Card title | Source Serif 600 at 20px, line-height 1.1 | 299 |
| Score card stripe | 7px leading stripe, 24px radius | 385 to 387 |
| Score figure | `--t-fig`, Forest | 392 |
| Large zero | `--t-fig`, Forest, `aria-hidden` numeral and an sr-only "0 " in the sentence (mock-up 8) | 8: 1087, 1407 |
| Group header (mock-up 7) | Flex, 16px gap, 16px padding under, 1px `border-default`. 42px icon tile at 12px radius, `--t-24` name, count pill at 13px and 600 | 7: 1133 to 1136 |
| Sticky jump rail (mock-up 7) | `position: sticky; top: 96px`, 24px radius panel, 44px or taller rows at 12px radius, current row Forest with white text | 7: 1115 to 1125 |
| "Show more" button (mock-up 7) | `min-height: 44px`, 12px radius, 14px at 600. Drawn as a Bone fill with no edge | 7: 1140 |
| Load bar (mock-up 7) | Meter 260px by 6px, "Showing n of N" at 14px, a "Load more" secondary button | 7: 1148 to 1152 |
| Standalone link | 14px at 600, text secondary, underline in `border-strong` at a 4px offset | 8: 1088 |
| Bar meter | 6px high, 8px radius, `surface-sunken` track, Forest fill | 7: 1129, 1130, 1149, 1150 |

### Open values (components)

Each value is set by the code issue named. A value the mock-ups set is not listed here, it is in the table above.

- **The danger button's colours (AECI-1758).** AECI-1758 names a `danger` variant. The rulings and mock-ups do not draw one. It must use the error token with a text label.
- **The on-brand hover fill (AECI-1758, with AECI-1747).** `#E7E1D2` is a loose hex. Clash 6 asks for a named token.
- **Ghost and secondary buttons on a Forest ground (AECI-1758).** The mock-up builds its ghost button with `color-mix()`, which clash 6 bans.
- **The field edge token name (AECI-1747 and AECI-1764).** AECI-1764 calls it `--border-field`. §2 calls it field edge. Whether it replaces `--border-input` is open in §2.
- **The error icon and message wiring (AECI-1764).** The 2px edge, an icon and a message are ruled. The icon is not.
- **Chip padding without an icon, the dense chip's padding, and the pill on the two weight-500 chips (AECI-1763).** The mock-up never draws a chip without an icon and draws the 500 chips at a 4px radius.
- **Whether portal badges take the pill (AECI-1763).** R2 gives the portal tokens only.
- **The card hairline and which surfaces take the shadow, including the plan cards (AECI-1765).** Listed in §4 "Open values" too.
- **The lead cards in the reviews, extensions and similar-products grids (AECI-1765).** R3 dropped the integrations lead card only.
- **The score figure size above 40px (AECI-1767, with AECI-1748).** See Score Display. Chris to confirm the reviews-band exception on AECI-1767.
- **Whether the inline and badge weights of the integration stat follow the large zero (AECI-1767).** The card spec pins "Not yet connected".
- **The meter's role and `aria` form (AECI-1767).** The number is in the DOM as text either way.
- **Which filled button stays on the product page (AECI-1768 and AECI-1778).** The sticky bar's "Write a review" is one of the three in view (clash 21).
- **The logo stack on the "Show more" button (AECI-1769 and AECI-1783).** It names hidden products. An unclaimed product shows its initial tile there, as everywhere else.
- **The integrations section (AECI-1782).** Whether the Disclosure group card is the per-partner card. Where the filter panel sits (R5). How rows with no data object behave under a data-object filter. About a third of live integrations have none, and no vendor can add one today (AECI-1816, on AECI-1732).
- **The grouped-list threshold and the one-list page size of 12 (AECI-1783).** Rail and chip counts must agree.
- **The rule for public demand counts (no code issue).** Clash 43. Written before any count ships. See "Integration stat".

### Icons (clashes 33 and 34)

Chris ruled NEW on clash 34 and left no note: the new design wins, and "Lucide icons exclusively" is rewritten (ADR 0056 lists clash 34). The no-emoji rule stays. Clash 33 (NEW, no note) lets an arrow mean "go here", and the Arrow Rule in §4 holds that rule. The clash record's worry about density, that an icon on every element stops icons meaning anything, was set aside by the ruling. The ruling sets no icon quota, so the decorative-or-labelled rule below is the check. The code ships with the shell batch (`batch/redesign-shell`), not on `main` yet.

- **One custom set.** Icons are drawn for the site at 1.75 stroke in a 24 by 24 box, in `apps/web/src/app/shared/icon/icon-registry.ts` (AECI-1753, clash 34). A few paths are Lucide-derived, and Lucide's licence ships at `/third-party-notices.txt`.
- **One component.** Every UI icon on a public page renders through `aec-icon`. A glyph is never an inline `<svg>`.
- **Stroke only.** A filled glyph is not part of the set.
- **Colour is `currentColor` only.** Set the colour with a text colour on the parent. An icon never carries a colour of its own.
- **Four sizes.** The default is 20px.

| Size | Tailwind step |
| -- | -- |
| 14px | 3.5 |
| 16px | 4 |
| 20px (default) | 5 |
| 24px | 6 |

- **Every icon is decorative or labelled.** The selector is `aec-icon[label], aec-icon[decorative]`, so an icon with neither fails to compile. An icon beside text that says the same thing is decorative and hidden from assistive technology. An icon that is the only carrier of meaning takes a localised label. An icon-only button still needs its own accessible name.
- **Direction.** Arrows and chevrons that point along the line mirror in right-to-left text.
- **Named for what they show,** not where they are used. Typed maps tie data-object slugs and facets to icons. 12 of the 27 data-object slugs have no icon yet (AECI-1753).
- **No icon implies endorsement.** The no-verification-iconography rule in "Badges" stands.
- **Portal and admin page bodies keep their current icons** until their migrations run (AECI-1756 and AECI-1757, deferred by ruling R2). The shared header, footer and button render there with `aec-icon`.

### Motion (clashes 36, 37 and 38)

Chris ruled BLEND on clash 36 and NEW on clash 37, both with no note. He ruled NEW on clash 38 with the note in the smooth-scroll rule below. The record is `records/design-rulings.md`, and ADR 0056 lists clash 38 only. The tokens ship with the shell batch (AECI-1751).

**Motion gives feedback. It never decorates.**

| Token | Tailwind | Value | Use |
| -- | -- | -- | -- |
| `--duration-fast` | `duration-fast` | 120ms | Press, and row hover |
| `--duration-base` | `duration-base` | 180ms | Hover, focus and disclosure |
| `--duration-slow` | `duration-slow` | 280ms | Menu open, the nav ink bar and the scrim |
| `--ease-standard` | `ease-standard` | `cubic-bezier(.2,.7,.2,1)` | Every eased move |

- **Three durations and one easing** (clash 36). The mock-up's 200, 250, 300, 420, 450 and 600ms values are dropped. The easing is the mock-up's own `--ease` (mock-up 6, line 15). The press takes the fast step (line 88), the card lift the base step (line 293), and the Browse menu (line 632) and the nav ink bar (line 182) the slow step.
- **No bounce, no elastic easing.**
- **Reduced motion.** Under `prefers-reduced-motion: reduce` every transition and animation resolves to an instant change. The global block in `apps/web/src/styles.css` does this today.
- **Motion never carries a state change alone.** A state is also shown by text, `aria-expanded`, `aria-current` or a colour change.
- **No decorative loop, and nothing moves for more than 5 seconds without a pause control. Nothing parallaxes and nothing flashes.** The second is WCAG 2.2.2. The last is 2.3.1.
- **Skeleton `animate-pulse` is the only loop kept.** It signals that content is loading, it runs for 2 seconds, and it stops under reduced motion. The mock-up's endless halo pulse (line 110), its per-card stagger (`rise`, line 296) and its counter bounce are removed (clash 36).
- **One hero entrance is kept** (clash 36). See "The hero diagram" below. Its timing is open.
- **Behaviour timings are not durations.** The Browse menu's 70ms open delay and 260ms close grace belong to AECI-1774 and sit in §5 "Navigation".
- **Portal and admin page bodies** keep Tailwind's 150ms default until their migrations run (ruling R2). The shared header and button render there with the new durations.

#### Hover and press (clash 37, new)

Chris ruled NEW: the new design wins. The old "no transform, no scale, no shadow on hover" rules for buttons and cards are rewritten.

- **A card that is interactive lifts.** It moves `translateY(-4px)` on hover and `translateY(-1px)` on press, over the base duration (mock-up 6, lines 293 to 295).
- **A button presses.** It moves `translateY(1px) scale(.98)` on press, over the fast duration (lines 88 and 89).
- **No shadow joins either move** (clash 11). Index rows (§5 "Entity cards") do not lift or scale.
- **Both moves are off under reduced motion,** and neither is the only sign of hover or press.

#### Smooth scrolling (clash 38, new)

Chris: "Make sure we know how to adopt the old way if needed." ADR 0056 lists clash 38. The code lands with AECI-1752, which is in review.

- **In-page section links only.** Smooth scrolling applies to a link marked `data-smooth-scroll`: on public pages, the product section nav, the product page's reviews link, the docs "On this page" rail and the `/account` section nav. In the vendor portal, the integration page's section nav. The skip link never opts in.
- **Never a global setting,** and off under reduced motion. A `routerLink` cannot opt in. The skip link never animates.
- **Router scroll restoration is untouched** (`CLAUDE.md`, "Router scroll restoration is already solved"). `ScrollBehaviorManager`, `InitialFragmentScroller` and `ScrollMarginViewportScroller` are not changed.
- **To restore the old global behaviour,** add `class="aeci-smooth-scroll"` to `<html>` in `apps/web/src/index.html`. AECI-1752 documents it in `ANGULAR_STYLE_GUIDE.md`. Until it merges, `main` still sets `html { scroll-behavior: smooth }` in `styles.css`.

### Logos and initial tiles (clash 34 and counsel's ruling 9)

`PLAN.md` §4.5 states the rule as counsel's ruling 9 "as the legal agent read it". The record is `records/legal-review-2026-11-12.md`.

- **A small sourced logo may appear on an unclaimed product's own page** (counsel's ruling 9, see "Unclaimed note"). A claimed product's logo and brand colour may appear (`PLAN.md` §4.5).
- **An unclaimed product gets no brand colour anywhere** (ruling R7, AECI-1738, 2026-11-14).
- **Open with counsel: whether the product hero may show a large logo** (AECI-1826). Until it is answered the existing size rule stands (§5 "Unclaimed note").
- **Everywhere else an unclaimed product shows an initial tile.** Lists, cards, rows, search and a diagram's partner marks all show it. The Unclaimed note stays word for word (§5 "Unclaimed note").
- **The initial tile must not look lesser.** It carries no label and no muted styling.
- **Never a vendor logo or vendor colour in the sticky bar,** on any listing. A vendor logo where our header has scrolled away would read as the vendor's own site.
- **The reversed wordmark.** On a Forest ground the wordmark is `aec-brand-logo` with `tone="on-dark"`: Bone type, the Clay connector and a transparent field (AECI-1754, clash 42, on the shell batch). Clay never flips. Bone on Forest is 11.03:1. §5 "Navigation" says where it sits.
- **Open: the radius of a logo tile by size** (AECI-1750). The mock-up's mark is `border-radius: 22%`, with a shadow that §4 drops.

### The hero diagram (clash 35)

Chris ruled NEW on clash 35 and left no note. No rule existed. The product page's hero visual is ruled by R3 decision 1 (AECI-1734, 2026-11-14, Chris, by Slack, "A"): the hero ring becomes a category hub with a pair finder under it. The recommendation he accepted said it features no product, so it needs no ranking rule. Any diagram in a hero follows the clash recommendation:

- **Real records only.** No placeholder partner and no invented count. The mock-up's counts are never copied.
- **Static in the server HTML.** It reads without script.
- **A text equivalent** for a screen reader and for a reader with no script.
- **Position implies no ranking.** Any products it shows are ordered A to Z by name, with the id as tie-break (ruling R1). The firewall test in AECI-1814 covers it.
- **An honest empty state.** At zero it says so in text, under the zero rule in "Integration stat". Mock-up 8 draws dashed slots, which are not approved.
- **Partner logos** follow "Logos and initial tiles".
- **One entrance animation, once.** It must not replay on hydration (the clash record's concern), and under reduced motion it shows its final state.
- **Open: the hub's entrance timing (AECI-1787).** R3 decision 1 removed the ring the mock-up animates. Its ribbon draw ran 1.4s after a 0.25s delay and its beads popped in over 0.5s (mock-up 6, lines 104 and 105). Neither fits 120, 180 or 280ms, and neither applies to the hub. The hero issue picks the hub's timing or Chris adds a duration.

### Data visualization — operator console only (AECI-578)

*(Clash 19, 2026-11-13: public pages get one chart-like thing, the bar meter above. Everything below stays operator console only.)*

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
operator screen. They are also the reason `styles.css` is one of the two files
allow-listed from the AECI-597 colour-literal lint rule — it is the token
definition site, so it is the one place allowed to spell a hex value. Declare a
new series hue **there**; writing one into a component will fail `pnpm lint`. **Forest remains the sole brand primary** under the
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

The redesign rulings of 2026-11-13 and 2026-11-14 rewrite this part of §5. They are clashes 26 to 32 and 42, ruling R4 (AECI-1735), the ordering exception (AECI-1814 and AECI-1774) and ruling R2 (AECI-1733). A clash number beside a rule means that ruling set it. Where the record has Chris's own words, they are quoted. Where it says only NEW, BLEND or CURRENT, the rule follows the clash recommendation and `PLAN.md` §4.7 to §4.10. The record is `docs/design/mockups/redesign-2026-11/records/design-rulings.md` and `design-clashes.md`. ADR 0056 does not list clashes 26 to 32 or 42, so it records none of them. Colours are the tokens AECI-1747 set. They are on its branch and not yet on `main`. §2 "Forest grounds" holds every contrast floor this part cites.

**Scope (R2, 2026-11-14).** Chris: "Just do public pages for now". This part governs the public shell: the header, the Browse menu, the mobile menu, the section nav, the breadcrumb, the footer and the bands under the header. The vendor portal and the admin console page bodies take the new tokens and nothing more. They keep their own tab rows, dropdowns and breadcrumbs, which are described under "Portal and admin rows" below. They wear the shared header and footer (the ruling below).

**Ruling on the shared shell (Chris, by Slack, 2026-11-14).** The site header, the legal notice band and the footer render in `app.ts` above and below the router outlet on every route, `/vendor/*` and `/admin/*` included. The question was which shell those two routes wear. Chris: "A. This is a temporary stopping point, we won't go live half built." Option A was: the portal and admin wear the shared shell. Only their page bodies, tab rows and breadcrumbs stay as they are. R2 is a staging point and not a permanent limit. AECI-1771 (header) and AECI-1776 (footer) are unblocked. Portal and admin page bodies wait until Chris has verified the public pages. A signed-in vendor or admin sees the account menu in place of Sign in, and the portal's own navigation sits below the header and is not restyled by this part.

**The header never varies by visitor in cached HTML.** The header sits inside URL-keyed cached SSR pages. It renders the signed-out state on the server, which is a "Sign in" link. `SessionStatus` swaps in the account menu after hydration. The role-gated doors read the browser-only role probe, which is `null` during SSR, so no `/admin` or `/vendor` href reaches cached HTML. The active-route marker depends on the URL, which is the cache key, so it is neutral. The Browse menu fetches its terms and counts in the browser (`TaxonomyNavStore` is idle on the server), so no taxonomy state is baked into a page. None of this changes.

#### The header on Forest (clashes 1, 26, 29 and 42)

| Rule | Value | Ruling |
| -- | -- | -- |
| Ground | Forest (`--accent-primary`). Ink is Bone (`--text-on-brand`). No rule under the header. The shipped 4px warm rule goes | Clash 1, new. AECI-1771 |
| Links | **Browse, How we rank, For vendors.** Chris's note on clash 26: "Products is in browse (All Products)". Home and Products leave the row. The four facets fold into Browse | Clash 26, new |
| Destinations | Browse is `/products`. How we rank is `/docs/trust/how-ranking-works`. For vendors is `/vendor-program` | `PLAN.md` §4.7, AECI-1771 |
| Wordmark | The shipped wordmark, in its light-on-dark variant on Forest. Never a new mark. The variant is `aec-brand-logo` with a tone input and a transparent reversed SVG, built by AECI-1754 | Clash 42, current |
| Order | Wordmark, search pill, links, Sign in. Below the handover: the wordmark and the menu toggle | Mock-up 6, header HTML |
| Not sticky | The header scrolls away. The sticky section bar below is the only fixed bar | CURRENT |
| Search | A pill with a "/" hint, see "Header search" | Clash 29, new |
| Sign in | A rounded rectangle at 12px, never a pill. It is the Bone-on-Forest main button (`button-on-brand`, §5 Buttons, clash 3). Hover fills with `--surface-on-brand-hover` and the text stays Forest (9.46:1). `button-on-brand-hover` in the frontmatter records it | Clashes 12 and 29 |
| Signed in | The account menu replaces Sign in. Its trigger stays a circle, because a person is a circle (see the identity block below). The mock-ups draw no signed-in state, so the trigger's Forest styling is open | AECI-1771 |
| Focus ring | Bone (`--focus-ring-on-brand`), 3px at 3px offset, on every control on Forest. A Forest ring is invisible there | §2, AECI-1747 |

- **Link type.** Nav links are `--t-16` at weight 400, the ramp's "Body, nav links" role (§3). The label is Bone with no opacity change. The mock-up dims it to 92% opacity (line 42), and the `no-color-opacity-modifier` source-constraint rule (AECI-1747, on the batch branch) bars a `/NN` alpha on a colour utility. Clash 6 says every colour is a named token.
- **Link hover.** A `--surface-on-brand-wash` fill (Bone 10%) behind the link, text still Bone. A link hovered on `--surface-on-brand-wash-hover` (16%) over Forest has Bone text only (6.98:1). `--text-on-footer-secondary` is 4.46:1 on that wash and fails. It also fails on Forest hover (4.39:1), so it is never used in the header.
- **Link shape.** §4 hands the nav hover shape to this section. The mock-up's hover wash is a pill (line 42). It is a hover fill on a text link and not a button, so clash 12's "no pill buttons" does not reach it. Chris to confirm.
- **Wordmark size.** Starting value 32px high, and 28px below `md` (mock-up lines 497 and 611).
- **Every control has a spoken name.** The wordmark link's name is "AEC Integrations home". The toggle and the search field are named under their own headings.
- **Starting values** (mock-up 6, default state): header height `76px`, `64px` below `md` (lines 36 and 553). Gap between header parts `32px` (36). Link padding `12px 16px`, gap between links `8px` (41, 42). Sign in is `44px` high with `16px` side padding at `14px` and weight 600 (44). `button-on-brand` has 24px side padding. The header control is the compact form of the same button, like the ghost button's 16px, so the header row stays inside its width budget. AECI-1771 confirms the 16px against that budget.

#### Active route and the Clay bar (clash 28, new)

Chris ruled NEW on clash 28. The new design wins over the clash recommendation, which had been a 2px underline everywhere.

- **In the header the Clay bar is the panel-open cue.** The mock-up draws it under "Browse" only while the Browse panel is open. It is `scaleX(0)` until the panel opens (lines 629 to 631). It is 3px high with rounded top corners (`3px 3px 0 0`), on the header's bottom edge, 14px in from each side of the label. Clay on Forest is 5.29:1, so it meets the 3:1 floor for a meaning-bearing graphic. On Forest hover it is 3.29:1.
- **The active route in the header is weight 600 plus `aria-current`.** The mock-up draws no active-route bar. Clash 28's ruled design is the mock-up's `.cm-trigger::after`, which is `scaleX(0)` at rest and shown only while the panel is open. Weight 600 plus `aria-current` is the floor carried over for the active route and needs no ruling. `PLAN.md` §4.7 says the same. AECI-1771's description says "the active route item has a Clay bar under it", and AECI-1771 follows this part. The label reserves its 600 width so the row does not shift when the active item changes.
- **`aria-current` is `page` on an exact match and `true` for a section.** Browse is a section: it is `true` on `/products`, `/categories`, `/audiences`, `/trades`, `/phases` and their detail pages. These are the routes that lit the old items, minus Home. How we rank and For vendors are `page` on their own routes. Colour alone never shows the active route.
- **The section nav's active bar is Clay (R3).** See "The section nav". There the weight and the text colour are the other cues, because Clay is 2.33:1 on white and 2.09:1 on Bone and can never carry the state alone.
- **Portal, admin and the public in-page router rows keep their rule.** See "Portal and admin rows" below.

#### Header search (clash 29, new)

Chris ruled NEW on clash 29 and left no note.

- **A pill with a "/" hint.** The radius is the full pill, the one named exception to the 12px control radius (§4). Height 44px, `--t-16` text, a `kbd` chip on the end edge. It is a field and not a link, although the mock-up draws a link (line 38). The clash audit says a link styled as a field is not a field.
- **The edge.** A 10% Bone wash (`--surface-on-brand-wash`) alone measures 1.33:1 against Forest, which is not a visible boundary. The field takes a 1px edge in `--border-on-brand-strong`, 4.01:1 on Forest. The edge stays on hover. The mock-up has no edge, so this corrects it, on AECI-1747's measurements.
- **Ink.** The placeholder uses `--text-on-brand-secondary`, 6.00:1 on the 10% wash over Forest. Hover moves the wash to 16% (`--surface-on-brand-wash-hover`) and the text goes to Bone.
- **The `kbd` chip has no fill of its own.** The mock-up gives it a second 10% wash on top of the field's (line 40). Secondary ink on that stacked wash is 4.58:1 at rest and 3.92:1 when the field is hovered, which fails. The chip is a 1px `--border-on-brand` edge only, its text is secondary ink at rest and Bone when the field is hovered, and it is set at `--t-13`. §3 allows `--t-12` only for overlines, the two weight-500 chips and field captions.
- **The shortcut.** Pressing "/" focuses the search. It does nothing when focus is already in an input, textarea, select or contenteditable, or when a modifier key is held. It prevents the "/" from being typed. The hint is `aria-hidden` and the shortcut is announced once through `aria-keyshortcuts="/"`. These rules come from AECI-1772. No ruling set them.
- **Requirement: WCAG 2.1.4 Character Key Shortcuts.** A single-character shortcut must be one of three things. It can be turned off. It can be remapped to include a modifier key. Or it is active only while the component has focus. Ignoring the key while the reader types in a field is necessary and is not sufficient. The shortcut must also do nothing while any modal is open: the mobile menu, the claim dialog and any `BrnDialog`. AECI-1772 owns this and must meet it before the shortcut ships. It is a requirement and not an open value.
- **Shape by width.** The shipped header has the icon trigger from `lg` to `xl` and the inline field from `xl`. The mock-up shows the pill from `lg` and no search below it. This part keeps search reachable at every width. Below the handover it sits in the mobile menu. The pill's width bands are open (AECI-1772).
- **Placeholder copy.** The shipped copy is "Search directory". The mock-up reads "Search products, vendors, data objects". The suggestions are products and vendors, not data objects (§5 Header search autocomplete, AECI-985), so the mock-up's label would promise more than the box does. This overrides the mock-up. Keep "Search directory" until the suggestions include data objects. Chris to confirm. The ruling did not set the copy.
- **Starting values** (lines 38 to 40): flexible width up to `460px`, `12px` gap between icon and text, `16px` side padding.

#### The Browse menu (clash 27, new, and ruling R4)

Chris ruled NEW on clash 27: one mega-menu replaces the four taxonomy dropdowns. The clash recommendation had been to drop the page dimmer. Chris chose the new design, so the page dims.

**Ruling R4 (AECI-1735, 2026-11-14).** Chris, by Slack: "A".

- No "How we rank" card in the menu.
- Four key categories in this order: AI, Project management, BIM authoring, Accounting and ERP.
- Seven items per column.
- No key items for trades, phases or audiences.

The card is dropped, not only switched off. The mock-up's card (lines 666 to 688) and its mobile twin are not built. A production check on 2026-11-14 (a comment on AECI-1735) found 69 AI, 62 project management, 15 BIM authoring and 92 accounting and ERP products. All four are above the floor of 5, so the ruling stands. If a key category ever has fewer than 5 products, it goes back to Chris. The mock-up's counts (29, 58, 64, 52 and 486) are placeholders and are never copied (`PLAN.md` §10.4). The menu prints each term's name as the site prints it everywhere else. Term names are data and not menu copy, so the Sentence-Case Rule does not reach them. R4's capitalisation is the list of categories and not a rename.

**Key categories are AECi's own pick, and the site must say so.** The pick is editorial. `/docs/trust/how-ranking-works` must say so, and the menu footer line says the same. This is a same-PR rule. AECI-1815 says each sentence on the help page must be true of the shipped code at merge, so the page cannot go first. The PR that ships the Browse menu (AECI-1774, or AECI-1775 if the mobile menu lands first) therefore carries the `how-ranking-works` sentences with it. They cover the key categories being AECi's pick and each column's order, including the accepted count-order exception for audiences and trades. The gate covers the key-categories column and not only the footer line. AECI-1774's legal verdict is `text` (`docs/LEGAL_IMPACT_REVIEW.md`).

**The columns and their order.** Each order has a source. Nothing here is invented.

| Column | Content | Order | Source |
| -- | -- | -- | -- |
| Explore | "All products" with the total count, then the four key categories | AECi's pick, not a count order: `ai`, `project-management`, `bim-authoring`, `accounting-erp` | Ruling R4. Held as one config list of slugs, not a table (AECI-1774). The slugs are from the AECI-1735 comment |
| Categories | Seven categories, with any key category removed first | Most products first (`product_count`, descending), then name with `compareText`, then id | R4 says seven and `PLAN.md` §4.8 says "less any shown as a key category". Today's nav ranks by count with `topByCount` (`core/taxonomy/taxonomy-rank.ts`, top 10) and has no tie-break. The name tie-break is AECI-1774's. A Free seat can tag categories (`product.categories.edit`, `PLAN.md` §7.2), so no paid plan moves this order |
| Phases | All 5 | Project order: `taxonomy_phases.display_order` ascending, then name with `compareText` | A curated order, `byDisplayOrder` in `taxonomy-rank.ts`. Not a count order |
| Audiences | Seven | Most products first, then name, then id | The accepted exception, below |
| Trades | Seven published trades | Most products first, then name, then id | The accepted exception, below. The `TRADE_PUBLISH_MIN_PRODUCTS` floor still applies, as in the nav today |

Phases have five terms, so seven does not apply to them. Each facet column ends with its own "See all" link to the facet index.

**The audience and trade order is an accepted exception to the no-pay-for-placement firewall.** Chris, by Slack, on AECI-1814 and AECI-1774: "A, create a ticket to address later". Audience and trade tags need `product.taxonomy.edit`, which is outside the Free set. A Managed vendor tagging a product can lift a term into the top seven. It moves a term and never a product. The firewall test records it as one named exception, and the permanent rule is AECI-1836. The menu orders audiences and trades by product count, as the nav does today. This is a known gap and not a finding that count order is right. AECI-1836 may change it, and this part follows its answer.

**The menu footer line.** One line under the columns: "Key categories are chosen by AEC Integrations. Other lists show most products first. Phases in project order." It stays true only while every non-phase list is count-ordered and the key list is the config list.

**Not in the menu.** No vendor or product names. No "Popular", "New" or "Featured" badges (`PLAN.md` §4.8).

**The behaviour contract** (`PLAN.md` §4.8, point for point):

1. "Browse" is a real link to the all-products page (`/products`). It also controls the panel, with `aria-expanded`, `aria-controls` and `aria-haspopup`. `PLAN.md` names `aria-haspopup`. This part drops it, below, so the trigger carries `aria-expanded` and `aria-controls` only.
2. Hover opens the panel. The down arrow opens it and moves focus to the first link.
3. Escape closes it and returns focus to "Browse". Mouse leave closes it after a short grace period.
4. A press inside the panel must not close it before the click lands.
5. The page behind is dimmed while the panel is open.
6. On mobile the menu shows "All products" and the key categories first, then four tap-to-expand sections.

Added by this part. All of it is CURRENT unless it says otherwise.

- **The pattern is disclosure navigation, not an ARIA `menu`.** The shipped flyout is one link that carries `aria-expanded`, `aria-controls` and `aria-haspopup="true"`, over a `[hidden]` panel of links with no role. `nav-flyout-trigger.ts` uses it, and `nav-flyout-trigger.component.spec.ts` pins the attribute, the down arrow and the Escape focus return. The panel needs no landmark role, and each column's list is named by its overline through `aria-labelledby`.
- **`aria-haspopup` is dropped.** The Browse panel is disclosure navigation of links (the WAI-ARIA Authoring Practices disclosure pattern). The trigger carries `aria-expanded` and `aria-controls`. `aria-haspopup="true"` announces a menu that is not there. Note for AECI-1774: repoint the Escape selector in `NavDisclosure` (`layout/nav-disclosure.ts`, near line 79, today `a[aria-haspopup], button[aria-haspopup]`) to `[aria-expanded]`, and update `nav-flyout-trigger.component.spec.ts`, `e2e/nav-menu.spec.ts` (near line 309) and `e2e/phase2-a11y.spec.ts` (near line 183), which assert the attribute.
- **Built on `NavDisclosure`** (`layout/nav-disclosure.ts`), so Escape, focus leaving the host and the Safari press guard behave as they do today. A blur to nowhere during a pointer press inside the host does not count as focus leaving, because Safari never focuses a clicked link and closing on that blur loses the click. AECI-1774 deletes `nav-flyout-trigger.ts` once unused.
- **The keyboard reaches the panel by the down arrow.** Enter on "Browse" follows the link. The footer's Directory column is the Tab-reachable copy of the same destinations, and it renders in server HTML.
- **Angular Aria popups render inline in this repo, not in an overlay.** The Browse panel is plain inline markup under the header, which is what `NavDisclosure` expects. A panel in the browser's top layer is not a DOM descendant of the host, so every focus move into it would read as focus leaving.
- **The dimmer is not modal.** It is `aria-hidden` and decorative. It does not trap focus or make the page inert. Clicking it closes the panel. It sits under the header and over the page. Clash 6 does not allow a raw colour in a component, and `styles.css` already dims the CDK backdrop with `rgb(0 0 0 / 0.5)`. One shared scrim token serves both. Its owner is AECI-1770. The mock-up's `rgb(0 0 0 / 0.4)` (lines 15 and 690) is the starting value for the Browse dimmer.
- **Timing.** The mock-up opens after 70ms and closes after a 260ms grace (`src/catmenu.js` lines 19 and 15). These are starting values. The clash audit recommended putting the grace in the shared base so every dropdown gets it. Where it lives is open (AECI-1774).
- **WCAG 1.4.13 Content on Hover or Focus.** The hover-opened panel is additional content shown on pointer hover, so it must be dismissible, hoverable and persistent. Dismissible: Escape closes it without moving the pointer. Hoverable: the 260ms close grace lets the pointer cross from "Browse" into the panel. Persistent: it stays open until the pointer leaves, focus leaves, or Escape is pressed. A grace of zero would fail the second property.
- **Touch and the fallback at `lg` and above.** A tap on "Browse" follows the link to `/products`, because the trigger is a real link and hover does not exist. Touch visitors at `lg` and above reach the facets from the footer's Directory column and from `/products`. Below `lg` the mobile menu carries every column.
- **Reduced motion: no animated menu transitions.** Under `prefers-reduced-motion` the panel, its columns, the dimmer, the active bar and any chevron change state instantly (mock-up lines 187 and 720 to 723). Durations and easing belong to §5 "Motion".
- **The hover underline on a menu term is Clay,** as the mock-up has it (lines 653 and 658). A hover underline is not required information, and Clay as a stroke is allowed by clash 4. The term text stays `--text-primary` and the underline never carries the only cue for focus, which is the ring.
- **Counts are quiet tabular numbers** at `--t-13`, in `--text-tertiary` on the white panel (4.83:1). Never on a Bone or sunken surface. If the count is `undefined` (an older API Worker during a deploy), render "All products" without a count. Never print "undefined" or 0 (AECI-1773, AECI-1774).
- **Edge cases.** A term with 0 products never appears (production has `robotics` at 0). A configured key slug the API no longer returns is skipped, and the column shows the rest.
- **The focus ring inside the panel is Forest.** The panel is a white ground, although it sits inside the Forest header. Bone is invisible there.

**Panel type (clash 10, current, on the clash 9 ramp).** This replaces the old three-level panel hierarchy. Column labels are the overline (`.aec-overline`: 600, `--t-12`, uppercase, `--text-secondary`). The mock-up's 11px menu overline is dropped (§3). A destination is weight 400 at `--t-16` in `--text-primary`, pinned at the list component. The row's weight never reaches a panel. A key item is serif at `--t-24`, weight 400 (line 651). The old "column title, 600, 14px" level has no place in the Browse panel. Any other nav panel keeps the pin: destinations at 400, because 500 belongs to two chips only (§3). Whether the account menu's items move is AECI-1771's.

**Starting values** (mock-up 6, default state, line numbers in `6-product-detail.html`. The mock-up's 760px maps to `md` and its 1040px to `lg`. The code issue confirms each):

| Value | Starting value | Line |
| -- | -- | -- |
| Panel | Full width under the header edge, `--surface-base` fill, radius `0 0 24px 24px`, `--shadow-menu` | 632 |
| Panel padding | `48px` top, `32px` bottom, and the `48px` page gutter at the sides. The panel exists from `lg`, where the gutter is `48px`. The frontmatter `menu-panel` agrees. The mobile panel has its own padding below | 634 |
| Grid | Five columns on shared rows, column gap `32px`, and `24px` below a 1200px step | 644, 697 |
| Overline | `12px`, `16px` below | 640 |
| Key item | Serif `24px`, line-height `1.1`, weight 400, tracking `-0.01em`, padding `2px 0 12px` | 650, 651 |
| Term row | `16px`, weight 400, line-height `1.25`, padding `8px 0` | 655, 656 |
| Count | `13px`, tabular figures | 657 |
| Menu footer line | `13px`, `24px` above, `16px` padding over a hairline | 664 |

The mock-up's columns need about 1,130px of its 1,216px row (comment above line 667), and it gives no layout between the inline row's handover and about 1200px. At 1024px the content box is 928px. The floor is set now: between `lg` and about 1200px the panel never clips and never scrolls sideways, and terms may wrap. AECI-1774 picks the layout that meets it.

#### The mobile menu (clash 30, new)

Chris ruled NEW on clash 30. Two floors stay whatever the ruling (`design-rulings.md`, `PLAN.md` §9.2): the toggle has an accessible name, and the open menu traps focus.

- **The toggle keeps the new look.** 44 by 44px, `rounded-control` (12px), a `--surface-on-brand-wash` fill, a Bone icon, at the end edge of the header (mock-up line 46). The icon swaps to a close glyph while open (lines 694 and 695). The shipped toggle is 36px, bordered and at the start edge, so this is a change. The wash is decoration. The Bone glyph (11.03:1) identifies the control.
- **A spoken name.** The toggle has an accessible name. The shipped name is "Open menu". The name becomes "Menu", as the mock-up has it (line 1196), and `aria-expanded` carries the state. The name stays true while the menu is open and the glyph is a close mark. AECI-1775 updates `nav-menu.component.spec.ts` and `e2e/nav-menu.spec.ts`, which assert the old name.
- **The open menu traps focus and closes on Escape,** and Escape returns focus to the toggle. The shipped panel is a `BrnPopover` (a dialog primitive, `aria-haspopup="dialog"`) that supplies the trap, the Escape close and the focus return. Keep it. The mock-up has its own trap in script (`src/catmenu.js` line 49). Do not copy the script. The page behind the popover must be inert. `BrnPopover`'s trap leaves out the toggle, so either the close control is reachable inside the trap or Escape is the documented close path. AECI-1775 owns this.
- **Background scroll is locked while open** (AECI-1775).
- **Order.** "All products" and the key categories first. Then four tap-to-expand sections in the desktop column order: Categories, Phases, Audiences, Trades. Then How we rank and For vendors, then search and the account block (the identity block below, then Account, the role-gated doors and Sign out), or the Sign in button. The mock-up has no search and no account block (AECI-1775).
- **The same data and the same config list** as the desktop menu, with the same orders and the same seven-item cap. Each section carries its own "See all". Its button has `aria-expanded` and `aria-controls`, and its region is hidden when collapsed. Phases show all five.
- **The panel is white, not Forest.** The mock-up panel is `--surface-base` with ink text, radius `0 0 24px 24px` and `--shadow-menu`, under the Forest header strip (line 701 and `screens/browse-menu-mobile.jpg`). AECI-1775's description says "Forest ground, to match the header". Read that as the header strip. The panel follows the mock-up and the desktop panel. The focus ring in it is Forest.
- **The same footer line** at `13px` under the sections (line 717), with the same same-PR rule: whichever of AECI-1774 and AECI-1775 lands first carries the `how-ranking-works` sentences.
- **Starting values** (lines 701 to 718): `max-height: calc(100dvh - 64px)` with `overflow-y: auto` and `overscroll-behavior: contain`, side padding the gutter, top-level rows in serif 600 at `20px` and 58px high, "All products" in serif 400 at `24px` and 48px high, items at `16px` and 44px high with a `13px` count, a hairline between rows, and a Forest "Sign in" button at 44px (`button-primary`, §5 Buttons). The chevron rotates on expand. Under reduced motion it does not animate.
- **Reflow.** The menu works at 320px and at 200% zoom. That is why it takes over below `lg`.

#### The section nav and the sticky bar (`PLAN.md` §4.9, R3 and clash 13)

The section nav is the in-page jump bar on the product page (`shared/section-nav/section-nav.ts`). The vendor page uses it too and waits for its mock-up (AECI-1791).

- **It leads with our wordmark.** When the bar sticks it reads "AEC Integrations › Bluebeam Revu": the AEC Integrations wordmark, then the product name as plain text. Never a vendor logo, a product mark or a vendor colour, on any listing. A vendor logo where our header has scrolled away would read as the vendor's own site. On an unclaimed listing that contradicts "not affiliated with or endorsed by this vendor" (`PLAN.md` §3.9 and §8.5).
- **Items are plain text links,** not a button group. Chris disliked the nav looking like one (`PLAN.md` §3.9). `--t-16` at 400 in `--text-secondary`. Hover goes to `--text-primary`.
- **The current item** is weight 600 in `--text-primary` with a 3px bar on the bar's bottom edge. The bar colour is **Clay**. Ruling R3 (AECI-1734, item 14, 2026-11-14): Chris, by Slack, "A", accepting all six recommendations. Item 14 reads "The section nav active bar is Clay."
- **The bar is never the only cue.** Clay is 2.33:1 on white and 2.09:1 on Bone. The weight and the text colour also mark the current item, and the link carries `aria-current="location"` (clash 28 and R3). The shipped rule stands: the first link is current until a click or the scroll-spy names another, and SSR renders that first link for every visitor.
- **Counts are quiet tabular numbers,** not badges. `--t-13` at 400 in `--text-secondary` (§3 puts counts at `--t-13`). The mock-up sets them at 14px. The mock-up draws them in tertiary ink (line 181). At rest the bar sits on the Bone band, where tertiary is 4.32:1 and fails. Secondary is 6.91:1 on Bone.
- **The surface is solid. No blur.** Chris, clash 13: "Drop the frosted-glass blur on the sticky bar." Once stuck, the bar is `--surface-base` with a hairline `--border-default` edge (mock-up line 732). At rest it is the first part of the one Bone band (§4 band shell). This is settled by clash 13 and the mock-up's default (line 732). The bar is fully solid. AECI-1747's `--surface-sticky` (white at 94%) is therefore unused. The mock-up's stuck-bar shadow (line 145) is dropped under the one-shadow rule (§4).
- **It never hides a focused control (WCAG 2.4.11).** The bar is 72px high, and 64px below `md`. Every focusable element below the bar scrolls clear of it when it takes focus. A `scroll-margin-top` on a `section` protects only the section itself, which an anchor jump uses. It does not protect a link or button inside the section that Tab reaches. Today's `scroll-mt-20` is 80px and clears 72px for the jump only. The likely mechanism is `scroll-padding-top` equal to the stuck bar's height on the scrolling root, applied while the bar is mounted. Caution for AECI-1768: check that it does not add to the offset `ScrollMarginViewportScroller` already applies for anchor jumps, and do not touch the router scroll stack (`CLAUDE.md`, "Router scroll restoration is already solved").
- **It must not clip between 900 and 1300px** (`PLAN.md` §10.2). Overflow scrolls sideways inside the bar, with a visible affordance. That is a scoped scroller and not a page-level scroll, so the page still reflows at 320px.
- **The focus ring is Forest,** drawn inside the item (offset 0, radius 8px) because the scroller clips an outline that sits outside it (mock-up line 173).
- **Starting values** (lines 144 to 186): `position: sticky; top: 0`, `z-index: 20`, items 44px high with `12px` side padding and a `6px` gap between label and count, the bar `3px` with radius `3px 3px 0 0`, the stuck wordmark `24px` high, the product name at `--t-16` in `--text-secondary` capped at 200px with an ellipsis, and a 40px end fade as the overflow cue (line 186). Below `md` the bar is `64px` high, and the stuck bar shows our monogram and no name (lines 576 and 577).
- **Open: "Write a review" at the end of the bar.** The mock-up has a button there above `lg` (line 1334). No ruling or issue covers it. AECI-1768 decides whether it ships.
- **The slide of the bar between items** is motion. Under reduced motion the bar jumps (line 187). The bar's move takes the slow duration (§5 "Motion").
- **The vendor page is not bound.** `section-nav.ts` serves the product page and the vendor page. AECI-1768 puts the new section nav look behind an input that only the product page sets. The vendor page keeps the shipped section nav until its mock-up (AECI-1791) is approved and AECI-1797 builds it.
- **Other in-page navs** (the account page's section nav and the docs "On this page" rail) keep their own rules and are not restyled here.

#### The breadcrumb (clash 31, current)

Chris ruled CURRENT on clash 31 with no note. The separator is `›`, marked `aria-hidden`. The mock-up's slash is dropped.

- **One breadcrumb.** A `nav` named "Breadcrumb", ancestors as links, the last item as text with `aria-current="page"`. AECI-1777 moves every public breadcrumb onto one `aec-breadcrumb` component. They are in `products-index.ts`, `taxonomy-index.ts`, `taxonomy-browse.ts`, `search-page.ts`, `product-detail.ts`, `detail-layout.ts`, `products-pair.ts` and the docs shell.
- **On white** the links are `--text-secondary`, the separator is `--text-tertiary` and hover goes to `--text-primary`.
- **On the Forest hero** the links and the separator are `--text-on-brand-secondary` (7.96:1 on Forest). The tertiary separator the code uses today is never allowed on Forest. Hover underlines the link and goes to Bone (`--text-on-brand`). `--t-14`, an `8px` gap, wrapping, and the current item is text and not a link (mock-up lines 54 to 57 and 1251).
- **The docs top bar draws a slash today** (§5 Product docs). Clash 31 and AECI-1777 move it to `›`.
- **Portal and admin breadcrumbs keep their rule** (R2). They already use `›`.

#### The shell bands and the skip link

The app shell (`app.ts`) renders, in order: the skip link, the header, the legal notice band, the waitlist welcome, `main`, the footer, the consent banner and the update banner. AECI-1777 restyles each to the new tokens and `aecButton`. No band's wording or behaviour changes.

- **The skip link is the first focusable element in the document** (WCAG 2.4.1). It appears above the Forest header on focus. The mock-ups have none and the app keeps it (`PLAN.md` §10.2). Its shipped Forest fill and Forest ring are invisible against the header. On focus it takes a Bone fill with Forest text (11.03:1) and a Bone ring (`--focus-ring-on-brand`) at an offset that leaves a Forest gap. These are starting values for AECI-1777.
- **The legal notice band is shell chrome.** It is a site-wide, full-width Bone band under the header, with a strong bottom border (§5 Vendor portal, AECI-1592). It does not count as the page's one Bone band. This is the orchestrator's reading of 2026-11-14, and Chris is to confirm. Its wording and its dismiss behaviour do not change. It relates to the legal page versions in `docs/STAGE_1_SPEC.md` §27.
- **The stack is a Forest header over a Bone band** on every page while the notice is live. The band is not part of the header.
- **Every control on a Forest ground,** in a banner or elsewhere, takes the Bone ring and Bone ink. A Forest ring is invisible.

#### Portal and admin rows (R2, unchanged)

These rows are outside the public shell and keep the current rule.

- **Active route.** Colour `accent-primary` with a 2px bottom border in `accent-primary`, drawn on the element and not as a side stripe. In a horizontal router row the form is `-mb-px border-b-2` over the row's `border-b`, so the item's border replaces the hairline beneath it. Narrow viewports scroll the row (`overflow-x-auto whitespace-nowrap`). It ships in the vendor portal's section rows and the admin console's category row (AECI-694). The cascade trap under "Vendor portal (Stage 2)" applies, because `border-color` on `*` is unlayered in `styles.css`.
- **Raised for Chris (the Same-Behavior Rule).** The public `/search` entity tabs and the docs guide toggle use the same 2px Forest underline today. The section nav now uses a Clay bar, and the header marks the active route by weight and `aria-current`. Until Chris rules, those two keep the Forest underline. If he wants one "you are here" mark on every public page, they move.
- **The admin row is the one exception to the scroll rule, and it is a consequence and not a preference.** With three items it fits a 320px viewport, and `overflow-x-auto` computes `overflow-y` to `auto` too, which would clip its in-flow dropdown panels. It wraps. Any row that both scrolls and drops down has to portal its panels.
- **A child route level replaces its parent's row.** The vendor portal tried a segmented secondary row under the underlined primary row (AECI-959) and retired it (§6.11). Show one underlined row for the level the page is at, and let a breadcrumb carry the way back up.
- **Dropdown base.** `NavDisclosure` is a shared base. A new dropdown in the public primary nav extends it. The trigger shape is the implementor's. The admin console's row (`admin/admin-nav-dropdown.ts`, AECI-694) keeps a `button` trigger with no arrow icon. It is deliberately not `@angular/aria/menu`, because a navigation row of router links is not an application menu and `role="menu"` is the wrong semantic. `ANGULAR_STYLE_GUIDE.md` §19 and ADR 0010 carry that clarification. The arrow stays on form controls and on the mobile menu's expand rows.
- **A category with exactly one destination is a plain link,** not a one-item dropdown. Label it with the group name. Keep the rule structural (`items.length`).
- **A dropdown whose panel contains a text field does not hover-open.** It opens on click, focus goes into the field, Escape or Tab closes it and returns focus to the trigger, and an outside click closes it. It cannot use `NavDisclosure` mechanically, because a panel in the top layer is not a DOM descendant of the host.
- **Grouped nav lists are separated by vertical rhythm, never by indentation.** A destination sits on the same left rail as its group label. Roughly 12px between items and 26px at a group boundary tells a reader where a group ends. The live instances are the mobile menu's account block and the admin console's panels. Do not indent items under their label, because an indent reads as tree depth.

#### Handover breakpoint and the width budget

The inline row appears from `lg`. Below `lg` the toggle carries navigation (`aec-nav-menu` is `lg:hidden`). Clash 29 asks for `md`: the mock-up shows its inline row from 760px, which maps to `md`, and its search pill from 1040px, which maps to `lg`. The row is held at `lg` until AECI-1771 measures the three-link row.

- **The old measurement is retired.** AECI-669 measured a six-item row at 768px and found it 127px over. The row now has three links, so that table no longer applies. The mock-up's own handover has not been measured in code.
- **A new primary destination is a re-measure at 1024px,** not an insert. AECI-1771 re-measures the three-link row at `md` and `lg`, signed out (the wider case), against the pill and Sign in. Three classes move together if the handover moves: the row's `lg:flex`, `aec-nav-menu`'s `lg:hidden` and the search trigger's `lg:block`. A mismatch renders two Primary landmarks, or none, or leaves a band with no search.
- **Reflow.** Nothing clips at 320px or at 200% zoom, and a text label never wraps inside the header row.

**The Overflow Rule (rewritten by clash 26).** The primary row is width-budgeted, public-only and closed. It now carries three things: Browse, How we rank and For vendors.

- **A new secondary destination goes to the footer,** not into the row and not into a header menu. The footer is server-rendered on every page, so a link there is as reachable and as crawlable as one in the header. See "The footer" below. How we rank and For vendors are now also header links, and they stay in the footer.
- **A new primary destination is a re-measure at 1024px,** not an insert.
- **A role-gated surface gets one door in the account menu** (`layout/user-menu.ts` at `lg` and up, the mobile menu's account block below). Never a row item.

**Why the doors are in the account menu, not the row.** The row is the site and the avatar is you and what you can operate. The row renders on cached, URL-keyed, indexable pages and must look the same to everyone. A private, `noindex`, role-gated door in it would make the row's width depend on who is looking, against the closed width budget. The account menu is already the viewer-dependent region. It only mounts when signed in, and it already held the Vendor portal door. Putting Admin beside it makes the two portals symmetric.

**Both doors are one link each**: "Admin portal" to `/admin` and "Vendor portal" to `/vendor`, in sentence case. User-facing copy says portal, never dashboard (`STAGE_2_VENDOR_PORTAL_SPEC.md` §6.3). Neither restates its portal's sections. The pending-review badge sits on the account-menu trigger, following the Admin door. Its colour pairing on Forest is not measured and is AECI-1771's.

**Nothing role-gated may reach server-rendered HTML.** Both doors are gated on the shared, browser-only role probe (`auth/role-status.ts`), which reports `null` during SSR. This is the header-side complement to `/admin/*` being non-cacheable.

#### Open values (navigation)

| Open value | Why it is open | Owner |
| -- | -- | -- |
| The header's handover breakpoint and the three-link width budget | Needs a measurement at `md` and `lg`, signed out | AECI-1771 |
| The signed-in account trigger and the pending-review badge on Forest | No mock-up draws them, and neither pairing is measured | AECI-1771 |
| Whether the account menu's items move off weight 500 | The ramp allows 400 and 600 | AECI-1771 |
| The reversed wordmark file and the `tone` input | The shipped dark file bakes in a Forest box (`PLAN.md` §10.5) | AECI-1754 |
| The pill's width bands | See "Header search". The "/" shortcut's WCAG 2.1.4 mechanism is a requirement, not an open value | AECI-1772 |
| Where the grace timing lives, and the panel layout between the handover and about 1200px (the floor is set) | See "The Browse menu" | AECI-1774 |
| The shared scrim token for the Browse dimmer and the CDK backdrop | See "The Browse menu" | AECI-1770 |
| The close control inside the focus trap, or Escape as the documented path | See "The mobile menu" | AECI-1775 |
| The footer's link size and its width re-measure at 375, 768, 1024 and 1280px | See "The footer" | AECI-1776 |
| The skip link's on-focus look, the band restyles and the single breadcrumb component | See "The shell bands" | AECI-1777 |
| "Write a review" on the sticky bar, the focus-clearance mechanism and the overflow cue | See "The section nav" | AECI-1768 |
| Header copy "Search directory" against the mock-up's label | See "Header search" | Chris |
| Which order AECI-1836 settles on for audiences and trades | The exception stands until it rules | AECI-1836 |
| The `/search` entity tabs and the docs guide toggle: Forest underline or Clay bar | The Same-Behavior Rule. For Chris to decide | Chris |

### The account menu's identity block (AECI-850)

The account menu opens with **who you are**, then the things you can do. Source:
`apps/web/src/app/layout/account-identity.ts`, one component rendered by **both**
the desktop dropdown (`user-menu.ts`) and the mobile overlay (`nav-menu.ts`) — an
identity block composes three sources and gets the wrong answer *quietly* when
duplicated, which a link list does not.

**Anchor: Laravel Cloud**, with the role pill from **Hootsuite**. Both are
departures from the Stripe site-chrome anchor (see "The footer"), recorded here
because the Anchor-Site Rule requires the anchor to be recorded with the surface.
The departure is deliberate and narrow: Stripe's own account dropdown puts name +
role in a **dim footer** below Sign out, which reads as metadata rather than as an
answer to "which account is this?". Laravel Cloud's top block — avatar, name,
email, hairline, destinations — states it first. Nothing else on the surface moves
to Laravel; composition, density and atmosphere elsewhere stay Stripe's.

| Row | Content | Rule |
|---|---|---|
| Avatar | 32px **circle** (`LogoOrInitial` `size="sm" shape="circle"`) | A person is a circle; every company mark on the same page is a rectangle. That is the only thing distinguishing them at 32px |
| Primary | `profiles.display_name` → provider `full_name` → the email → "Signed in" | Never empty: an empty line collapses the reserved box and the menu jumps under the cursor |
| Secondary | The email, at `text-secondary` | **Dropped entirely** when the email is already the primary line, so the block never prints one string twice |
| Pill | Site admin / Vendor admin / Reviewer | Rendered for **every** role including the `reviewer` default. On a review platform "Reviewer" is a standing, not an empty state, and a staff-only pill would make the block's height depend on who is looking |

**Rules.**

- **The initial letter is the primary design; the photo is the enhancement.** Only
  Google sign-ins carry `user_metadata.avatar_url`, and magic-link is the majority
  path — so "no photo" is the common case. Design the block with the letter first
  and check the photo second, not the reverse.
- **The avatar stays neutral, never an accent.** It inherits `LogoOrInitial`'s own
  tokens verbatim — `text-primary` on `surface-raised` inside a `border-default`
  ring — so it reads as quiet chrome rather than as a highlight. Only the pill may take
  colour, and only Forest (`accent-primary-soft` fill, `accent-primary` text), and
  only for the two roles that open a portal door. Colour is never the sole signal
  — the label beside it names the role.
- **`referrerpolicy="no-referrer"` on every provider photo.** Hotlinking
  `lh3.googleusercontent.com` otherwise tells Google which AECi page a signed-in
  visitor is on, on every page load. Trust-first positioning does not permit that
  for a decorative 32px image. `img-src 'self' data: https:` already allows the
  load, so no CSP change was needed.
- **The trigger keeps its neutral glyph until a photo exists.** It does *not* swap
  in an initial letter: the role is cached in `sessionStorage` but the email is
  not, so a letter would flicker in on every single page load. The photo lands
  once, with the async session snapshot, and only for Google accounts.
- **A photo that fails to load returns to the glyph, in both places.** The panel's
  avatar gets this from `LogoOrInitial`; the trigger has its own `(error)` handler.
  `user_metadata` only refreshes at re-authentication, so a long-lived session
  outlives the Google CDN URL it carries, and an empty `alt` makes a browser
  collapse a broken image to nothing — an empty circle where the account control
  should be. The failure is per-URL, so a fresh snapshot gets a fresh attempt.
- **The block is not focusable and carries no `role`.** It labels the menu that
  follows it. A link here would add a tab stop in front of "Account" for no new
  destination.
- **Nothing here reaches cached HTML**, by the same guarantee as the portal doors:
  `SessionStatus` is neutral through SSR and `RoleStatus.role()` is `null` until
  the browser-only probe resolves.
- **The panel is `w-64`, up from `w-56`.** The email is the widest string it
  carries; at 14rem it truncated to roughly fourteen characters and told the
  reader nothing.

### The footer

It was never specified until the Overflow Rule made it load-bearing. It is the home for every secondary destination and the only site-wide entry point for several of them. Source: `apps/web/src/app/layout/site-footer.ts`. The columns are pinned by `site-footer.component.spec.ts`, because a link quietly dropping out is a regression and not a tidy-up.

**The ground is Forest (clashes 1 and 32).** Chris ruled BLEND on clash 32 with no note. The blend is the clash recommendation: accept the Forest ground, and keep the four shipped columns and their overline labels. This rewrites the old "white `surface-base` on every page" rule. The mock-up's own columns (Browse, How we work, Company, Legal, with Vendors, Data objects, Attestations and Cookies added and the Help column gone) are not adopted. `PLAN.md` §4.10 says "The footer sits on a dark Forest ground. It keeps the four shipped columns, Directory, Help, Legal and Company, with overline labels."

**Anchor:** the redesign's mock-ups, which draw the footer (clash 44, §2 "The redesign's anchor"). The shipped layout stays: a brand region (the wordmark and a one-line tagline) beside a nav group of four labelled `<nav>` columns, over a bottom strip carrying the copyright, separated by a hairline. The layout is unchanged. The nav group is its own responsive grid (2 columns below `md`, 4 from `md`) so the columns stay balanced. Three columns at `sm` would orphan the fourth. From `lg` the brand sits left and the nav group right. The nav group does not shrink (`shrink-0`), so at 1024px the brand's tagline gives up width instead of a link label wrapping. The mock-up's grid steps (five columns above 1040px, two below) are not adopted, because clash 32 does not rule on layout.

**Colour on the footer ground** (`--surface-footer`, `#15291F`):

| Part | Colour | Contrast |
| -- | -- | -- |
| Ground | `--surface-footer` | |
| Links and the copyright | Bone, `--text-on-brand` | 13.71:1 |
| Column labels (overlines) and the tagline | `--text-on-footer-secondary` | 8.76:1 |
| Hairline above the bottom strip | `--border-on-brand-subtle` (Bone 14%), decorative, 1.51:1 | |
| Focus ring | Bone, `--focus-ring-on-brand` | 13.71:1 |
| Wordmark | The light-on-dark variant (AECI-1754) | |

- **Link hover is an underline in Bone,** 3px offset (mock-up line 474). Colour never carries it. `--text-on-footer-secondary` fails on Forest hover (4.39:1), so the footer has no hover fill. The mock-up's links are Bone at rest (line 473), and the shipped footer's `text-secondary` rising to `text-primary` is retired.
- **Tertiary text is never on the footer ground** (§2).
- **Column labels are overlines** (`.aec-overline`, §3), in `--text-on-footer-secondary`. The mock-up's labels are `h4` and skip heading levels (`PLAN.md` §10.2). The shipped labels are `p` inside `nav` landmarks that carry an `aria-label`, so the shipped footer skips no level. If a label becomes a heading, it must not skip a level. AECI-1776 settles which.
- **Wording does not change.** The mock-up's pitch ("Integrations in architecture, engineering and construction, reviewed by the people who use them.") and its base line ("Rankings are algorithmic. No vendor pays for a place.") are invented copy and are not adopted. The shipped tagline and copyright stay. A trust sentence in the footer needs its own check against the legal and trust pages first.
- **Starting values** (mock-up lines 467 to 476, 497 and 498): padding `64px` top and `32px` bottom, label margin `16px` below, `12px` between links, links at `16px`, the bottom strip `48px` below the grid with `24px` padding over its hairline, copyright at `14px`, wordmark `28px` high. The shipped links are `text-sm` (14px). The mock-up's 16px may change the nav group's width at 1024px, so AECI-1776 re-measures at 375, 768, 1024 and 1280px (AECI-1776 owns the footer values).
- **Targets** are at least 24 by 24 CSS px (WCAG 2.5.8). Link rows with a 12px gap clear it at 16px text.

**The four columns, and why each holds what it does:**

| Column | Holds | Why |
|---|---|---|
| **Directory** | Home, Products, Categories, Audiences, Trades, Phases | The primary surfaces, in **server-rendered HTML**. The header's facet values render client-side and its mobile menu never reaches SSR, so this is where a crawler meets the taxonomy. With Home and Products gone from the header (clash 26), it is also the Tab-reachable list of the Browse destinations. |
| **Help** | Help center, Getting started, How ranking works, Vendor guide | The footer-only entry into `/docs` (AECI-1252, `docs/STAGE_2_PRODUCT_DOCS_SPEC.md` §7 question 3). "Vendor guide" links `/docs/vendors/overview`, the vendor guide's first page (AECI-1253). It is not called "For vendors", because that is the Company column's link to `/vendor-program`. "How ranking works" is also reached from the header's "How we rank". Four items, inside the four-to-six range. |
| **Legal** | Terms, Privacy, Review guidelines, Listing accuracy | Trust-first positioning means the legal set is one click from every page, not buried. |
| **Company** | About, Methodology, For vendors, Contact, Updates, Roadmap | Who we are and where we are going. Methodology sits next to About because it is the same kind of destination (AECI-804). "For vendors" is the public vendor landing page `/vendor-program`, after Methodology (AECI-1283, `VENDOR_PROGRAM_PAGE_SPEC.md` §2.4). The header now links For vendors too (clash 26). Methodology, Updates and Roadmap stay footer-only. Six items is the column's ceiling. |

Nothing in the footer's links changes (AECI-1776: "keep the four columns and every link exactly").

**Rules.**

- **Every column is a `<nav>` with an `aria-label`.** Four unlabelled navs in one landmark are indistinguishable in a screen reader's landmark list.
- **The footer is visitor-neutral, absolutely.** It sits inside URL-keyed cached HTML and holds no session state: no portal door, no account link, no badge. That is what lets it render identically for everyone. Role-gated affordances live in the account menu (the Overflow Rule). The vendor portal and admin console show this same footer under their own pages (Chris, 2026-11-14, see "Scope" above).
- **Vendors and Integrations are deliberately absent** (AECI-160, PO decision. AECI-165 removed the index pages, which now 301 to `/products`). Their detail pages stay reachable via product links, `sitemap.xml` and search.
- **i18n ids are shared, not duplicated.** Several links reuse `@@app.nav.*` and `@@app.footer.*` ids that other surfaces also emit. Keep the tight `<ng-container i18n>` wrap so the extracted source string stays byte-identical. An identical source under a shared id is one translation unit, and a differing one is a collision. If the header and the mobile menu drop their Home and Products links, the footer is the only emitter of those ids.
- **Adding a column** is a re-measure at every breakpoint. Prefer growing an existing column. Four to six items read fine. The Help column (AECI-1252) was the exception because the help center is a destination of its own kind. It moved the grid from 2 to 3 to 2 to 4, measured at 375, 768, 1024 and 1280px.

### Layout shells

Three reusable Angular shells (`apps/web/src/app/layouts/`) — every Phase 2 page projects body content into one of them via named slots (shadcn-style composition). No state, no inputs; structure only. Anchor inherited from the AECi site chrome (Stripe — see Named Rules).

Until clash 16, all three shared the same outer container. DetailLayout now has its own band shell (below, and §4). The Browse shell and the form pattern keep the **standard canvas** `mx-auto w-full max-w-7xl px-6 md:px-8` with `py-8 md:py-12` (the Page-Width Rule, §3): `max-w-7xl` centered, `surface-base` background, `text-primary` text, 24px horizontal / 32px vertical padding on phones, 32px / 48px on `md` and up. Section dividers use `border-default` (1px on the redesigned components, 0.5px on shipped surfaces not yet rebuilt). The canvas itself takes no shadow.

- **DetailLayout** (`<aec-detail-layout>`) — for the product and vendor detail pages. **Rewritten by clash 16 as a band shell for the product page** (new). AECI-1778 builds it. The vendor page waits for its mock-up (AECI-1791) and AECI-1797 then moves it onto the shell. §4 "The detail page band shell" holds the rule, the band order and the starting values. This bullet keeps the slot contract.
  - **Slots:** `breadcrumbs`, `hero` (required), `nav`, `body-lead`, `metadata`, `body` (required). The slot list is the shipped one. AECI-1778 decides which slots survive, because the sidebar they served is gone on the product page.
  - **Grid, product page:** no sidebar column. The hero band is Forest, the facts card overlaps its lower edge, and the body is full-width bands (§4). It keeps one column at every width, so DOM order is the reading order.
  - **The sticky in-page nav gets its own slot.** `nav` is projected **bare** (no wrapper element) as a direct child of the page container. `position: sticky` is bounded by the parent's box, so a nav inside a body column unpins as soon as that column scrolls past. Its bottom margin therefore lives on the nav element itself. Never wrap that slot. The nav always marks one link `aria-current="location"`: the first section until a click or the scroll-spy names another. SSR renders that same first link for every visitor, as the docs "On this page" rail does (AECI-831).
  - **Tables in a band** are checked against the content column, the viewport minus both gutters (§4). The old 608px check and the 38rem floor came from the sidebar split (AECI-853) and no longer apply on the product page.
  - **Vendor page, until AECI-1797 moves it:** the shipped layout stands. `lg:` two columns (2fr main, 1fr metadata) with a sticky sidebar that undocks between `body-lead` and `body`, a hero bordered below, `space-y-12` between body sections, `space-y-6` in the sidebar, and body tables checked against 608px. The old text is in git history at commit `5acfeda50`.
  - **Internal rhythm:** bands carry their own padding and separate by a hairline between two white bands (§4). The standard canvas above describes the Browse and form shells, which the rulings did not change.

- **BrowseLayout** (`<aec-browse-layout>`) — for the card-grid browse pages (Phase 3 filters).
  - **Slots:** `header` (required), `filters` (Phase 3 placeholder), `grid` (required).
  - **Grid:** `md:` two-column (1fr filters / 3fr grid) with sticky-top filters; filters collapse above grid on phones.
  - **Internal rhythm:** header bordered below; grid uses container's own card spacing.

- **Form + context rail** (AECI-987; a pattern, not a shell component): for single-step forms, namely the review form, the routed claim and correction pages, `/welcome`. Anchor: Stripe (the AECi chrome anchor), whose settings and checkout forms pair a capped form with a quiet summary column.
  - **Grid:** the standard canvas, then from `lg` a 12-column grid with `gap-x-12`. The header and the form take columns 1 to 7, the controls capped at `max-w-2xl`. The `aside` takes columns 9 to 12 (`lg:col-start-9 lg:col-span-4`), spans the header and form rows, and is `lg:sticky lg:top-8 lg:self-start`.
  - **Sticky goes on the tall column's child.** The sticky classes sit on the `aside` itself, a direct grid child whose grid area is the full row height. Never on a `nav` or `aside` inside a short host box: sticky travels only within its containing block, so it would not stick.
  - **Below `lg`** the rail stacks between the page header and the form as a contained panel: `surface-raised` fill, `border-default` hairline, `rounded-card`, `p-6`. Docked at `lg` it is bare on the page background. *(2026-11-14: the card radius is now 24px, `rounded-card` and `--radius-card` (clash 12). `rounded-lg` still renders 8px. `p-5` is 20px, off the spacing scale, so it is `p-6`. The rail's content is short copy, so nothing nests in it today, though clash 14 would allow it. Whether it takes the card shadow is open, with the rest of that set in §4 "Open values" (AECI-1765). Until then it takes none.)*
  - **Content:** only data the page already loads (no new API call) and short static copy: what you are acting on, what happens next, one docs link that opens a new tab so a half-filled form survives. All copy is `i18n` / `$localize`.

Every visible string and every ARIA label is i18n-wrapped (`@@app.layouts.{detail|browse}.{slot}.aria`). Concrete pages add their own i18n keys for projected content.

> **`IndexLayout` and `EntityTable` (§11.2) — neither ships.** The Phase 2 spec listed a generic sortable / paginated `EntityTable` primitive; in implementation its whole responsibility (the semantic `<table>`, the scroll container, the `table-header` / `table-body` / `pagination` slots) was folded into a third shell, `IndexLayout` (`<aec-index-layout>`), so no separate `EntityTable` class was ever written. `IndexLayout` then lost its own consumers: AECI-165 deleted the `/vendors` + `/integrations` index pages, and AECI-190 rebuilt `/products` on **`BrowseLayout`** (it needs the facet rail, which `IndexLayout` has no slot for). The shell was deleted in AECI-657. Listing pages now compose `BrowseLayout` + their own `<table>` or `ProductCardGrid`; if a table shell is ever wanted as a primitive again, extract it from `products-index.ts` at that point.

## 6. Do's and Don'ts

The strategic anti-references in `PRODUCT.md` carry through here as concrete visual prohibitions. Every PRODUCT.md anti-reference appears below as a "Don't" with the same language. The redesign rulings of 2026-11-13 and 2026-11-14 rewrote several of them. A clash number beside a rule means that ruling set it, and the rule it replaced is named.

### Floors that no ruling overrides

These are accessibility and legal rules, not style. `PLAN.md` §9.2 lists the first four, and ADR 0056 records them. Reviews added the rest. None of them is a lint check unless a line says so.

1. **Inputs keep a 3:1 boundary** (clash 23, WCAG 1.4.11). Every form control has a visible edge at 3:1 against its ground (§5 "Inputs / Fields").
2. **The mobile menu toggle has an accessible name, and the open menu traps focus** (clash 30, §5 "The mobile menu").
3. **An unclaimed product shows an initial tile everywhere except its own page** (counsel's ruling 9, §5 "Logos and initial tiles").
4. **Smooth scrolling must not break router scroll restoration, and it must respect reduced motion** (clash 38, §5 "Motion").
5. **The focus ring is an outline, not a box-shadow,** because forced-colours mode drops shadows. On Forest, the hero panel and the footer ground it is Bone (`--focus-ring-on-brand`, AECI-1747, 11.03:1 on Forest). A Forest ring on the hero panel is 1.20:1 and is never used (§4 "Shadow Vocabulary"). Use the plain utility for the ring. Use the shared unlayered `aec-on-brand-rule` class for a `--border-on-brand-subtle` hairline on Forest, and `aec-on-brand-edge` for the 3:1 `--border-on-brand-strong` control edge. A `border-(--x)` utility never applies, because the `*` border rule is unlayered. Never write component CSS or a `!` for any of these (AECI-1845).
6. **Focus is never hidden under the sticky bar** (WCAG 2.4.11, §4 "The detail page band shell" and §5 "The section nav").
7. **State is never shown by colour alone** (WCAG 1.4.1). A selected chip, a pressed segment, a side stripe, an agreement state and an error each carry a second cue.
8. **A target is at least 24 by 24 CSS pixels** (WCAG 2.5.8). Buttons are 44px high (§5 "Buttons").
9. **Fluid type respects zoom.** Each fluid bound is in rem, and the tokens are checked at 200% zoom (WCAG 1.4.4, §3).
10. **No summary count of agreement states ships** (clash 41, `PLAN.md` §7.7, §5 "Badges").
11. **No pay-for-placement.** A new list is A to Z by name with the id as tie-break (ruling R1). No order, default filter or featured subset reads an input a paid plan can change (`PLAN.md` §7.8, tested by AECI-1814). "Confirmed by both companies" is never a filter or a sort (§5 "Order (R1, 2026-11-14)" and "Badges").
12. **Public counts wait for the Privacy Policy text and hide below 10** (ruling R7, AECI-1825, §5 "Integration stat").
13. **Legal-reviewed strings are used verbatim** (§5 "Unclaimed note" and "Integration stat").
14. **Cached SSR is visitor-state neutral** (§5 "Navigation", "The header never varies by visitor in cached HTML").
15. **Light theme only.** No dark theme, no `dark:` variant and no toggle (§1 Key characteristics, §2).
16. **Text meets AA contrast, and the `--text-tertiary` limits hold** (§2).
17. **A control on Forest or on the hero panel takes a filled background** (§2 "Forest grounds", §5 "Inputs / Fields").
18. **The "/" shortcut follows WCAG 2.1.4** (§5 "Header search").
19. **Hover content follows WCAG 1.4.13** (§5 "The Browse menu").
20. **Pages reflow at 320px and at 200% zoom** (§5 "Handover breakpoint and the width budget").

### Do:

- **Do** use OKLCH in CSS (`oklch(...)`) for color tokens. Hex values are documented as fallbacks but the canonical source is OKLCH (the front matter, plus `apps/web/src/styles.css`).
- **Do** pair Source Serif 4 (display) with Atkinson Hyperlegible Next (body) — the chosen system pair. Use them in their assigned roles (display for headings, body for prose, label for buttons / badges / table headers, overline for eyebrows / kickers / sidebar microheadings).
- **Do** use sentence case everywhere. Headings, buttons, labels, navigation, table headers, page titles, section titles. The overline role is the single uppercase exception (§3).
- **Do** use a 1px border on controls and chips (`border-default`, with `border-strong` for emphasis and 2px for featured and error states). This rewrites "0.5px default borders" (clashes 20, 22 and 23). Some shipped surfaces still draw 0.5px and change as each is rebuilt.
- **Do** keep Clay rare (≤5% per screen, decorative/fill only — fills carry `text-primary`, never white). Clay-colored text and icons use Clay deep (`#A14D22`). Star-rating glyphs use Goldenrod (`#DAA520` / `--accent-rating`). The main button is Forest with white text (the Forest-Anchor Rule). On a Forest ground it is Bone with Forest text (clash 3). It is never Clay.
- **Do** use Bone as a *warm-tinted accent surface*: one band per page (clash 2), never a page background. On a Forest ground Bone is the ink (clashes 3 and 4).
- **Do** vary spacing for visual rhythm (4pt scale: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96). Tight groupings, generous separations.
- **Do** use container queries (`@container`) for component-level responsiveness; viewport queries for page layout.
- **Do** respect `prefers-reduced-motion` on every transition. Use the three durations: fast 120ms for press and row hover, base 180ms for hover, focus and disclosure, slow 280ms for menu open, the nav ink bar and the scrim (clash 36, §5 "Motion").
- **Do** draw every icon on a public page through `aec-icon`, in `currentColor`, decorative or labelled (clash 34, §5 "Icons").
- **Do** show a visible focus-ring on every interactive element (`:focus-visible`), as an outline. Never `outline: none` without a replacement.

### Don't:

- **Don't** let a side stripe be the only cue. Coloured side stripes are allowed on a card or tile (clash 15, new), always beside a text label, in an existing token, never as a gradient (§4 "Coloured side stripes are allowed"). This rewrites "Side-stripe borders are banned". The ruling names cards and tiles. Whether a callout or an alert may take one is open (Chris). Three shipped stripes already exist: the prose blockquote (`styles.css`, `.aec-prose blockquote`), the pair diff rows (`products-pair.ts`, `DIFF_ADDED_ROW` and `DIFF_REMOVED_ROW`) and the vendor history reason (`vendor-history-page.ts`, `data-history-reason`).
- **Don't** use gradient text (any combination of `background-clip` text fill plus a gradient `background`). **Gradient text is banned.** Solid colors only; emphasis via weight or size.
- **Don't** use the hero-metric template (big number + small label + supporting stats + gradient accent). It's the SaaS cliché; the score-display component is the editorial alternative. One large figure per band (clash 8).
- **Don't** use sparklines as decoration. Tiny charts that look sophisticated and convey nothing meaningful are noise.
- **Don't** put a shadow on a nested card. Cards may nest (clash 14, new): only the outer card carries `--shadow-card`, and the nested panel is a tint or a hairline (§4 "Cards may nest"). This rewrites "Don't nest cards inside cards".
- **Don't** build a card grid wider than three columns, or one with no break (clash 18, blend). Cap the grid at three columns and break it with a group header (§4 "Card grids cap at three columns"). Ruling R3 dropped the wide lead card on the integrations list. This rewrites "Don't use identical card grids". Cards with an icon, a heading and eight words each are still a cliché.
- **Don't** use any of the reflex-reject fonts: Inter, DM Sans, Plus Jakarta Sans, Geist, Mona Sans, Space Grotesk, IBM Plex Sans, Outfit, Roboto, Open Sans, Arial, Fraunces, Newsreader, Lora, Crimson Pro, Playfair Display, Cormorant, Cormorant Garamond, DM Serif Display, DM Serif Text, Instrument Sans, Instrument Serif, Syne. The chosen pair is Source Serif 4 + Atkinson Hyperlegible.
- **Don't** use `#000` or `#fff` directly. Use `text-primary` (`#0A0A0A`) and `surface-base` (`#FFFFFF`) tokens.
- **Don't** use bounce or elastic easing on motion. Every eased move uses `ease-standard`, `cubic-bezier(.2,.7,.2,1)` (clash 36). Real objects decelerate smoothly.
- **Don't** use glassmorphism (blur, glass cards, glow borders) decoratively. Rare and purposeful, or nothing. The sticky bar has no blur (clash 13).
- **Don't** put a box-shadow on a button, chip, input or tab (clash 11). Top-level floating cards take `--shadow-card`, and menus take `--shadow-menu`. This rewrites "no shadows on cards". A tinted shadow is never allowed.
- **Don't** use the AI color palette: cyan-on-dark, purple-to-blue gradients, neon accents on dark backgrounds, gradient backgrounds for impact. The one gradient allowed is the hero's soft single-colour glow (clash 13).
- **Don't** use stock photography of construction sites, hard hats, or blueprints. The AEC visual cliché — the brand is editorial about AEC, not a costume of AEC.
- **Don't** use emoji in UI chrome. Use the custom icon set (clash 34, §5 "Icons"). Emoji rendering is inconsistent across platforms and clashes with the editorial brand. This rewrites "Lucide icons exclusively".
- **Don't** use em dashes in UI copy (also not `--`). Use commas, colons, semicolons, periods, or parentheses.
- **Don't** make every button primary. One filled button per surface (clash 21). Use ghost and secondary variants — hierarchy matters.
- **Don't** use modals as the first thought. Exhaust inline / progressive disclosure / drawer alternatives first.
