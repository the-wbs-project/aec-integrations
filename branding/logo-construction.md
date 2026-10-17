# AEC Integrations — Logo Construction Guide

This is the technical companion to the brand guidelines. The brand guidelines cover _when and where_ to use the logo. This document covers _how to build it_ — exact coordinates, type specs, color values, and the geometry of the connector mark. If the source SVG files are ever lost, corrupted, or need to be rebuilt in a different tool, this document is the source of truth.

Every variant of the logo is constructed from one of four primitives: the **wordmark**, the **monogram**, the **lockup**, or the **stacked logo**. All four share the same color tokens and the same italic "i" rule. The stacked logo is the one exception to the connector geometry; see its section. Once you understand the wordmark, the rest follows.

---

## Color tokens

Only three colors appear in any logo variant. Clay is the only color that does not flip between light and dark modes — it is the constant that anchors the brand across every context.

| Token  | Hex       | Role                                                                                        |
| ------ | --------- | ------------------------------------------------------------------------------------------- |
| Forest | `#1E3A2F` | Text and tile fill on light backgrounds; tile background on dark backgrounds becomes Bone   |
| Bone   | `#F5F2EA` | Text and tile fill on dark backgrounds; tile background on light backgrounds becomes Forest |
| Clay   | `#E89668` | Connector mark and italic "i" — never changes regardless of background                      |

Stone, Ink, and Paper from the broader brand palette do **not** appear in the logo. They are reserved for UI surfaces and body text.

---

## The wordmark

The wordmark is the primary brand mark. It consists of three elements rendered in a single horizontal line: the word "AEC" in semibold, a connector mark (two dots joined by a line), and the word "Integrations" in light weight. All three elements share the same baseline.

### Type specifications

| Property                 | Value                                             |
| ------------------------ | ------------------------------------------------- |
| Typeface                 | Atkinson Hyperlegible Next, outlined (see below)  |
| `AEC` weight             | 600 (semibold)                                    |
| `AEC` font-size          | 22                                                |
| `Integrations` weight    | 300 (light)                                       |
| `Integrations` font-size | 22                                                |
| Letter-spacing           | -0.3                                              |
| Text fill (light bg)     | `#1E3A2F` (Forest)                                |
| Text fill (dark bg)      | `#F5F2EA` (Bone)                                  |
| Connector color          | `#E89668` (Clay) — never changes                  |
| Connector stroke-width   | 1.5                                               |
| Connector dot radius     | 2.5                                               |
| Connector y-position     | 7px above text baseline (visual midpoint of caps) |

### Connector geometry

The connector consists of two clay-colored dots joined by a clay line, set at the visual midpoint of the capital letters. The gap between the C and the first dot is 7 units; the gap between the second dot and the I is also 7 units. This symmetric spacing keeps the connector balanced between the two words — neither word claims it.

The 7-unit gaps are measured between **ink** edges: the right edge of the C as drawn, and the left edge of the I as drawn. They are not measured from a path's origin. The `AEC` outline starts 0.16 units right of its translate, and the `Integrations` outline starts 1.235 units right of its translate.

All coordinates below are relative to the `AEC` path translate `x`. They are measured from the Atkinson outlines, not estimated from font metrics. To shift the wordmark on a canvas, change `x`; every other coordinate follows.

| Element                               | Coordinate      |
| ------------------------------------- | --------------- |
| `AEC` path translate                  | `x`             |
| `AEC` ink left edge (A)               | `x + 0.16`      |
| `AEC` ink right edge (C)              | `x + 40.34`     |
| First dot centre                      | `x + 49.84`     |
| First dot right edge                  | `x + 52.34`     |
| Line (a 1.5-high `<rect>`)            | `x + 53.34` to `x + 60.34` |
| Second dot left edge                  | `x + 61.34`     |
| Second dot centre                     | `x + 63.84`     |
| Second dot right edge                 | `x + 66.34`     |
| `Integrations` path translate         | `x + 72.11`     |
| `Integrations` ink left edge (I)      | `x + 73.34`     |
| `Integrations` ink right edge         | `x + 182.17`    |
| Gap C → first dot                     | `7`             |
| Gap second dot → I                    | `7`             |

### The wordmark is outlined type

Since 2026-10-17 every wordmark file carries the letters as `<path>` outlines, not `<text>`. The header file `apps/web/public/branding/wordmark.svg` went first. The `branding/` family followed the same day: `wordmark-light.svg`, `wordmark-dark.svg` and the six `primary-logo*.svg` files, with their PNG exports and `email-logo-banner.png`. Live text drew the mark in the viewer's system font (SF Pro on a Mac, Segoe UI on Windows), so every letter width, and therefore every connector gap, changed with the operating system. On a Mac the old files measured 10.9 and 6.5 instead of 7 and 7. Outlines render identically everywhere.

The outlines come from **Atkinson Hyperlegible Next**, the site's body font, licensed under the SIL Open Font License 1.1, which permits embedding its glyph outlines in a logo. The system fonts do not: Apple's SF Pro licence and Microsoft's Segoe UI licence forbid redistributing their letterforms, so never outline a system-font wordmark and ship it.

Outlining recipe (fontTools + HarfBuzz, so kerning is applied):

1. Download `AtkinsonHyperlegibleNext[wght].ttf` from `google/fonts` (`ofl/atkinsonhyperlegiblenext/`).
2. Instance the variable font at `wght` 600 for `AEC` and 300 for `Integrations`.
3. Shape each word with HarfBuzz at 22 units, advancing each glyph by its advance plus the -0.3 letter-spacing, and draw each glyph through an `SVGPathPen`, y flipped. Round path numbers to 2 decimals.
4. Place `AEC` at `(10, 47)`. Measure the ink extents and set the connector from them: first dot centre = C ink right + 7 + 2.5, line start = dot centre + 3.5, line 7 long, second dot centre = line end + 3.5, `Integrations` ink left = second dot centre + 2.5 + 7.
5. Set the canvas. The full canvas is `0 0 280 80`. A trimmed viewBox is `3 25 W 30`: it starts 7 left of the `AEC` translate, spans y 25 to 55, and `W` = Integrations ink right + 7 - 3. For the header file, set the `<img>` `width` attribute in `brand-logo.ts` to the same `W`.

Every file in the family uses the same letter and connector coordinates. Measured (SVG units):

| Element                                | Coordinate |
| -------------------------------------- | ---------- |
| `AEC` path translate                   | `10, 47`   |
| `AEC` ink right edge                   | `50.34`    |
| First dot centre                       | `59.84, 40` |
| Line (a 1.5-high `<rect>`, y 39.25)    | `63.34` to `70.34` |
| Second dot centre                      | `73.84, 40` |
| `Integrations` path translate          | `82.11, 47` |
| `Integrations` ink left edge           | `83.34`    |
| `Integrations` ink right edge          | `192.17`   |
| Trimmed viewBox                        | `3 25 196 30` |
| Gap C → first dot / second dot → I     | `7` / `7`  |

The line is a `<rect>` rather than a `<line>` so the whole clay group is fills only. Verify any rebuild by rendering the file at 10x and scanning ink columns; the gaps must measure 7.0 on both sides.

The files differ only in canvas, field and type colour:

| File                                    | viewBox         | Size attribute | Field  | Type   | PNG export |
| --------------------------------------- | --------------- | -------------- | ------ | ------ | ---------- |
| `wordmark-light.svg`, `primary-logo.svg` | `0 0 280 80`   | none / 1120x320 | Bone  | Forest | 1120x320   |
| `wordmark-dark.svg`, `primary-logo-dark.svg` | `0 0 280 80` | none / 1120x320 | Forest | Bone | 1120x320   |
| `primary-logo-transparent.svg`          | `0 0 280 80`    | 1120x320       | none   | Forest | 1120x320, alpha |
| `primary-logo-trimmed.svg`              | `3 25 196 30`   | 679x104        | Bone   | Forest | 679x104    |
| `primary-logo-dark-trimmed.svg`         | `3 25 196 30`   | 679x104        | Forest | Bone   | 679x104    |
| `primary-logo-transparent-trimmed.svg`  | `3 25 196 30`   | 679x104        | none   | Forest | 679x104, alpha |
| `email-logo-banner.png` (no SVG file)   | `-15.9 14.05 336 54.6` | 1120x182 | none | Bone | 1120x182, alpha |

Each PNG is its SVG rendered at the PNG size in the table, so the full-canvas exports are 4 px per unit. The trimmed PNGs were 770x104 while the system-font mark was wider. They are now 679x104, so the 104 px height and the 7-unit padding both hold. `email-logo-banner.png` has no SVG of its own. It is the trimmed-family geometry in Bone with no field, rendered at 10/3 px per unit. Its viewBox is measured from the old banner: the same scale, `AEC` starting at the same pixel, and the connector on the same row (y 86.5 px). See "`email-logo-banner.png` is a published asset now" below for the rules on that file.

The stacked logo, the monogram, the lockup and the OpenGraph cards are covered in their own sections.

### Vertical alignment

The connector sits at the visual midpoint of the capital letters, not the geometric midpoint of the line. For 22pt type with a baseline at y, the connector y-position is `y - 7`. This places the dots roughly aligned with the horizontal stroke of the E in AEC, which is the visual reference the eye locks onto.

- 22pt type, baseline `y` → connector `y - 7`
- 20pt type (lockup wordmark), baseline `y` → connector `y - 6`

### Scaling the wordmark

To use the wordmark at a different size, **do not modify any individual coordinate**. Instead, scale the entire SVG via viewBox or transform. The internal coordinate system is locked — modifying it breaks the spacing.

- To make it larger: increase the rendered width while keeping the viewBox unchanged.
- To make it smaller: same approach. The vector scales cleanly down to about 100px wide before the connector dots become indistinct.
- Below 100px wide, switch to the monogram instead.

### Reproducing the wordmark from scratch

If you need to recreate the wordmark in any vector tool (Figma, Illustrator, Affinity Designer, raw SVG), follow these steps in order. Set the type in Atkinson Hyperlegible Next and outline it; never use live text or a system font. The coordinates assume the `AEC` outline is placed at `(x, y)`. All other coordinates are derived from `x`.

1. Outline `AEC` at 22 units, weight 600, letter-spacing -0.3, and place it at `(x, y)` in the chosen brand color.
2. Place a circle of radius 2.5 at centre `(x + 49.84, y - 7)`, filled `#E89668`.
3. Place a `#E89668` rectangle from `(x + 53.34, y - 7.75)`, 7 wide and 1.5 high.
4. Place a second circle of radius 2.5 at centre `(x + 63.84, y - 7)`, filled `#E89668`.
5. Outline `Integrations` at 22 units, weight 300, letter-spacing -0.3, and place it at `(x + 72.11, y)` in the same brand color as `AEC`.

If your tool kerns or advances differently, do not trust these offsets. Measure the C and I ink edges and re-derive the connector so both gaps are 7.

That is the entire wordmark. Five elements. Five rules. Anything else added or omitted is no longer the wordmark.

### Reference SVG

`branding/wordmark-light.svg`, with the two outline `d` strings shortened here. Copy the full strings from that file.

```svg
<svg viewBox="0 0 280 80" xmlns="http://www.w3.org/2000/svg">
  <!-- AEC Integrations wordmark. Letters are outlined from Atkinson Hyperlegible Next
       (SIL Open Font License 1.1), AEC at weight 600 and Integrations at weight 300,
       22 units, letter-spacing -0.3. Construction: branding/logo-construction.md. -->
  <rect width="280" height="80" fill="#F5F2EA"/>
  <g fill="#1E3A2F">
    <path transform="translate(10.00 47)" d="M0.16 0.00 5.70 -14.70H8.87L14.41 0.00H11.31 …"/>
    <path transform="translate(82.11 47)" d="M1.23 0.00V-1.20H3.30V-13.50H1.23V-14.70 …"/>
  </g>
  <g fill="#E89668">
    <circle cx="59.84" cy="40" r="2.5"/>
    <rect x="63.34" y="39.25" width="7" height="1.5"/>
    <circle cx="73.84" cy="40" r="2.5"/>
  </g>
</svg>
```

---

## The monogram

The monogram is the secondary brand mark. It is used wherever a square or near-square footprint is needed: social avatars, watermarks, profile pictures, and the entity-page OG fallback. The site's home-screen icon and its `Organization` logo use the stacked logo instead (see §The stacked logo). It is built around the four characters "AECi" inside a rounded square tile, with the i set in italic and tinted clay.

### Why the i is italic

The italic on the i is **not decorative**. It is the only thing that distinguishes the monogram from a generic four-letter abbreviation. The forward slant gives the i a sense of motion toward the AEC, which reinforces the integration concept without spelling it out. Without the italic, the mark reads as "AECI" — a noun. With the italic, it reads as "AEC + i" — a relationship.

**Never replace the italic i with a regular i. This is the single rule that cannot be broken.**

### The monogram is outlined type

Since 2026-10-17 every monogram file and the favicon carry their letters as `<path>` outlines of **Atkinson Hyperlegible Next** (SIL Open Font License 1.1), not `<text>`. The reason is the one given for the header wordmark in §The site header wordmark is outlined type: system fonts may not be outlined into a published logo, and live text changed shape with the operating system.

| Glyphs | Font file                                   | Weight | Size |
| ------ | ------------------------------------------- | ------ | ---- |
| `AEC`  | `AtkinsonHyperlegibleNext[wght].ttf`        | 600    | 24   |
| `i`    | `AtkinsonHyperlegibleNext-Italic[wght].ttf` | 600    | 24   |

The `i` comes from the italic font file. It is a true italic, not a slanted upright. No letter-spacing is applied. The recipe is the header wordmark's: instance the variable font at the weight, shape with HarfBuzz, draw each glyph through an `SVGPathPen` with y flipped, round to 2 decimals.

Placement:

- `AEC` is centred by ink on `x = 32`. Its translate is computed from the measured ink box, not from a `text-anchor`.
- The `i` keeps the ink left edge the old system-font `i` had in Chromium on macOS: `x = 64.3`. The italic glyph's left side bearing at this size is 1.11, so the translate is `64.3 - 1.11`.
- Both sit on baseline `y = 50`.

### Construction specifications

| Property                  | Value                                         |
| ------------------------- | --------------------------------------------- |
| Canvas                    | `80 × 80`                                     |
| Tile rect                 | `width=80 height=80 rx=12`, full bleed         |
| Tile fill (light variant) | `#1E3A2F` (Forest)                            |
| Tile fill (dark variant)  | `#F5F2EA` (Bone)                              |
| `AEC` path translate      | `9.58, 50`                                    |
| `AEC` ink box             | x `9.75` to `54.25`, y `33.68` to `50.29`      |
| `AEC` ink centre          | `32.00`                                       |
| `AEC` fill (light)        | `#F5F2EA` (Bone)                              |
| `AEC` fill (dark)         | `#1E3A2F` (Forest)                            |
| `i` path translate        | `63.19, 50`                                   |
| `i` ink box               | x `64.30` to `70.76`, y `32.27` to `50.00`     |
| `i` font-style            | **italic, REQUIRED, do not regularize**       |
| `i` fill                  | `#E89668` (Clay), both variants               |
| Ink gap C → `i`           | `10.05`                                       |

The ink numbers are from fontTools glyph bounds. A Chromium render at 10x measures the same within 0.1.

The tile is full bleed in every shipped file. Earlier versions of this guide specified `x=2 y=2 width=76 height=76 rx=8`, with `AEC` centred on `x = 36` and the `i` at `x = 60`. No file shipped at the time of the outline conversion used those values. They all used the full-bleed `rx=12` tile, `AEC` on `x = 32` and the `i` at `x = 64`, and this table now records what the files do.

The four `branding/monogram-*.svg` files are two pairs. `monogram-transparent.svg` is byte-identical to `monogram-light.svg`, and `monogram-transparent-inverted.svg` to `monogram-dark.svg`. "Transparent" means the corners outside the rounded tile are transparent in the 512 PNG exports. It does not mean the tile is missing. `apps/web/public/branding/monogram-light.svg` and `monogram-dark.svg` must stay byte-identical to their `branding/` copies. `monogram-light.svg` is the default OG image (`DEFAULT_OG_IMAGE` in `apps/web/src/app/core/meta.helpers.ts`).

### The favicon

The favicon is the clay italic `i` alone, from the same italic font file at weight 600 and size 48, on a transparent `64 × 64` canvas.

| Property            | Value                                     |
| ------------------- | ----------------------------------------- |
| `i` path translate  | `23.33, 50`                               |
| `i` ink box         | x `25.54` to `38.46`, y `14.54` to `50.00` |
| `i` ink centre      | `32.00`                                   |

`branding/favicon-i.svg` and `apps/web/public/favicon.svg` are byte-identical. `branding/favicon-i.ico` and `apps/web/public/favicon.ico` are byte-identical. The ICO holds six 32-bit BMP entries at 16, 32, 48, 64, 128 and 256 px, each a Chromium render of the SVG. At 16 px the dot and stem nearly touch, as they did before.

### Sizing notes

- At 32px and below, render at exactly the source size — do not scale a larger asset down. Use the 32px PNG.
- At 16px (browser favicon), the italic i becomes hard to distinguish from the regular AEC. This is acceptable — at that size, the user is reading the brand by silhouette and color, not letter shapes.
- Do not add padding around the tile. The tile already contains its own internal padding.

### Reference SVG

This is `monogram-light.svg` as shipped. The dark variant swaps the tile and `AEC` fills.

```svg
<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
  <!-- AEC Integrations monogram. Letters are outlined from Atkinson Hyperlegible Next
       (SIL Open Font License 1.1): AEC upright and i italic, both weight 600 at 24 units.
       Construction: branding/logo-construction.md. -->
  <rect width="80" height="80" rx="12" fill="#1E3A2F"/>
  <path transform="translate(9.58 50)" fill="#F5F2EA" d="M0.17 0.00 6.22 -16.03H9.68L15.72 0.00H12.34L11.26 -3.14H4.63L3.54 0.00ZM5.49 -5.72H10.38L7.93 -12.78Z M17.46 0.00V-16.03H29.06V-13.30H20.58V-9.61H26.29V-6.88H20.58V-2.73H29.16V0.00Z M38.08 0.29Q35.67 0.29 33.94 -0.75Q32.22 -1.78 31.30 -3.65Q30.39 -5.52 30.39 -8.03Q30.39 -10.55 31.35 -12.41Q32.32 -14.27 34.08 -15.29Q35.84 -16.32 38.22 -16.32Q40.38 -16.32 42.04 -15.34Q43.70 -14.37 44.57 -12.64L41.82 -11.64Q41.29 -12.66 40.31 -13.20Q39.33 -13.74 38.10 -13.74Q36.86 -13.74 35.84 -13.08Q34.83 -12.42 34.24 -11.14Q33.65 -9.86 33.65 -8.03Q33.65 -6.20 34.23 -4.92Q34.81 -3.64 35.84 -2.97Q36.87 -2.30 38.15 -2.30Q38.95 -2.30 39.67 -2.52Q40.40 -2.75 40.98 -3.21Q41.57 -3.67 41.93 -4.38L44.67 -3.38Q43.75 -1.64 42.02 -0.68Q40.29 0.29 38.08 0.29Z"/>
  <path transform="translate(63.19 50)" fill="#E89668" d="M1.11 0.00 3.15 -9.65H1.31L1.80 -11.90H6.58L4.04 0.00ZM5.70 -14.00Q4.94 -14.00 4.38 -14.55Q3.83 -15.10 3.83 -15.86Q3.83 -16.65 4.38 -17.19Q4.94 -17.73 5.70 -17.73Q6.48 -17.73 7.02 -17.19Q7.56 -16.65 7.56 -15.86Q7.56 -15.10 7.02 -14.55Q6.48 -14.00 5.70 -14.00Z"/>
</svg>
```

The system-font version it replaced is kept only to show where the `x = 32` centre and `x = 64` start came from. Never outline it from SF Pro or Segoe UI.

```svg
<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
  <rect width="80" height="80" rx="12" fill="#1E3A2F"/>
  <text x="32" y="50" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="24" font-weight="600" fill="#F5F2EA" text-anchor="middle">AEC</text>
  <text x="64" y="50" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="24" font-weight="600" font-style="italic" fill="#E89668">i</text>
</svg>
```

---

## The lockup

The lockup combines the monogram tile and the wordmark side-by-side, separated by a small horizontal gap. It is reserved for hero moments where both marks need to appear together: pitch deck title slides, the masthead of a major report, the home page hero. Used too often, both marks lose impact.

### Construction specifications

| Property                          | Value                            |
| --------------------------------- | -------------------------------- |
| Monogram tile size                | `60 × 60`                        |
| Monogram tile corner radius       | 6                                |
| Monogram tile fill (light)        | `#1E3A2F` (Forest)               |
| Monogram tile fill (dark)         | `#F5F2EA` (Bone)                 |
| `AEC` inside tile font-size       | 18                               |
| `AEC` inside tile weight          | 600                              |
| Italic `i` font-size              | 18                               |
| Italic `i` color                  | `#E89668` (Clay) — never changes |
| Wordmark beside tile font-size    | 20 (scaled from 22)              |
| Wordmark x-offset from tile right | 15                               |
| Wordmark y-baseline               | centered on tile                 |

### Why the wordmark in the lockup is 20pt instead of 22pt

The wordmark inside the lockup is rendered at 20pt rather than the standard 22pt so that its visual weight matches the 60×60 monogram tile beside it. At 22pt, the wordmark visually overpowers the tile; at 20pt, the two elements feel like they belong to the same composition. The connector geometry inside the lockup is proportionally scaled from the 22pt spec by a factor of `20/22 ≈ 0.909`.

For 20pt lockup wordmark, the relative coordinates become:

| Element                 | Coordinate (relative to local AEC start) |
| ----------------------- | ---------------------------------------- |
| First dot center        | `x + 45.31`                              |
| Line start              | `x + 48.49`                              |
| Line end                | `x + 54.85`                              |
| Second dot center       | `x + 58.04`                              |
| Integrations translate  | `x + 65.55`                              |

These are the outlined 22-unit coordinates (§The wordmark) scaled by `20/22`, so the lockup must also use Atkinson outlines scaled by the same factor. No lockup file ships in `branding/` today; build one from the outlined wordmark, never from live text.

---

## The stacked logo

The stacked logo is the wordmark rearranged to fit a square. "AEC" sits on top, the clay connector sits below it, and "Integrations" sits below the connector. All three are centred on a Bone square.

It exists for third-party surfaces that need a square image and then compare it against the homepage. The first one is the Google OAuth consent screen. Google rejected the monogram there on 2026-10-12: "Your logo does not uniquely identify your brand and identity." The "AEC i" monogram appears nowhere on the public site, so the reviewer could not tie it to `aecintegrations.com`. The stacked logo carries the same words and connector as the site header, so it matches.

Use the monogram for favicons and avatars we control. Use the stacked logo wherever an outside reviewer has to recognise the brand from a square.

The first rejection taught a second lesson. The checker returned the same finding about 20 seconds after resubmitting with the stacked logo. It is automated, and it looks for the logo on the homepage. At the time the site showed no logo image at all: the header wordmark was `aria-hidden` inline SVG, and the only machine-readable logos were the monogram. So the site now carries the stacked logo and a real wordmark image:

| Where                                            | What                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| Header and footer                                | `<img src="/branding/wordmark.svg" alt="AEC Integrations">` (`apps/web/src/app/layout/brand-logo.ts`) |
| Home `Organization` JSON-LD `logo`               | `/branding/stacked-logo-512.png` (`SITE_LOGO` in `apps/web/src/app/core/meta.helpers.ts`)             |
| `apple-touch-icon.png` and the web manifest icon | The stacked logo, 512×512                                                                             |
| Favicon                                          | Still the italic "i". The stacked logo is unreadable at 16 px.                                        |

The served copy at `apps/web/public/branding/stacked-logo-512.png` must stay identical to `branding/stacked-logo-512.png`. `apps/web/public/apple-touch-icon.png` is the same file.

### Construction specifications

The canvas is `120 × 120`, which is Google's logo size. Scale the whole SVG to export larger. Never move individual coordinates.

Since 2026-10-17 the letters are `<path>` outlines of **Atkinson Hyperlegible Next** (SIL Open Font License 1.1), not `<text>`. The method is the header wordmark's, described in "The site header wordmark is outlined type" above. Live text drew the logo in the renderer's system font, so the PNG exports depended on the machine that made them.

| Element        | Value                                                                                         |
| -------------- | --------------------------------------------------------------------------------------------- |
| Background     | `#F5F2EA` (Bone), full bleed, no corner radius                                                |
| `AEC`          | Atkinson weight 600, size 34, letter-spacing -0.5, Forest, ink-centred on `x 60`, baseline `y 56` |
| Connector dots | radius 3, Clay, centres `(48, 64)` and `(72, 64)`                                             |
| Connector line | a `<rect>` `x 52` → `x 68`, `y 63`, height 2, Clay                                            |
| `Integrations` | Atkinson weight 400, size 17, letter-spacing -0.3, Forest, ink-centred on `x 60`, baseline `y 84` |

`Integrations` is weight 400 here, not the wordmark's 300. At 120 px a 300 weight breaks up. AEC stays heavier, so the hierarchy holds.

The wordmark's 7/7 connector spacing does not apply here. In the stacked logo the connector sits between two lines, not between two words. The gaps were set by eye on the rendered output and are locked at the values above. The outlining did not move the connector.

Each word is centred by its ink, not by its advance width. Shape the word with HarfBuzz, measure the ink bounding box, and translate the path so the box midpoint lands on `x 60`. Measured on the shipped file (SVG units):

| Element        | Path translate | Ink left | Ink right | Ink midpoint | Ink top | Ink bottom |
| -------------- | -------------- | -------- | --------- | ------------ | ------- | ---------- |
| `AEC`          | `28.74, 56`    | `28.98`  | `91.02`   | `60.00`      | `32.88` | `56.41`    |
| `Integrations` | `16.00, 84`    | `16.93`  | `103.07`  | `60.00`      | `71.86` | `87.26`    |
| Connector      | n/a            | `45.00`  | `75.00`   | `60.00`      | `61.00` | `67.00`    |

`AEC` ink bottom sits below the baseline because the C overshoots. `Integrations` ink bottom is the g descender. Verify any rebuild by rendering the SVG at 10x and scanning ink columns. Both words must measure a midpoint of 60.0.

### Reference SVG

The path data is long. `branding/stacked-logo.svg` is the copy to use. Its structure:

```svg
<svg viewBox="0 0 120 120" xmlns="http://www.w3.org/2000/svg">
  <rect width="120" height="120" fill="#F5F2EA" />
  <g fill="#1E3A2F">
    <path transform="translate(28.74 56)" d="(AEC, Atkinson 600, 34 units, letter-spacing -0.5)" />
    <path transform="translate(16.00 84)" d="(Integrations, Atkinson 400, 17 units, letter-spacing -0.3)" />
  </g>
  <g fill="#E89668">
    <circle cx="48" cy="64" r="3" />
    <rect x="52" y="63" width="16" height="2" />
    <circle cx="72" cy="64" r="3" />
  </g>
</svg>
```

### Files

| File                   | Use                                    |
| ---------------------- | -------------------------------------- |
| `stacked-logo.svg`     | Source                                 |
| `stacked-logo-120.png` | The Google OAuth consent-screen upload |
| `stacked-logo-512.png` | High-res export for other square slots |

Regenerate the PNGs from the SVG, then refresh the two served copies of the 512 export:

```bash
rsvg-convert -w 120 -h 120 branding/stacked-logo.svg -o branding/stacked-logo-120.png
rsvg-convert -w 512 -h 512 branding/stacked-logo.svg -o branding/stacked-logo-512.png
cp branding/stacked-logo-512.png apps/web/public/branding/stacked-logo-512.png
cp branding/stacked-logo-512.png apps/web/public/apple-touch-icon.png
```

A new 120 PNG must be re-uploaded to the Google OAuth consent screen by hand. The served copies update on deploy.

---

## Variants and naming

Every variant is one of three primitives × four properties: light or dark, with background or transparent, original or tight crop. The naming convention is:

```
{primitive}-{light|dark|transparent|transparent-dark}[-tight].svg
```

**Examples:**

```
wordmark-primary-light.svg
wordmark-primary-light-tight.svg
lockup-dark.svg
monogram-transparent-inverted.svg
```

### Original vs tight crop

Each wordmark and lockup ships in two crop variants:

- **Original** — generous padding around the type, equal roughly to the height of the capital A. Use wherever the logo needs space to breathe (marketing pages, deck title slides, hero moments).
- **Tight** — padding trimmed to about 4 units. Use wherever the logo is packed into constrained space (header navs, email signatures, document footers).

| Variant           | viewBox     |
| ----------------- | ----------- |
| Original wordmark | `280 × 80`  |
| Tight wordmark    | `196 × 30` (viewBox `3 25 196 30`, 7-unit padding) |
| Original lockup   | `380 × 100` |
| Tight lockup      | `290 × 60`  |

The internal coordinates of the type and connector are **identical** between original and tight versions. Only the viewBox changes.

---

## `email-logo-banner.png` is a published asset now (2026-09-14)

`branding/email-logo-banner.png` (1120x182, **transparent** field, Bone wordmark, clay
connector) used to be an unreferenced file. It is now the header of every transactional
email, and a copy is served at a **fixed, hardcoded URL**:

```
https://www.aecintegrations.com/branding/email-logo-banner.png
```

served from `apps/web/public/branding/email-logo-banner.png`, referenced by
`EMAIL_LOGO_URL` in `apps/api/src/lib/email-layout.ts` and by
`docs/email-templates/magic-link.html`.

Three consequences:

- **Do not rename, move or delete that path.** A mail client fetches it months after the
  send. Breaking it breaks the header of every email already sitting in an inbox, and
  nothing in CI would notice.
- **The URL is production, not per-tier, on purpose.** Non-prod sits behind Cloudflare
  Access, so a staging URL would 403 in the recipient's mail client.
- **PNG, not SVG.** Outlook and Gmail do not render SVG at all, which is why the served
  `monogram-light.svg` cannot stand in.
- **The background is transparent, and must stay transparent (AECI-924).** The banner
  shipped with a baked Forest field on 2026-09-14 and the email header rendered as two
  different greens the same day. A mail client applying a dark-mode transform shifts the
  band's CSS `#1E3A2F` (measured: to `#334D42`) and cannot touch pixels inside an image,
  so the logo sat in a darker rectangle of its own. Alpha removes the seam because the
  band shows through. The glyphs stay Bone `#F5F2EA` and clay `#E89668`, both of which
  read on Forest and on anything a dark-mode client turns Forest into.

Redrawing the banner means re-exporting to this same filename, **with no background
fill**. The repo copy under `branding/` and the served copy under
`apps/web/public/branding/` must stay identical.

---

## Things never to do when constructing the logo

- Never change the connector color from clay. The connector is the only place clay appears in the wordmark — it is the brand signal.
- Never make the AEC and Integrations the same weight. The hierarchy is the brand voice — bold AEC, light Integrations.
- Never use a serif typeface. The brand is sans-serif.
- Never replace the italic i in the monogram with a regular i.
- Never apply effects to the marks: no shadows, no gradients, no glows, no outlines, no inner strokes.
- Never recreate the connector with a different shape — no triangles, arrows, dashes, or chevrons. The dot-line-dot is the mark.
- Never tilt, skew, rotate, or italicize the wordmark itself. Only the i in the monogram is italic.
- Never tighten or loosen the connector geometry on a per-use basis. The 7/7 spacing is locked.
- Never estimate type metrics. If you need to adjust spacing, render the result and measure it.
