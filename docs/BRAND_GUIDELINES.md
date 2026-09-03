# AEC Integrations — Brand Guidelines

**Version:** 1.0
**Date:** May 2026
**Status:** Canonical
**Source:** `docs/STAGE_1_SPEC.md` §2a.2–§2a.4, version 1.7, May 2026

This is the canonical brand guide for AEC Integrations. The Markdown here is the editable source; the DOCX export at `branding/AEC-Integrations-Brand-Guidelines.docx` is generated from this file for stakeholders who need a portable artifact. If the two diverge, this file wins.

For implementation-level tokens (CSS custom properties, Tailwind config, the theming model), see `docs/STAGE_1_SPEC.md` §2a.

---

## 1. Surfaces are neutral

The site uses neutral surfaces in the light theme. Brand colors are accents that layer on top — they are never the page background.

| Theme | Page background | Raised (cards/panels) | Sunken (insets) | Muted (row hover) |
|---|---|---|---|---|
| Light | `#FFFFFF` | `#FAFAFA` | `#F4F4F5` | `#F4F4F5` |
| Dark | `#0A0A0A` | `#18181B` | `#09090B` | `#27272A` |

*Muted* is the interactive row hover / `focus-within` surface on index tables. Its value intentionally coincides with sunken in light and border-default in dark — see `DESIGN.md` §2 for the rationale.

Near-black `#0A0A0A` (rather than pure `#000000`) is intentional in dark mode: matches Material 3, Apple HIG, Linear, Vercel, and Tailwind's `zinc-950`; reduces OLED smearing during scroll; lowers halation against bright text. No accessibility standard requires pure black.

---

## 2. Brand colors — light theme

| Color | Hex | Role |
|---|---|---|
| Forest | `#1E3A2F` | Primary brand. CTAs, links, headings, primary accent. |
| Forest hover | `#2E5C45` | Hover state for Forest interactive elements. |
| Clay | `#E89668` | Decorative/fill only (badge fills carry near-black text, never white). **Cannot carry text or meaning-bearing graphics** — see §5. |
| Clay deep | `#A14D22` | Text-capable Clay (AECI-230): clay-colored text and icons. 5.83:1 on white. Doubles as the warning hue. |
| Goldenrod | `#DAA520` | Gold-star fill for rating glyphs (`--accent-rating`). Decorative (`aria-hidden`) — the rating value is carried by the numeral + `aria-label` — so its ~2.2:1 on white is permitted; empty stars use Border strong `#D4D4D8` in displays, Text tertiary `#71717A` in the interactive review-form picker. See §5.1. |
| Bone | `#F5F2EA` | Warm-tinted accent surface (callout sections, marketing hero bands, About page hero). **Not a page background** — see §4. |

---

## 3. Brand colors — dark theme

> **Not shipped.** The dark theme was removed in **AECI-226** (the launch site is light-only — see `STAGE_1_SPEC.md` §2a.1), and the Stage 2 reintroduction was later **dropped** (epic AECI-517 canceled; `STAGE_2_SPEC.md` §9) — dark is **not roadmapped**. These variants stay documented here as approved brand assets should a later stage ever revisit dark — they are brand policy, not an active surface.

The dark theme uses lighter variants of Forest and Clay because the originals lack contrast against near-black surfaces. These are **approved brand variants**, not ad-hoc lightening — use these exact hexes.

| Color | Hex | Role |
|---|---|---|
| Forest dark | `#5D916C` | Primary brand in dark theme. CTAs, links. |
| Forest dark hover | `#6FAA80` | Hover state for Forest-dark interactive elements. |
| Clay dark | `#F0A887` | Highlights, badges, callouts. **Large text or graphical only** — see §5. |
| Bone dark | `#2A2520` | Warm-tinted accent surface (dark equivalent of Bone). Used the same way Bone is used in light theme. |

---

## 4. Bone is an accent surface, not a background

Bone was historically treated as "the page background." It is now reclassified as a **warm-tinted accent surface**. It still appears in:

- Marketing pages (selectively, as callout bands)
- About page hero
- Home page hero band
- Callout sections that benefit from warmth and brand presence

It does **not** appear as the default `<body>` background in either theme. The page background is neutral (white in light, near-black in dark). This change keeps the brand identity present via accents while letting the product UI feel modern and editorial rather than tinted.

---

## 5. Clay restriction

Clay is the rarest color in the system. Use it sparingly — the connector mark, "verified" or "featured" badge fills, and high-emphasis highlights. If Clay appears in more than ~5% of any given screen, it's losing its meaning. (Clay never fills a CTA — every CTA is Forest, per DESIGN.md's Forest-Anchor Rule.)

**Clay `#E89668` cannot carry text or meaning-bearing graphics — in any size.**

- This is stricter than the previous "large text allowed" wording, which was mathematically false and was struck in **AECI-230**: Clay on white measures ~2.3:1, below WCAG 2.1 AA for body text (4.5:1) *and* below the 3:1 floor for large text and non-text UI components (WCAG 1.4.11).
- Permitted Clay `#E89668` uses: decorative graphics (the connector mark, accent strokes) and fills that carry near-black `text-primary` on top (8.48:1). White text on Clay (2.33:1) is forbidden.
- Anything clay-colored that carries meaning — text, icons — uses **Clay deep `#A14D22`** (5.83:1 on white, 5.21:1 on Bone), added in AECI-230. (Star ratings are not clay — see §5.1.)
- In a **dark theme** (not currently roadmapped — see §3), Clay dark `#F0A887` on `#0A0A0A` is ~10.3:1 and technically passes AAA. The restriction there is **brand policy, not contrast** — keeping Clay rare preserves its meaning as a high-emphasis accent.

See `docs/STAGE_1_SPEC.md` §2a.4 for the contrast-validation rule this maps to.

---

## 5.1 Rating gold (Goldenrod)

Star-rating glyphs use **Goldenrod `#DAA520`** (`--accent-rating`), the conventional gold star, tuned warm to sit with the Clay/Bone family rather than a neon yellow. In read-only displays (`<aec-review-stars>`, vendor-detail), empty stars use **Border strong `#D4D4D8`** as a faint track so the gold reads against it. The **interactive review-form rating picker** instead uses **Text tertiary `#71717A`** for unselected stars: it has no adjacent numeral and renders fully unselected on first load, so a faint `#D4D4D8` track would leave the whole control near-invisible until hovered.

- Goldenrod measures ~2.2:1 on white — *below* the 3:1 floor for meaning-bearing graphics. This is permitted **only because the star glyphs are decorative** (`aria-hidden`): the precise rating is announced via the `aria-label` and shown as the adjacent numeral, so color is never the sole signal — the same allowance the empty-star track relies on.
- Goldenrod is **rating glyphs only**. It is not a text, icon, CTA, or general-accent color. Meaning-bearing clay stays Clay deep; CTAs stay Forest.

---

## 6. Verified contrast ratios

Computed against the spec's surface tokens. WCAG 2.1 AA requires 4.5:1 for normal text, 3:1 for large text and non-text UI components.

| Foreground | Background | Ratio | Verdict |
|---|---|---|---|
| Forest `#1E3A2F` | White `#FFFFFF` | ~12.0 : 1 | AAA |
| Forest hover `#2E5C45` | White `#FFFFFF` | ~7.7 : 1 | AAA |
| Clay `#E89668` | White `#FFFFFF` | ~2.3 : 1 | Fails AA body **and** the 3:1 large-text/non-text floor — **decorative/fill only** (AECI-230) |
| Near-black `#0A0A0A` | Clay `#E89668` | ~8.5 : 1 | AAA — the only sanctioned text-on-Clay pairing |
| Clay deep `#A14D22` | White `#FFFFFF` | ~5.8 : 1 | AA normal (text-capable Clay, AECI-230) |
| Clay deep `#A14D22` | Bone `#F5F2EA` | ~5.2 : 1 | AA normal |
| Goldenrod `#DAA520` | White `#FFFFFF` | ~2.2 : 1 | Below the 3:1 graphic floor — **decorative star glyphs only** (`aria-hidden`; value carried by numeral + `aria-label`). See §5.1 |
| Text tertiary `#71717A` | White `#FFFFFF` | ~4.8 : 1 | AA normal (re-pointed from `#A1A1AA` ≈ 2.6:1, AECI-230) |
| Forest `#1E3A2F` | Forest soft `#ECF1EE` | ~10.8 : 1 | AAA (selected/active wash, AECI-230) |
| Error `#B3261E` | White `#FFFFFF` | ~6.5 : 1 | AA normal (status token, AECI-230) |
| Ink `#0F1419` | Bone `#F5F2EA` | ~17 : 1 | AAA (Bone accent surface) |
| Forest dark `#5D916C` | Near-black `#0A0A0A` | ~5.4 : 1 | AA normal, AAA large |
| Forest dark `#5D916C` | Raised dark `#18181B` | ~4.8 : 1 | AA normal — binding case for links (AECI-166) |
| Forest dark hover `#6FAA80` | Near-black `#0A0A0A` | ~7.3 : 1 | AAA large, AA normal |
| Clay dark `#F0A887` | Near-black `#0A0A0A` | ~10.3 : 1 | Passes AAA (brand policy still restricts use) |
| White `#FAFAFA` | Bone dark `#2A2520` | ~15.8 : 1 | AAA |

Contrast verification is automated in CI via a token-pair check matrix (see `docs/STAGE_1_SPEC.md` §2a.4). These numbers are the expected values — drift from them in either direction warrants review.

---

## 7. Visual principles

A small set of cross-cutting principles. Component-level implementation lives in the Angular + Spartan UI component library, not here.

- **Sentence case everywhere.** Headings, buttons, labels, navigation items, table headers. Title Case reads as marketing; sentence case reads as editorial. The one named exception is the overline role (eyebrows, kickers, sidebar microheadings — `DESIGN.md` §3, AECI-230), uppercase via CSS only.
- **Typography: Source Serif 4 (display) + Atkinson Hyperlegible Next (body and label).** Source Serif 4 is the editorial / industry-publication anchor — used for display, headline, and title roles (weights 400 and 600). Atkinson Hyperlegible Next is the a11y-first body face (Braille Institute) — used for body prose, labels, overlines, and captions (variable 400–700; AECI-230 upgraded from the classic two-weight cut so the system's 500/600 roles render as real cuts). The pairing makes the trust/transparency principle visible in the typography itself. The full type scale, role definitions, and named rules live in `DESIGN.md` §3 (source of truth). The previous Inter-only / 400-and-500-only doctrine was retired in May 2026; the rationale is documented in §7a below.
- **Borders separate surfaces; shadows don't.** Default border `0.5px`; `1px` for emphasis (inputs, focused elements); `2px` reserved for featured states. Box-shadows are for modals, dropdowns, and focus rings only — never on cards or buttons.
- **Motion has a purpose.** Animate for feedback, transition, or focus. Decorative animation is noise. Default durations: 120ms (hover), 180ms (default), 280ms (page transitions).
- **No pure black for text.** Use Ink `#0F1419` (light theme) or the theme's `--text-primary` token. Pure black plus pure white is harsher than the near-black/near-white pairings the design system already provides.
- **No emoji in UI chrome.** Use Lucide icons exclusively. Emoji rendering is inconsistent across platforms and clashes with the editorial brand.
- **No stock photography of construction sites, hard hats, or blueprints.** The AEC software visual cliché. The brand is editorial — diagrams, screenshots, and original photography only.
- **No pay-for-placement visual tells.** Featured/verified badges follow product rules (`docs/STAGE_1_SPEC.md`), not vendor spend.

---

## 7a. Why the typography doctrine changed (May 2026)

Versions 1.0 of this brand book pinned a single sans-serif typeface (Inter) at two weights (400 / 500) with an explicit "no serif fonts anywhere" clause. AECI-38 (Phase 1.12a, May 2026) installed the Impeccable design skill (`pbakaus/impeccable`) and seeded `PRODUCT.md` and `DESIGN.md` at the repo root. Impeccable's `font-selection-procedure` explicitly rejects Inter as a reflex / training-data default that creates monoculture across projects (alongside DM Sans, Plus Jakarta Sans, Geist, Mona Sans, Space Grotesk, IBM Plex Sans, Outfit, Fraunces, Newsreader, Playfair Display, Cormorant, DM Serif, Instrument Serif, Syne).

DESIGN.md is the source of truth for tokens going forward. When DESIGN.md and this book disagree on tokens, DESIGN.md wins and this book updates to match. The chosen pairing reflects the editorial / industry-publication aesthetic (a serif display face borrows posture from `ENR` and `Architectural Record`; an a11y-first body face makes the Transparent-by-default design principle visible). The two-weights-per-face cap is replaced with role-bound weights (display 400, headline 600, title 600, body 400, label 700) defined in DESIGN.md §3.

The previous "no serif fonts anywhere" clause is rescinded for a *single* serif display face used in display / headline / title roles. Body text remains sans (Atkinson Hyperlegible). Monospace appears only in literal code (`<code>`, `<pre>`) using the system monospace stack — it is not a brand face.

---

## 8. Related artifacts

- **Visual design system & component tokens (source of truth):** `DESIGN.md` at the repo root. Stitch-format YAML front matter for colors (OKLCH + hex), typography, spacing, radii, components; markdown body with the six fixed sections. When implementation drifts, DESIGN.md wins.
- **Strategic product context:** `PRODUCT.md` at the repo root. Audience tiers, jobs-to-be-done, brand personality, anti-references, design principles, accessibility commitments. Loaded by every Impeccable command before design work.
- **Implementation tokens & theme mechanics:** `docs/STAGE_1_SPEC.md` §2a (cross-references DESIGN.md; identical hex values).
- **DOCX export of this document:** `branding/AEC-Integrations-Brand-Guidelines.docx` (regenerate via `scripts/build-brand-docx.sh`).
- **Figma design system file:** "AEC Integrations — Design System" (color styles, text styles, components). Tokens in Figma mirror Tailwind config; changes in either system require updates to both.
- **Logo and monogram files:** `branding/` directory.
- **Home OpenGraph share card:** `apps/web/public/branding/home-og.png` — a rendered **1200×630** light-editorial card (white surface, Forest accent, the primary wordmark + the canonical positioning one-liner), served at `/branding/home-og.png` and used as the home's `og:image` (AECI-276). It is **evergreen** (no live numbers). Edit the source at `apps/web/scripts/home-og-template.html` and regenerate the PNG with `pnpm --filter @aeci/web og:home` (a manual Playwright-render dev tool; commit the new PNG). Per-entity OG images still fall back to the monogram.
