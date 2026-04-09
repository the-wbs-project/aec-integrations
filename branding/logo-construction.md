# AEC Integrations — Logo Construction Guide

This is the technical companion to the brand guidelines. The brand guidelines cover *when and where* to use the logo. This document covers *how to build it* — exact coordinates, type specs, color values, and the geometry of the connector mark. If the source SVG files are ever lost, corrupted, or need to be rebuilt in a different tool, this document is the source of truth.

Every variant of the logo is constructed from one of three primitives: the **wordmark**, the **monogram**, or the **lockup**. All three share the same color tokens, the same connector geometry, and the same italic "i" rule. Once you understand the wordmark, the rest follows.

---

## Color tokens

Only three colors appear in any logo variant. Clay is the only color that does not flip between light and dark modes — it is the constant that anchors the brand across every context.

| Token | Hex | Role |
|---|---|---|
| Forest | `#1E3A2F` | Text and tile fill on light backgrounds; tile background on dark backgrounds becomes Bone |
| Bone | `#F5F2EA` | Text and tile fill on dark backgrounds; tile background on light backgrounds becomes Forest |
| Clay | `#E89668` | Connector mark and italic "i" — never changes regardless of background |

Stone, Ink, and Paper from the broader brand palette do **not** appear in the logo. They are reserved for UI surfaces and body text.

---

## The wordmark

The wordmark is the primary brand mark. It consists of three elements rendered in a single horizontal line: the word "AEC" in semibold, a connector mark (two dots joined by a line), and the word "Integrations" in light weight. All three elements share the same baseline.

### Type specifications

| Property | Value |
|---|---|
| Typeface | System sans (Inter / SF Pro / Segoe UI) |
| `AEC` weight | 600 (semibold) |
| `AEC` font-size | 22 |
| `Integrations` weight | 300 (light) |
| `Integrations` font-size | 22 |
| Letter-spacing | -0.3 |
| Text fill (light bg) | `#1E3A2F` (Forest) |
| Text fill (dark bg) | `#F5F2EA` (Bone) |
| Connector color | `#E89668` (Clay) — never changes |
| Connector stroke-width | 1.5 |
| Connector dot radius | 2.5 |
| Connector y-position | 7px above text baseline (visual midpoint of caps) |

### Connector geometry

The connector consists of two clay-colored dots joined by a clay line, set at the visual midpoint of the capital letters. The gap between the C and the first dot is 7 units; the gap between the second dot and the I is also 7 units. This symmetric spacing keeps the connector balanced between the two words — neither word claims it.

**Critical:** "visual edge" and "declared text x-position" are different things. At semibold 22pt with letter-spacing -0.3, the visual right edge of the C extends approximately 46 units past the declared `AEC` text x-position. The visual left edge of the I in `Integrations` is approximately 2.25 units past its declared text x-position. The 7-unit gap is measured between these *visual* edges, not between declared text positions. Estimating from font metrics will produce a wrong result — measure rendered output if you need to verify.

All measurements below are relative to the starting x-coordinate of the AEC text. To shift the wordmark anywhere on a canvas, only that x-coordinate needs to change — every other coordinate is computed from it.

| Element | Coordinate |
|---|---|
| AEC start (declared) | `x` |
| AEC visual right edge (measured) | `x + 46` |
| First dot center | `x + 55.25` |
| First dot right edge | `x + 57.75` |
| Line start | `x + 58.75` |
| Line end | `x + 65.75` |
| Second dot left edge | `x + 66.75` |
| Second dot center | `x + 69.25` |
| Second dot right edge | `x + 71.75` |
| Integrations declared x | `x + 76.5` |
| Integrations visual left edge (I) | `x + 78.75` |
| Visual gap C → first dot | `7` |
| Visual gap second dot → I | `7` |

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

If you need to recreate the wordmark in any vector tool (Figma, Illustrator, Affinity Designer, raw SVG), follow these steps in order. The coordinates assume the AEC text is placed at position `(x, y)`. All other coordinates are derived from `x`.

1. Place the text `AEC` at position `(x, y)`, 22pt, weight 600, letter-spacing -0.3, in the chosen brand color.
2. Place a circle of radius 2.5 at center `(x + 55.25, y - 7)`, filled `#E89668`.
3. Draw a line from `(x + 58.75, y - 7)` to `(x + 65.75, y - 7)`, stroke `#E89668`, stroke-width 1.5.
4. Place a second circle of radius 2.5 at center `(x + 69.25, y - 7)`, filled `#E89668`.
5. Place the text `Integrations` at position `(x + 76.5, y)`, 22pt, weight 300, letter-spacing -0.3, in the same brand color as AEC.

That is the entire wordmark. Five elements. Five rules. Anything else added or omitted is no longer the wordmark.

### Reference SVG

```svg
<svg viewBox="0 0 280 80" xmlns="http://www.w3.org/2000/svg">
  <rect width="280" height="80" fill="#F5F2EA"/>
  <text x="10" y="47" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="22" font-weight="600" fill="#1E3A2F" letter-spacing="-0.3">AEC</text>
  <circle cx="65.25" cy="40" r="2.5" fill="#E89668"/>
  <line x1="68.75" y1="40" x2="75.75" y2="40" stroke="#E89668" stroke-width="1.5"/>
  <circle cx="79.25" cy="40" r="2.5" fill="#E89668"/>
  <text x="86.5" y="47" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="22" font-weight="300" fill="#1E3A2F" letter-spacing="-0.3">Integrations</text>
</svg>
```

---

## The monogram

The monogram is the secondary brand mark. It is used wherever a square or near-square footprint is needed: favicons, app icons, social avatars, watermarks, profile pictures. It is built around the four characters "AECi" inside a rounded square tile, with the i set in italic and tinted clay.

### Why the i is italic

The italic on the i is **not decorative**. It is the only thing that distinguishes the monogram from a generic four-letter abbreviation. The forward slant gives the i a sense of motion toward the AEC, which reinforces the integration concept without spelling it out. Without the italic, the mark reads as "AECI" — a noun. With the italic, it reads as "AEC + i" — a relationship.

**Never replace the italic i with a regular i. This is the single rule that cannot be broken.**

### Construction specifications

| Property | Value |
|---|---|
| Canvas | `80 × 80` |
| Tile rect | `x=2 y=2 width=76 height=76 rx=8` |
| Tile fill (light variant) | `#1E3A2F` (Forest) |
| Tile fill (dark variant) | `#F5F2EA` (Bone) |
| `AEC` font-size | 24 |
| `AEC` font-weight | 600 |
| `AEC` anchor | middle, `x=36, y=50` |
| `AEC` fill (light) | `#F5F2EA` (Bone) |
| `AEC` fill (dark) | `#1E3A2F` (Forest) |
| `i` font-size | 24 |
| `i` font-weight | 600 |
| `i` font-style | **italic — REQUIRED, do not regularize** |
| `i` position | `x=60, y=50` |
| `i` fill | `#E89668` (Clay) — both variants |

### Sizing notes

- At 32px and below, render at exactly the source size — do not scale a larger asset down. Use the 32px PNG.
- At 16px (browser favicon), the italic i becomes hard to distinguish from the regular AEC. This is acceptable — at that size, the user is reading the brand by silhouette and color, not letter shapes.
- Do not add padding around the tile. The tile already contains its own internal padding.

### Reference SVG

```svg
<svg viewBox="0 0 80 80" xmlns="http://www.w3.org/2000/svg">
  <rect x="2" y="2" width="76" height="76" rx="8" fill="#1E3A2F"/>
  <text x="36" y="50" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="24" font-weight="600" fill="#F5F2EA" text-anchor="middle">AEC</text>
  <text x="60" y="50" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" font-size="24" font-weight="600" font-style="italic" fill="#E89668">i</text>
</svg>
```

---

## The lockup

The lockup combines the monogram tile and the wordmark side-by-side, separated by a small horizontal gap. It is reserved for hero moments where both marks need to appear together: pitch deck title slides, the masthead of a major report, the home page hero. Used too often, both marks lose impact.

### Construction specifications

| Property | Value |
|---|---|
| Monogram tile size | `60 × 60` |
| Monogram tile corner radius | 6 |
| Monogram tile fill (light) | `#1E3A2F` (Forest) |
| Monogram tile fill (dark) | `#F5F2EA` (Bone) |
| `AEC` inside tile font-size | 18 |
| `AEC` inside tile weight | 600 |
| Italic `i` font-size | 18 |
| Italic `i` color | `#E89668` (Clay) — never changes |
| Wordmark beside tile font-size | 20 (scaled from 22) |
| Wordmark x-offset from tile right | 15 |
| Wordmark y-baseline | centered on tile |

### Why the wordmark in the lockup is 20pt instead of 22pt

The wordmark inside the lockup is rendered at 20pt rather than the standard 22pt so that its visual weight matches the 60×60 monogram tile beside it. At 22pt, the wordmark visually overpowers the tile; at 20pt, the two elements feel like they belong to the same composition. The connector geometry inside the lockup is proportionally scaled from the 22pt spec by a factor of `20/22 ≈ 0.909`.

For 20pt lockup wordmark, the relative coordinates become:

| Element | Coordinate (relative to local AEC start) |
|---|---|
| First dot center | `x + 50.2` |
| Line start | `x + 53.4` |
| Line end | `x + 59.8` |
| Second dot center | `x + 63.0` |
| Integrations declared x | `x + 69.5` |

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

| Variant | viewBox |
|---|---|
| Original wordmark | `280 × 80` |
| Tight wordmark | `230 × 44` |
| Original lockup | `380 × 100` |
| Tight lockup | `290 × 60` |

The internal coordinates of the type and connector are **identical** between original and tight versions. Only the viewBox changes.

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