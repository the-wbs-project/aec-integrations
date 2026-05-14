# AEC Integrations — Brand Guidelines

**Version:** 1.0
**Date:** May 2026
**Status:** Canonical
**Source:** `docs/STAGE_1_SPEC.md` §2a.2–§2a.4, version 1.7, May 2026

This is the canonical brand guide for AEC Integrations. The Markdown here is the editable source; the DOCX export at `branding/AEC-Integrations-Brand-Guidelines.docx` is generated from this file for stakeholders who need a portable artifact. If the two diverge, this file wins.

For implementation-level tokens (CSS custom properties, Tailwind config, theme switching mechanics), see `docs/STAGE_1_SPEC.md` §2a.

---

## 1. Surfaces are neutral

The site uses neutral surfaces in both themes. Brand colors are accents that layer on top — they are never the page background.

| Theme | Page background | Raised (cards/panels) | Sunken (insets) |
|---|---|---|---|
| Light | `#FFFFFF` | `#FAFAFA` | `#F4F4F5` |
| Dark | `#0A0A0A` | `#18181B` | `#09090B` |

Near-black `#0A0A0A` (rather than pure `#000000`) is intentional in dark mode: matches Material 3, Apple HIG, Linear, Vercel, and Tailwind's `zinc-950`; reduces OLED smearing during scroll; lowers halation against bright text. No accessibility standard requires pure black.

---

## 2. Brand colors — light theme

| Color | Hex | Role |
|---|---|---|
| Forest | `#1E3A2F` | Primary brand. CTAs, links, headings, primary accent. |
| Forest hover | `#2E5C45` | Hover state for Forest interactive elements. |
| Clay | `#E89668` | Highlights, badges, callouts. **Large text or graphical only** — see §5. |
| Bone | `#F5F2EA` | Warm-tinted accent surface (callout sections, marketing hero bands, About page hero). **Not a page background** — see §4. |

---

## 3. Brand colors — dark theme

The dark theme uses lighter variants of Forest and Clay because the originals lack contrast against near-black surfaces. These are **approved brand variants**, not ad-hoc lightening — use these exact hexes.

| Color | Hex | Role |
|---|---|---|
| Forest dark | `#4A8870` | Primary brand in dark theme. CTAs, links. |
| Forest dark hover | `#5DA088` | Hover state for Forest-dark interactive elements. |
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

Clay is the rarest color in the system. Use it sparingly — the connector mark, primary CTAs, "verified" or "featured" markers, and high-emphasis highlights. If Clay appears in more than ~5% of any given screen, it's losing its meaning.

**Clay is not allowed for body text in either theme.**

- In **light theme**, this is a contrast rule: Clay `#E89668` on white `#FFFFFF` is ~2.4:1, which fails WCAG 2.1 AA (4.5:1 minimum for normal body text).
- In **dark theme**, Clay dark `#F0A887` on `#0A0A0A` is ~10.3:1 and technically passes AAA. The restriction in dark theme is **brand policy, not contrast** — keeping Clay rare preserves its meaning as a high-emphasis accent.

Permitted Clay uses in both themes: badges, large text (≥18pt regular or ≥14pt bold per WCAG), graphical elements (icons, dividers, the connector mark), and small accent strokes. See `docs/STAGE_1_SPEC.md` §2a.4 for the contrast-validation rule this maps to.

---

## 6. Verified contrast ratios

Computed against the spec's surface tokens. WCAG 2.1 AA requires 4.5:1 for normal text, 3:1 for large text and non-text UI components.

| Foreground | Background | Ratio | Verdict |
|---|---|---|---|
| Forest `#1E3A2F` | White `#FFFFFF` | ~12.0 : 1 | AAA |
| Forest hover `#2E5C45` | White `#FFFFFF` | ~7.7 : 1 | AAA |
| Clay `#E89668` | White `#FFFFFF` | ~2.4 : 1 | Fails AA body — **large/graphical only** |
| Ink `#0F1419` | Bone `#F5F2EA` | ~17 : 1 | AAA (Bone accent surface) |
| Forest dark `#4A8870` | Near-black `#0A0A0A` | ~5.1 : 1 | AA normal, AAA large |
| Forest dark hover `#5DA088` | Near-black `#0A0A0A` | ~6.6 : 1 | AAA large, AA normal |
| Clay dark `#F0A887` | Near-black `#0A0A0A` | ~10.3 : 1 | Passes AAA (brand policy still restricts use) |
| White `#FAFAFA` | Bone dark `#2A2520` | ~15.8 : 1 | AAA |

Contrast verification is automated in CI via a token-pair check matrix (see `docs/STAGE_1_SPEC.md` §2a.4). These numbers are the expected values — drift from them in either direction warrants review.

---

## 7. Visual principles

A small set of cross-cutting principles. Component-level implementation lives in the Angular + Spartan UI component library, not here.

- **Sentence case everywhere.** Headings, buttons, labels, navigation items, table headers. Title Case reads as marketing; sentence case reads as editorial.
- **Two font weights only: 400 (regular) and 500 (medium).** Never 600, 700, or 800. Inter at 600+ reads heavy and over-designed against the rest of the system.
- **Borders separate surfaces; shadows don't.** Default border `0.5px`; `1px` for emphasis (inputs, focused elements); `2px` reserved for featured states. Box-shadows are for modals, dropdowns, and focus rings only — never on cards or buttons.
- **Motion has a purpose.** Animate for feedback, transition, or focus. Decorative animation is noise. Default durations: 120ms (hover), 180ms (default), 280ms (page transitions).
- **No pure black for text.** Use Ink `#0F1419` (light theme) or the theme's `--text-primary` token. Pure black plus pure white is harsher than the near-black/near-white pairings the design system already provides.
- **No emoji in UI chrome.** Use Lucide icons exclusively. Emoji rendering is inconsistent across platforms and clashes with the editorial brand.
- **No stock photography of construction sites, hard hats, or blueprints.** The AEC software visual cliché. The brand is editorial — diagrams, screenshots, and original photography only.
- **No pay-for-placement visual tells.** Featured/verified badges follow product rules (`docs/STAGE_1_SPEC.md`), not vendor spend.

---

## 8. Related artifacts

- **Implementation tokens & theme mechanics:** `docs/STAGE_1_SPEC.md` §2a (source of truth).
- **DOCX export of this document:** `branding/AEC-Integrations-Brand-Guidelines.docx` (regenerate via `scripts/build-brand-docx.sh`).
- **Figma design system file:** "AEC Integrations — Design System" (color styles, text styles, components). Tokens in Figma mirror Tailwind config; changes in either system require updates to both.
- **Logo and monogram files:** `branding/` directory.
