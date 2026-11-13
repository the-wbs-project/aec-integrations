---
target: .context/mockups/6-product-detail.html, 7-product-many.html, 8-product-none.html
date: 2026-11-12
scores: {"6": 28, "7": 26, "8": 27}
---

# Impeccable critique: product detail mock-ups 6, 7, 8

Verdict: strong, coherent, not AI slop in composition, but it leans on SaaS tells (shadowed rounded cards, repeated big numerals, side stripes) and puts trust glyphs on vendor state. Fixable without changing the concept.

## Nielsen scores (0 to 4)

| # | Heuristic | 6 | 7 | 8 | Key issue |
|---|---|---|---|---|---|
| 1 | System status | 3 | 3 | 3 | Live filter heading and counts are good |
| 2 | Real world match | 3 | 3 | 2 | 8: "It does exist" button, "could be built" note |
| 3 | User control | 3 | 3 | 3 | Clear filters, show fewer present |
| 4 | Consistency | 2 | 1 | 3 | 7: category chip counts disagree with rail counts |
| 5 | Error prevention | 3 | 3 | 3 | n/a mostly |
| 6 | Recognition | 3 | 3 | 3 | Icons always paired with labels |
| 7 | Flexibility | 3 | 3 | 3 | Cards/table, filters, "/" search |
| 8 | Minimalist | 2 | 2 | 2 | Same count shown 3-4 times; nested shadow cards |
| 9 | Error recovery | 3 | 3 | 3 | Empty filter state offers Clear filters |
| 10 | Help | 3 | 2 | 3 | 7 ring note good; 6 hero ring unexplained |
| | Total | 28 | 26 | 27 | Good band |

## Detector (npx impeccable detect, URL scan, 1440x900 and 390x844)

| Page | 1440 | 390 | Warnings named |
|---|---|---|---|
| 6 | 19 (16 warning, 3 advisory) | 26 | side-tab x7, nested-cards x8, dark-glow x1, low-contrast x1 |
| 7 | 20 (15 warning, 5 advisory) | 22 | side-tab x7, nested-cards x6-7, dark-glow x1, low-contrast x1, shape-assembled-illustration (advisory) |
| 8 | 23 (18 warning, 5 advisory) | 24 | side-tab x7, nested-cards x7, dark-glow x2, low-contrast x1, shape-assembled-illustration (advisory) |

The detector has no P0/P1 scale. Its warnings map to: side-tab = `.score.o::before` 7px stripe and `.rs.o` 3px inset stripe; nested-cards = review score chips inside review cards, `.reach` inside `.ifill`, `.viewtog` inside `.deck`; dark-glow = clay box-shadow on `.btn-hero`. Its 3.0:1 hero contrast reading is a gradient artefact. The true value is 4.40:1 (see axe).

## Axe (wcag2a/aa, 2.1, 2.2, best-practice)

| Page / palette | Serious | Moderate |
|---|---|---|
| 6, 7, 8 brand, 1440 and 390 | color-contrast `.pin.o > .pl` white on #C76A3A, 3.78:1, 12.5px bold | heading-order (footer h4) |
| 7 brand 1440 | same | plus landmark-complementary-is-top-level `#rail` |
| 6 Harbour | `.pin.o > .pl` white on #D35E44, 3.85:1 | heading-order |
| 6 Chalk and cobalt | `.pin.o > .pl` white on #D0502A, 4.31:1 | heading-order |

Manual measurements axe missed: hero "reviews" link `.hr-rv span`, clay on hero panel, 14px bold: brand 4.40:1, Harbour 4.21:1. Filter input `.field` and unpressed `.cat` chips have no boundary at 3:1 (shadow only, or a 35% grey ring about 1.5:1), WCAG 1.4.11.

Keyboard: 70-stop tab walk on each page at both widths found no stop without a visible focus ring. No skip link.

## Findings: see the session report for the ranked list and DESIGN.md divergences.
