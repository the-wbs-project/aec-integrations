# Chris's rulings on the 45 design clashes (2026-11-13)

Source: `.context/AECi-design-clashes-RULED-2026-11-13.docx` (filled copy). Clash detail: `.context/design-clashes.md`.

Key: NEW = use the new design, the rule in DESIGN.md is rewritten. CURRENT = keep the current rule, the mock-up changes. BLEND = the blend stated in the clash file's recommendation, unless a note says otherwise.

| # | Clash | Ruling | Chris's note |
|---|---|---|---|
| 1 | Forest as the page ground | NEW | |
| 2 | Tinted bands as the page ground | BLEND | |
| 3 | Clay fills the main buttons | BLEND | |
| 4 | Clay carries text and meaning | BLEND | |
| 5 | Selected states fill solid | BLEND | |
| 6 | Colour values outside the token file | BLEND | |
| 7 | Display type on detail pages | NEW | |
| 8 | Many large figures | BLEND | |
| 9 | The type ramp | BLEND | |
| 10 | Eyebrows and microheadings | CURRENT | |
| 11 | Shadows instead of borders | BLEND | |
| 12 | Large radii and pill shapes | BLEND | |
| 13 | Gradients, noise and frosted glass | BLEND (ruled 2026-11-13, second pass) | Keep the soft single-colour glow in the hero. Drop the frosted-glass blur on the sticky bar. Drop the noise texture. |
| 14 | Cards inside cards | NEW | |
| 15 | Side stripes | NEW | |
| 16 | The detail page layout | NEW | |
| 17 | Spacing off the 4-point scale | BLEND | "I do believe we have too many font sizes and variants, see what it looks like to limit them." |
| 18 | Uniform card grids | BLEND | |
| 19 | Charts and meters on public pages | BLEND | |
| 20 | Button anatomy | BLEND | "I kind of like same size buttons" |
| 21 | Link styling | CURRENT | |
| 22 | Too many chip styles | BLEND | |
| 23 | Inputs | NEW | |
| 24 | The integrations section | BLEND | |
| 25 | A bare zero | NEW | "I like the new design" |
| 26 | The header's main links | NEW | "Products is in browse (All Products)" |
| 27 | One mega-menu for four dropdowns | NEW | |
| 28 | Active-state markers | NEW | |
| 29 | Header search and sign-in | NEW | |
| 30 | The mobile menu | NEW | |
| 31 | The breadcrumb separator | CURRENT | |
| 32 | The footer | BLEND | |
| 33 | Arrows used for navigation | NEW | |
| 34 | Icons and logo tiles | NEW | |
| 35 | The hero diagram | NEW | |
| 36 | Animation timing and decoration | BLEND | |
| 37 | Hover and press movement | NEW | |
| 38 | Smooth scrolling | NEW | "Make sure we know how to adopt the old way if needed." |
| 39 | A public "claimed" label | CURRENT | |
| 40 | The maintenance chip and field captions | CURRENT | |
| 41 | The agreement states | CURRENT | |
| 42 | The wordmark | CURRENT | |
| 43 | Public demand counts | BLEND | |
| 44 | The anchor reference site | CURRENT | |
| 45 | The same-behaviour rule | BLEND | |

Tally: NEW 17, CURRENT 8, BLEND 19, OPEN 1.

Floors that stay whatever the ruling (accessibility and legal, not style):
- 23 inputs: a 3:1 visible boundary on every form control (WCAG 1.4.11).
- 30 mobile menu: the toggle has an accessible name and the open menu traps focus.
- 34 logos: unclaimed products show initial tiles outside their own page (counsel ruling 9).
- 38 smooth scrolling: must not break router scroll restoration, and must respect reduced motion.
