---
name: AEC Integrations
description: Editorial directory and review platform for AEC software integrations. Light-theme default, dark-theme parity, Tailwind v4 + Spartan brain.
colors:
  # Light theme (default)
  surface-base:           "oklch(100% 0 0)"
  surface-raised:         "oklch(98.43% 0 0)"
  surface-sunken:         "oklch(96.78% 0.0019 286.38)"
  border-default:         "oklch(91.97% 0.0036 286.32)"
  border-strong:          "oklch(87.20% 0.0055 286.32)"
  text-primary:           "oklch(14.48% 0 0)"
  text-secondary:         "oklch(43.86% 0.0145 285.94)"
  text-tertiary:          "oklch(70.90% 0.0149 286.07)"
  accent-primary:         "oklch(31.92% 0.0436 152.32)"
  accent-primary-hover:   "oklch(43.83% 0.0658 152.61)"
  accent-secondary:       "oklch(76.10% 0.1144 47.10)"
  accent-warm:            "oklch(95.62% 0.0149 95.45)"
  # Dark theme
  dark-surface-base:      "oklch(14.48% 0 0)"
  dark-surface-raised:    "oklch(21.78% 0.006 285.88)"
  dark-surface-sunken:    "oklch(13.71% 0.0036 286.10)"
  dark-border-default:    "oklch(27.41% 0.0055 286.04)"
  dark-border-strong:     "oklch(37.07% 0.0119 285.81)"
  dark-text-primary:      "oklch(98.43% 0 0)"
  dark-text-secondary:    "oklch(70.90% 0.0149 286.07)"
  dark-text-tertiary:     "oklch(55.21% 0.0163 285.94)"
  dark-accent-primary:    "oklch(61% 0.0805 152.41)"
  dark-accent-primary-hover: "oklch(68.5% 0.0867 152.69)"
  dark-accent-secondary:  "oklch(78.50% 0.1141 47.85)"
  dark-accent-warm:       "oklch(22.42% 0.0079 67.38)"
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
    fontFamily: '"Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: "normal"
  label:
    fontFamily: '"Atkinson Hyperlegible", system-ui, -apple-system, "Segoe UI", sans-serif'
    fontSize: "0.8125rem"
    fontWeight: 700
    lineHeight: 1.4
    letterSpacing: "0.01em"
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
  index-layout:
    backgroundColor: "{colors.surface-base}"
    textColor: "{colors.text-primary}"
    padding: "{spacing.8} {spacing.6}"
    md_padding: "{spacing.12} {spacing.8}"
    rowDivider: "1px solid {colors.border-default}"
    headerTypography: "{typography.label}"
---

# Design System: AEC Integrations

## 1. Overview

**Creative North Star: "The specifier's reference."**

AECi reads as an editorial industry reference — a published artifact closer in spirit to a printed product specification or a specialist trade journal than to a SaaS landing page. The reader is an AEC professional making a serious decision; the surface should feel built for that job, not built for a marketing demo. Restraint, density, generous whitespace, sentence case, and a serif headline that borrows posture from `ENR` or `Architectural Record` — never from a startup landing page.

The system rejects the AI-startup visual cohort entirely: no purple-to-blue gradients, no glassmorphism, no hero-metric template, no Inter / DM Sans / Plus Jakarta Sans / Geist / Mona Sans / Space Grotesk / IBM Plex Sans / Outfit / Fraunces / Newsreader / Playfair Display / Cormorant / DM Serif / Instrument Serif / Syne. It also rejects the horizontal-SaaS-directory cohort (G2, Capterra, GetApp): no equal-weight feature grids, no logo clouds as proof, no orange-and-cream marketplace cream. Forest, Bone, and Clay carry brand identity as accents; surfaces stay neutral and let content lead.

**Key Characteristics:**

- Editorial restraint over commercial enthusiasm. Sentence case everywhere.
- Pair a refined serif (Source Serif 4) with an a11y-first sans (Atkinson Hyperlegible). The pairing itself is the brand statement.
- Forest is the anchor accent. Clay is rare (≤5% per screen, large-text or graphical only). Bone is a warm-tinted accent surface, never a page background.
- Borders separate surfaces. Shadows are reserved for modals, dropdowns, and focus rings.
- Both themes always: light theme is the marketing default, dark theme has full token parity for app surfaces and reader preference.

## 2. Colors

A neutral surface palette with three brand accents (Forest, Clay, Bone) and two near-monochrome text scales. Frontmatter values are OKLCH for perceptual uniformity (and to enforce Impeccable's color doctrine); each color's documented hex equivalent is the canonical sRGB value used by `apps/web/src/styles.css` and `docs/BRAND_GUIDELINES.md`.

### Primary

- **Forest** (`#1E3A2F` / `oklch(31.92% 0.0436 152.32)`): the primary brand color. CTAs, links, headings, the connector mark, primary badges. Hover state is **Forest Hover** (`#2E5C45` / `oklch(43.83% 0.0658 152.61)`) — measurably brighter, never a synthetic opacity reduction.

### Secondary

- **Clay** (`#E89668` / `oklch(76.10% 0.1144 47.10)`): warm secondary accent. Connector mark, primary CTA fills where appropriate, "verified" / "featured" badges, high-emphasis highlights. Fails WCAG AA on white for body copy (~2.4:1) — see the Clay restriction below.

### Tertiary

- **Bone** (`#F5F2EA` / `oklch(95.62% 0.0149 95.45)`): warm-tinted *accent surface*. Hero bands on About, callout sections, marketing emphasis. **Not a page background.**

### Neutral

- **Surface base** (`#FFFFFF` / `oklch(100% 0 0)`): default page background, light theme.
- **Surface raised** (`#FAFAFA` / `oklch(98.43% 0 0)`): cards, panels.
- **Surface sunken** (`#F4F4F5` / `oklch(96.78% 0.0019 286.38)`): inset wells, code blocks, secondary states.
- **Surface muted** (`#F4F4F5` / `oklch(96.78% 0.0019 286.38)`): interactive row hover / `focus-within` highlight on index tables. Shares the surface-sunken value by design — the two never co-occur inside a row, and a hover wants the same one-step lift sunken gives on white.
- **Border default** (`#E4E4E7` / `oklch(91.97% 0.0036 286.32)`): standard separators (0.5px default, 1px emphasis).
- **Border strong** (`#D4D4D8` / `oklch(87.20% 0.0055 286.32)`): emphasized borders (focus, featured states).
- **Text primary** (`#0A0A0A` / `oklch(14.48% 0 0)`): body and headings. Near-black, not pure black — gentler against bright surfaces, lower halation.
- **Text secondary** (`#52525B` / `oklch(43.86% 0.0145 285.94)`): supporting prose, captions.
- **Text tertiary** (`#A1A1AA` / `oklch(70.90% 0.0149 286.07)`): hints, placeholders, metadata.

### Dark theme

Token parity with the light palette. Names mirror the light tokens with a `dark-` prefix. Forest and Clay use the brand-approved dark variants (not synthetic lightening). Cross-checked against `docs/BRAND_GUIDELINES.md` §3.

- **Dark surface base** (`#0A0A0A` / `oklch(14.48% 0 0)`): page background. Near-black, intentionally — matches Material 3, Linear, Vercel, Tailwind `zinc-950`; reduces OLED smearing and halation.
- **Dark surface raised** (`#18181B` / `oklch(21.78% 0.006 285.88)`).
- **Dark surface sunken** (`#09090B` / `oklch(13.71% 0.0036 286.10)`).
- **Dark surface muted** (`#27272A` / `oklch(27.41% 0.0055 286.04)`): interactive row hover / `focus-within` highlight. Lifts clearly off the near-black base and stays distinct from dark surface raised (`#18181B`) so raised in-row chips (e.g. integration mechanism badges) remain legible on a hovered row. Shares the dark border-default value by design (a fill and a hairline border don't confuse).
- **Dark border default** (`#27272A`); **Dark border strong** (`#3F3F46`).
- **Dark text primary** (`#FAFAFA`); **Dark text secondary** (`#A1A1AA`); **Dark text tertiary** (`#71717A`).
- **Dark Forest** (`#5D916C` / `oklch(61% 0.0805 152.41)`): primary accent in dark theme. **Dark Forest hover** (`#6FAA80` / `oklch(68.5% 0.0867 152.69)`). Lifted in AECI-166 so accent text and links clear WCAG AA (≥4.5:1) on raised dark surfaces (`#18181B`), not just the near-black base.
- **Dark Clay** (`#F0A887` / `oklch(78.50% 0.1141 47.85)`): same usage restrictions as light Clay (brand policy, not contrast).
- **Dark Bone** (`#2A2520` / `oklch(22.42% 0.0079 67.38)`): warm-tinted dark accent surface.

### Named Rules

**The Surfaces-Are-Neutral Rule.** Brand colors are accents that layer on top of neutral surfaces. They are never the page background. Light theme `<body>` is `#FFFFFF`; dark theme `<body>` is `#0A0A0A`. Bone is *not* a page background — it is a warm-tinted accent surface used in callout bands and hero sections only.

**The Forest-Anchor Rule.** Forest is the primary brand accent and the anchor of the system. Every CTA, every link, every heading color, every primary badge fill: Forest in light theme, Dark Forest in dark theme. No alternative primary color exists — proposals for "a second primary" are rejected.

**The Clay-Restriction Rule.** Clay (and Dark Clay) is the rarest color in the system. ≤5% of any screen. Large-text (≥18pt regular or ≥14pt bold per WCAG) or graphical (icons, dividers, the connector mark) only. **Never as body text in either theme.** In light theme this is contrast-driven (Clay on white is ~2.4:1, fails AA). In dark theme it is brand policy: keeping Clay rare preserves its meaning as the high-emphasis accent.

**The No-Pure-Black-Or-White Rule.** `#000` and `#fff` never appear in this system. The text-primary token is `#0A0A0A` (light theme), the dark surface-base is `#0A0A0A`, the dark text-primary is `#FAFAFA`. Pure-black-on-pure-white is harsher than the near-tones and creates unnecessary halation.

**The Anchor-Site Rule.** When a surface uses a Mobbin reference site as its theme, components for that surface come from the *same* Mobbin site. Pulling components from a second site is a deliberate exception, not a default — and the originating theme site remains the visual anchor for composition, hierarchy, density, and atmosphere. This protects editorial coherence: AECi reads as one publication, not a mashup of unrelated apps. Record the anchor site with the surface (Linear issue or commit message) so future iterations stay aligned. Access Mobbin via the `mcp__mobbin__*` MCP server — see `CLAUDE.md` §"MCP usage rules" for auth flow and the matching design-checklist step.

## 3. Typography

**Display Font:** Source Serif 4 (with Georgia, "Times New Roman", serif fallback)
**Body Font:** Atkinson Hyperlegible (with system-ui, -apple-system, "Segoe UI", sans-serif fallback)
**Label Font:** Atkinson Hyperlegible (same family as body, distinct role via size + weight)

**Character:** Source Serif 4 carries the editorial / industry-publication posture of a printed reference — calmer and more grounded than the SaaS-default sans cohort, but without the stylized affectation of the reflex-reject serifs (Fraunces, Playfair Display, Cormorant, DM Serif, Instrument Serif). Atkinson Hyperlegible is an a11y-first sans designed by the Braille Institute for low-vision readers; pairing it with a serif display face makes the trust/transparency principle visible in the typography itself. The pairing is the brand statement: a system that treats the reader's vision as a constraint to engineer for, not an afterthought to "support."

### Hierarchy

- **Display** (Source Serif 4, 400, `clamp(2.25rem, 4.5vw + 1rem, 4rem)`, line-height 1.05, tracking -0.01em): hero headlines on About, Home, vendor profile mastheads. Used at most once per page.
- **Headline** (Source Serif 4, 600, `clamp(1.75rem, 2.5vw + 0.75rem, 2.5rem)`, line-height 1.15, tracking -0.005em): page H1 on content pages and product surfaces.
- **Title** (Source Serif 4, 600, 1.5rem / 24px, line-height 1.25): section H2 within long-form content; product surface card titles where editorial weight is wanted.
- **Body** (Atkinson Hyperlegible, 400, 1rem / 16px, line-height 1.6): default body and reading text. Cap measure at 70ch on long-form pages; product surfaces use container constraints instead. **Use 700 (Bold) only for inline emphasis or product-surface affordances** — never for headings (those are Source Serif 4).
- **Label** (Atkinson Hyperlegible, 700, 0.8125rem / 13px, line-height 1.4, tracking +0.01em): button text, table headers, status badges (verified / pending), form field labels. Sentence case (not uppercase — see the rule below). **Navigational taxonomy chips/tags use the same family and size at medium (500), not 700** — they are content links, not button affordances (see §5 → Tags / taxonomy chips).

### Named Rules

**The Sentence-Case Rule.** Headings, buttons, labels, navigation, table headers, page titles, section titles — all sentence case. Title Case reads as marketing copy; sentence case reads as editorial copy. This rule is absolute and applies to both registers.

**The Two-Family Rule.** Source Serif 4 for display, headline, title. Atkinson Hyperlegible for body and label. No third typeface enters the system. Monospace appears only when rendering literal code (in `<code>` and `<pre>`) and uses the system monospace stack — it is not a brand face.

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

> **Behavior providers (proposed — ADR 0010).** Component _behavior_ here is headless. **Spartan brain** (ADR 0005) covers the overlay primitives — buttons, popovers, dialogs. **Angular Aria** (`@angular/aria`, stable in v22) is the proposed provider for _new_ interactive and form-control patterns: select, combobox, listbox, radio, accordion, tree, grid, menu, toolbar, tabs. Both bind to the tokens below identically (Tailwind utilities targeting the `aria-*` attributes the directives toggle, both themes). The behavior provider is invisible to the visual system — the **Anchor-Site Rule** governs composition, hierarchy, density, and atmosphere, not which library supplies keyboard/ARIA logic, so two providers is not a mashup. See `docs/adr/0010-angular-aria-alongside-spartan.md`.

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
- **Background:** `surface-raised` (light) / `dark-surface-raised` (dark).
- **Shadow Strategy:** **None.** Borders separate surfaces. (See the Borders-Not-Shadows Rule above.)
- **Border:** 0.5px solid `border-default`. Hover (when interactive) raises to 1px solid `border-strong` — no fill change, no shadow, no scale.
- **Internal Padding:** `spacing.5` (24px). Dense list contexts may use `spacing.4` (16px).

### Entity cards (index rows)

The three index pages render their rows through dedicated per-entity components — `ProductCard`, `VendorCard`, `IntegrationCard` (Phase 2 Spec §11.2, in `apps/web/src/app/{products,vendors,integrations}/`). Despite the "card" name they render as **table rows**: each uses an attribute selector on `<tr>` (`tr[aec-product-card]`, `tr[aec-vendor-card]`, `tr[aec-integration-card]`) so the rendered DOM stays a valid `<tbody>` child — a custom element placed directly inside `<tbody>` is foster-parented out by the HTML tree builder (the same pattern Angular CDK uses for `tr[cdk-row]`). AECI-190 split the products catalog into two views: these `<tr>` components are the **table view** (shared by the `/products` table and the taxonomy browse-page tables), while a separate `ProductCardGrid` (below) is the **card-grid view** and the default for `/products`.

Shared behavior across all three:

- **Host:** `text-primary`; `hover` and `focus-within` raise the row fill to `surface-muted`. No shadow, no scale.
- **Cells:** `spacing.4` horizontal / `spacing.3` vertical padding. Numeric cells (counts, founded year) are `text-end` and `tabular-nums`. Linked cells shift to `accent-primary` on hover with a `focus-visible` ring.
- **Empty states:** a missing optional field renders an en-dash (`–`) in `text-tertiary` carrying an i18n-wrapped `aria-label` (`@@{entity}.card.{field}.none`) — never a bare blank, and color is never the sole signal.

The three variants differ only in cell content:

- **ProductCard** (`tr[aec-product-card]`) — a monogram (`LogoOrInitial`, 32px) beside the name (→ `/products/:slug`), vendor (→ `/vendors/:slug`; nullable per AECI-115), primary category as a `TaxonomyBadge` chip (→ `/categories/:slug`), and the integration count as an `IntegrationStat` (graceful "Not yet connected" at zero). AECI-190 folded this richer treatment in so the `/products` table view and the taxonomy browse-page tables share one row.
- **VendorCard** (`tr[aec-vendor-card]`) — company name (→ `/vendors/:slug`), headquarters, founded year, product count.
- **IntegrationCard** (`tr[aec-integration-card]`) — the `"{source} → {target}"` headline (→ `/integrations/:id`; integrations are keyed by id, not slug, per §6.5), a `mechanism_kind` badge (reusing the chip treatment from Tags / Taxonomy chips), and the direction label. The `→` glyph is `aria-hidden` and RTL-mirrored (`rtl:-scale-x-100`).

### Search & discovery (Phase 3)

The Phase 3 search surface (`/search`, the listing-page filters, and the header autocomplete) adds one page shell and several small headless-behavior components. Search itself runs **browser-side against Algolia** with the search-only key (Spec §7.5) — the admin key is never shipped (see the CSP / key handling note in §6). Every component renders correctly in both themes via tokens and i18n-wraps (or is passed) every visible string. Components live in `apps/web/src/app/search/` (search experience) and `apps/web/src/app/shared/facets/` (listing-page filters).

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

> **Deferred — per-tab sort dropdown (AECI-175 / ADR 0014).** Spec §4.6 lists a per-tab sort control, but no Algolia **replicas** exist yet, so a sort dropdown would have nothing to switch to. Phase 3 ships the §7.3 relevance default (`customRanking`) and marks the `connectSortBy` insertion point in `search-controller.ts`. The dropdown (a labelled, i18n'd, both-theme, axe-AA `<select>` or Aria listbox per tab) lands with the replicas in **AECI-175**. Recorded here so the design system matches the shipped surface.
### Product card grid (AECI-190)

`ProductCardGrid` (`aec-product-card-grid`, `apps/web/src/app/products/`) is the **default view** of `/products` — a buyer-facing catalog grid (anchor site: Faire). The table view above stays available via the toolbar toggle (`?view=table`). This is the card-grid variant the note above anticipated.

- **Layout:** responsive `grid` — 1 / 2 / 3 columns (`sm:grid-cols-2 lg:grid-cols-3`). The grid is deliberately *broken* (per the anti-reference against identical SaaS grids): the lead product gets a wide featured card spanning two columns on a warm **Bone** (`accent-warm`) band. The host enables the lead only on page 1 at the newest sort, so its "Recently added" eyebrow stays truthful; otherwise the grid is uniform.
- **Tile:** one whole-card `<a>` to `/products/:slug`, so category / role render as **non-link** chips (`CategoryChip` / `RoleBadge`, never the `<a>`-based `TaxonomyBadge` — nested anchors are invalid + an axe failure). Monogram (`LogoOrInitial`), name (Source Serif), vendor, and the integration count as an `IntegrationStat` badge. Borders not shadows; hover raises `border-default` → `border-strong`.

### Integration stat

`IntegrationStat` (`aec-integration-stat`) renders a product's `integration_count` as a deliberate metric — the directory's whole thesis is "which tools connect to what" — in three weights: `inline` (number over noun; table cells + grid), `badge` (a bordered pill with a Lucide "link" glyph), `headline` (a large Forest figure on the featured card). At zero it renders "Not yet connected" in `text-secondary`, never a bare `0`; it pluralizes the noun (1 → "integration"). The glyph is `aria-hidden` — the number + noun carry the meaning.

### Role + category chips

Two non-link chips for the card grid, sharing the Tags / Taxonomy-chip surface (bordered, `rounded.sm`, `text-secondary`):

- **RoleBadge** (`aec-role-badge`) — the product's `product_role`, shown **only** for `connector` / `hybrid`; the default `application` renders nothing, so the chip earns attention by appearing selectively.
- **CategoryChip** (`aec-category-chip`) — the primary category as plain styled text (not a link), for contexts where the whole card is already a link.

### Inputs / Fields

Native inputs driven by Signal Forms today (ADR 0009); richer controls (select, combobox, radio) use Angular Aria per the proposed provider note above (ADR 0010). Styling binds to tokens.

- **Style:** 1px solid `border-default`, `surface-base` background, `rounded.md` corner. Padding `spacing.3 spacing.4` (12px / 16px). Body typography role.
- **Focus:** border shifts to 1px solid `accent-primary`, paired with the focus-ring elevation. No glow halo, no underline animation — clean border swap.
- **Error:** border shifts to 1px solid Clay-derived warning token (TBD as an extension on first error pattern); accompanied by an inline label and an icon (color is never the sole error signal).
- **Disabled:** background fades to `surface-sunken`, text-secondary text. Pointer events disabled.

### Badges

- **Verified** (`badge-verified`): Forest fill, surface-base text, `rounded.sm`, label typography. Reserved for vendor-verified integrations and other editorially-confirmed states.
- **Pending** (`badge-pending`): surface-sunken fill, text-secondary text, 0.5px border-default. Indicates "submitted, not yet reviewed" — never confused with verified.

### Tags / Taxonomy chips

Chip-style links to category / audience / phase browse pages (the `TaxonomyBadge` component). Distinct from the status badges above — these are navigational, not state indicators.

- **Surface:** `surface-raised` fill, 0.5px solid `border-default` raising to 1px `border-strong` on hover. `rounded.sm` (4px) — chips, not pills (the pill shape is reserved for vendor-verified badges).
- **Typography:** Atkinson Hyperlegible **medium (500)**, 0.8125rem / 13px, tracking +0.01em. Deliberately lighter than the `label` role (700): the chip reads as a content tag, not a button. `text-primary` shifts to `accent-primary` on hover.
- **Case:** sentence case, per the Sentence-Case Rule.

### Score Display

The signature data component for review scores. Source Serif 4 numerals (headline typography role) in Forest, no chart-junk decoration, no sparkline behind the number — the score *is* the visual.

- **Numeric value:** Source Serif 4 600, headline scale (`clamp(1.75rem, 2.5vw + 0.75rem, 2.5rem)`), Forest color (`accent-primary`).
- **Label below:** Atkinson Hyperlegible label scale, text-secondary color.
- **Range marker** (optional, sparse): a single vertical mark on a 1-10 axis with no fill, no gradient, no animation — visible at a glance, not a chart.

### Navigation

- **Style:** Atkinson Hyperlegible label scale, sentence case, text-primary color, transparent background.
- **Default → hover:** color shifts to `accent-primary`. No underline-on-hover for top-level nav (reserved for inline body links).
- **Active route:** color = `accent-primary`, paired with a 2px bottom border in `accent-primary` for primary nav. Border on the *element*, not as a side stripe (forbidden — see Do's and Don'ts).
- **Mobile:** collapses into a CDK-overlay dropdown with focus trap. No hamburger-as-mystery — the toggle is labeled.

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

- **IndexLayout** (`<aec-index-layout>`) — for sortable, paginated table listings.
  - **Slots:** `header` (required), `table-header` (rendered into `<thead>`), `table-body` (rendered into `<tbody>`), `pagination`.
  - **Table:** semantic `<table>` with `min-w-[40rem]`; wrapped in a horizontally scrollable container on phones. Row dividers from `border-default`. Header typography uses the `label` role in uppercase.
  - **Pagination:** bordered above, flex row with summary copy left + button group right.

Every visible string and every ARIA label is i18n-wrapped (`@@app.layouts.{detail|browse|index}.{slot}.aria`). Concrete pages add their own i18n keys for projected content.

> **`EntityTable` (§11.2) — subsumed into `IndexLayout`, not a standalone component.** The Phase 2 spec listed a generic sortable / paginated `EntityTable` primitive. In implementation its entire responsibility — the semantic `<table>`, the horizontally-scrollable container, and the `table-header` / `table-body` / `pagination` slots — lives in **`IndexLayout`**, composed with the per-entity row components above (`{Product,Vendor,Integration}Card`). No separate `EntityTable` class ships. This is recorded so the spec's component list reconciles with the codebase; if a non-index table consumer ever needs the table shell independently, that is the moment to extract `EntityTable`.

## 6. Do's and Don'ts

The strategic anti-references in `PRODUCT.md` carry through here as concrete visual prohibitions. Every PRODUCT.md anti-reference appears below as a "Don't" with the same language.

### Do:

- **Do** use OKLCH in CSS (`oklch(...)`) for color tokens. Hex values are documented as fallbacks but the canonical source is OKLCH (the front matter, plus `apps/web/src/styles.css`).
- **Do** pair Source Serif 4 (display) with Atkinson Hyperlegible (body) — the chosen system pair. Use them in their assigned roles (display for headings, body for prose, label for buttons / badges / table headers).
- **Do** use sentence case everywhere. Headings, buttons, labels, navigation, table headers, page titles, section titles.
- **Do** use 0.5px borders to separate surfaces (`border-default`); 1px for emphasis; 2px for featured states.
- **Do** keep Clay rare (≤5% per screen, large-text or graphical only). The connector mark, verified/featured badges, primary CTA fills where appropriate.
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
- **Don't** use `#000` or `#fff` directly. Use `text-primary` (`#0A0A0A`) and `surface-base` (`#FFFFFF` for light, `#0A0A0A` for dark) tokens.
- **Don't** use bounce or elastic easing on motion. Use exponential ease-out (`ease-out-quart` / `quint` / `expo`). Real objects decelerate smoothly.
- **Don't** use glassmorphism (blur, glass cards, glow borders) decoratively. Rare and purposeful, or nothing.
- **Don't** put box-shadows on cards or buttons. Borders separate surfaces; shadows are for modals, dropdowns, popovers, and focus rings.
- **Don't** use the AI color palette: cyan-on-dark, purple-to-blue gradients, neon accents on dark backgrounds, gradient backgrounds for impact.
- **Don't** use stock photography of construction sites, hard hats, or blueprints. The AEC visual cliché — the brand is editorial about AEC, not a costume of AEC.
- **Don't** use emoji in UI chrome. Lucide icons exclusively. Emoji rendering is inconsistent across platforms and clashes with the editorial brand.
- **Don't** use em dashes in UI copy (also not `--`). Use commas, colons, semicolons, periods, or parentheses.
- **Don't** make every button primary. Use ghost and secondary variants — hierarchy matters.
- **Don't** use modals as the first thought. Exhaust inline / progressive disclosure / drawer alternatives first.
