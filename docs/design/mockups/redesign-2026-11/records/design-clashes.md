# Design clashes: mock-ups 5 to 8 against the written design rules

Scope: `.context/mockups/5-statement-first.html`, `6-product-detail.html`, `7-product-many.html`, `8-product-none.html`, the "Browse" mega-menu (`src/catmenu-*`), and their PNGs. Judged on the default "AECi brand" palette (`data-palette="brand"`). Rules read from `DESIGN.md`, `PRODUCT.md`, `ANGULAR_STYLE_GUIDE.md`, `docs/BRAND_GUIDELINES.md`, `apps/web/src/styles.css` and `apps/web/src/app/layout/`.

45 clashes. Sizes: S means a few components change, M means one pattern across many pages, L means most public pages change. Line numbers are for DESIGN.md unless another file is named.

## Colour

### 1. Forest as a full-bleed ground for the header, hero, footer and feature cards
- **Rule**: Brand colours are accents on neutral surfaces and never the page ground. DESIGN.md §2 "The Surfaces-Are-Neutral Rule" (line 223): "Brand colors are accents that layer on top of neutral surfaces. They are never the page background." PRODUCT.md "Constraints" adds that "A dark front door pattern-matches to 'internal tool' and undercuts the trust argument." The footer ground is "`surface-base` (white) on every page" (line 1053). The live header is white with a Bone rule (`layout/site-header.ts`).
- **New design**: All four pages. `.site-head` and `.hero` use `--hero-bg: #1E3A2F` across the full width. `.foot` uses `--foot-bg: #15291F`. `.know` (page 8) and `.cm-card` are Forest cards. About a third of the first viewport is dark green.
- **Stakes**: The rule keeps brand colour scarce so it means something, and keeps the front door from reading as an app. The dark band is what gives the new design its weight and signature. No lint rule fires: the light-only guard in `check-source-constraints.mjs` looks for `dark:` variants and theme selectors, not a dark band.
- **Size**: L
- **Recommendation**: override. Rewrite the rule so Forest may be the ground of three chrome bands (header, detail-page hero, footer) while the reading body stays neutral, because this band is the thing the owner likes and it is still a light theme.

### 2. Tinted bands as the page ground
- **Rule**: Bone is an accent surface for hero and callout bands only. DESIGN.md §2 (line 195): "Hero bands on About, callout sections, marketing emphasis. **Not a page background.**" BRAND_GUIDELINES.md §4 says the same. Forest soft is "a wash, not a boundary" for selected states (line 182).
- **New design**: All four pages. `.band.warm` (Bone), `.band.cool` (`--band-cool: #ECF1EE`, Forest soft), `.band.deep` (`--band-deep: #E4ECE7`, a new token) alternate down the page. On page 6 the sequence is warm, cool, plain, warm, cool, plain, deep. White is a minority of the page.
- **Stakes**: The rule keeps tinted surfaces meaningful as emphasis and keeps Forest soft free to mean "selected". With every band tinted, no band is emphasis, and a selected chip on a Forest-soft band loses its signal. Not linted.
- **Size**: M
- **Recommendation**: combine. Keep white as the body ground and allow one Bone band per page for the key section. Drop the Forest-soft and deep-green bands, so Forest soft stays the selected-state wash.

### 3. Clay fills the main calls to action
- **Rule**: Every CTA is Forest and Clay never fills one. DESIGN.md "The Forest-Anchor Rule" (line 225): "Every CTA ... Forest." "The Clay-Restriction Rule" (line 227): "Clay never fills a CTA." BRAND_GUIDELINES.md §5 repeats it.
- **New design**: Pages 5, 6, 7, 8. `.btn-hero { background: var(--hero-accent) }` with `--hero-accent: #E89668` on "Visit website" and "It does exist". The status pip, the logo seal and the menu trigger bar are Clay too.
- **Stakes**: The rule keeps one action colour so a reader always knows what to press, and keeps Clay rare. On a Forest ground a Forest button vanishes, so the mock reached for Clay. Not linted (the 5% cap is review-only, ANGULAR_STYLE_GUIDE.md §24).
- **Size**: S
- **Recommendation**: combine. On a Forest band use the inverted primary that already ships in the "Getting Managed" panel (line 712: "`--surface-base` fill, Forest text"), or a Bone fill. Clay stays a stroke and accent colour only.

### 4. Clay carries text and meaning
- **Rule**: Clay `#E89668` never carries text or meaning-bearing graphics, and Clay as a whole stays under 5% of a screen. DESIGN.md line 227: "Anything clay-colored that *carries meaning*, text, icons, uses **Clay deep**." Line 171: "Clay is rare (≤5% per screen)."
- **New design**: Page 5 `.statement .pn { color: var(--hero-accent) }` sets both product names in Clay. Pages 6 to 8 `.byline a` sets the vendor link in Clay. Clay deep is the focus ring (`--focus: #A14D22`), every `.kicker`, every `.f-h` and `.facet h4` icon, the partner-category chips (`.mini.ct`, `--accent-soft: #FBEADF`), and the onboarding series (`--meter-b: #C76A3A`, `.score.o`).
- **Stakes**: The rule protects Clay's meaning as the rare high-emphasis accent and keeps text contrast measurable. Spread across chips, icons and headings it becomes a second brand colour. Not linted.
- **Size**: M
- **Recommendation**: combine. Keep Clay deep as the onboarding series colour, which has precedent in the admin charts (line 596, Forest and Clay deep). Set highlighted names in Bone on Forest, and move chips, kicker icons and the focus ring back to neutral or Forest.

### 5. Selected and pressed states fill solid Forest, or solid black
- **Rule**: Selected facets and active chips take the Forest-soft wash. DESIGN.md line 182: "fills for selected facets, active chips." The active route is Forest text with a 2px Forest underline (line 941).
- **New design**: Pages 5 to 8. `.obj[aria-pressed="true"]`, `.seg button[aria-pressed]`, `.snl a[aria-current]`, `.rail a[aria-current]` and `a.tagchip:hover` fill `var(--brand)` with white text. `.viewtog button[aria-pressed="true"] { background: var(--ink) }` fills near-black.
- **Stakes**: The rule keeps "selected" quiet so the one primary action stays the loudest thing on the page. A solid-Forest pressed segment already ships (`.aec-period[aria-pressed='true']`, line 656), so this is half precedent. The black toggle has no precedent. Not linted.
- **Size**: M
- **Recommendation**: combine. Allow a solid Forest fill for pressed segmented controls and toggles, using the shipped period-toggle precedent. Keep the wash for selected filter chips, and make the view toggle Forest, never ink.

### 6. Colour literals and new tokens outside `styles.css`
- **Rule**: No colour literal outside the token file, and tokens are OKLCH. ANGULAR_STYLE_GUIDE.md §20: "**Banned:** ... `#1E3A2F`, `oklch(...)`, `rgb(...)`." DESIGN.md §6: "**Do** use OKLCH in CSS." The No-Pure-Black-Or-White Rule (line 229).
- **New design**: All pages define about 30 hex tokens in `:root` (`--hero-panel: #26473A`, `--band-deep`, `--accent-soft`, `--star-empty: #E7E2D4`, `--foot-bg`), mix with `color-mix(in srgb, ...)` throughout, tint shadows with `rgba(var(--shadow-tint), ...)`, and write `#fff` in `.mini.ct.hit` and `.pin .pl`.
- **Stakes**: The rule keeps one palette that the contrast matrix can verify. `pnpm lint` enforces it (AECI-597, `eslint.color-patterns.mjs` and `check-source-constraints.mjs`), so this markup cannot be ported as written.
- **Size**: M
- **Recommendation**: combine. Add the few genuinely new surfaces (hero panel, footer ground) as OKLCH tokens in `styles.css` and drop the rest, because the lint will force it anyway.

## Typography

### 7. The Display role on the product name and the pair statement
- **Rule**: Display is for About, Home and vendor mastheads, at most once a page. Product surfaces use Headline 600 for the H1. DESIGN.md §3 Hierarchy (lines 245 to 246): Display for "hero headlines on About, Home, vendor profile mastheads", Headline for "page H1 on content pages and product surfaces."
- **New design**: Pages 6 to 8 `.pname { font-weight: 400; font-size: clamp(54px, 5.4vw, 80px); letter-spacing: -.03em }`. Page 5 `.statement { clamp(38px, 4vw, 58px); weight 400 }`.
- **Stakes**: The rule keeps the loudest type for brand pages. A detail page at Display size is the clearest single change in the new look, and it uses the AECi serif the owner asked for. Not linted.
- **Size**: S
- **Recommendation**: override. Extend Display to the H1 of product, vendor and pair detail pages, still once per page.

### 8. Large serif figures stack up, and the score is not Forest
- **Rule**: No hero-metric template, and the score is one Forest headline-scale figure. DESIGN.md §6: "**Don't** use the hero-metric template (big number + small label + supporting stats + gradient accent)." Score Display (lines 865 to 869): "Source Serif 4 600, headline scale ... Forest color." The home has "the home's only figure row" (line 526).
- **New design**: Page 6 alone carries `.hr-n` 46px, `.f-stat .big` 80px, `.count-badge .n` 64px and `.score .bn b` 84px in ink, not Forest. Page 5 adds `.int-stat .big` 76px. Page 8 adds `.icount b` 34px.
- **Stakes**: The rule stops numbers from posing as proof. Four or five giant figures per page read as a SaaS metrics page. Not linted.
- **Size**: M
- **Recommendation**: combine. Keep one large figure per band, in Forest, at the Score Display role. Demote the rest to inline text.

### 9. The type ramp: off-scale sizes, heavy weights and small serif
- **Rule**: Text uses the named roles. Title is 1.5rem for section H2s. Label is Atkinson 600 at 13px. Taxonomy chips are 500. Bold 700 is "only for inline emphasis or product-surface affordances" (line 248). Caption exists "so components stop improvising this size" (line 251). The Serif-Floor Rule (line 257): "Source Serif 4 never renders below 1.125rem / 18px."
- **New design**: All pages. `.h2 { font-size: clamp(32px, 3.3vw, 48px) }`. Sizes of 12.5, 13.5, 14.5, 15.5, 16.5, 17.5, 19, 21, 26 and 27px. Buttons, chips, tabs and nav at 700 and 14.5 to 15.5px. Serif below the floor in `.tprod b` (16.5px) and `.order .body b` (17px).
- **Stakes**: The roles keep every page in one voice and stop each component inventing a size. The mock's bigger H2 and heavier labels are part of its confidence. Not linted.
- **Size**: L
- **Recommendation**: combine. Add a larger section-H2 role (about 2.25rem) and a lede role (about 1.1875rem) to DESIGN.md, snap everything else to the existing roles, keep labels at 600, and keep the serif floor.

### 10. Eyebrows and microheadings are not overlines
- **Rule**: Eyebrows, kickers and sidebar microheadings use the overline role: uppercase, 12px, 600, +0.08em, text secondary or Forest. DESIGN.md line 250 and the Sentence-Case Rule (line 255): "Eyebrows, kickers, and sidebar microheadings are overlines."
- **New design**: All pages. `.kicker` is sentence case, 14px, 700, Clay deep, with an icon. `.f-h`, `.facet h4` and `.rail h4` are sentence case 12.5 to 13px 700 with +0.03em. The menu's `.cm-ov` is uppercase but 11px with +0.14em in `--ink-3`, a second overline spec.
- **Stakes**: The rule gives the page one print-kicker voice and the only sanctioned uppercase. The mock has three microheading styles. Not linted.
- **Size**: M
- **Recommendation**: adopt. Use `.aec-overline` for every kicker and microheading, including the menu's, and drop the Clay-deep kicker icons.

## Surfaces, elevation and shape

### 11. Shadows separate surfaces, and borders are almost gone
- **Rule**: Borders separate surfaces and shadows are only for modals, dropdowns and focus rings. DESIGN.md §4 "The Borders-Not-Shadows Rule" (line 293): "Box-shadows on these elements are forbidden." §6 "Do use 0.5px borders to separate surfaces." The two shadow recipes use pure black only (line 289).
- **New design**: All pages. `--sh-1/2/3` sit on `.card`, `.facts`, `.panel`, `.use-card`, `.rv`, `.score`, `.btn-primary`, `.btn-hero`, `.field`, `.seg`, `.obj`, `.linkbtn` and `.snl`. They are tinted (`rgba(var(--shadow-tint), .42)` with a green tint). Almost nothing has a border.
- **Stakes**: The rule exists because "rounded rectangle with generic drop shadow" is an AI-design tell and does not match an editorial reference. The floating facts card and lifted cards are much of the mock's appeal. A tinted shadow fails `pnpm lint` (AECI-597 colour-function guard).
- **Size**: L
- **Recommendation**: combine. Add one card-elevation token in pure-black `rgb(0 0 0 / α)` for top-level floating surfaces (the facts card and entity cards). Keep borders, not shadows, on buttons, chips, inputs and tabs.

### 12. Radii well past the scale, and pill-shaped actions
- **Rule**: The radius scale is 4, 8, 12 and 16px. Buttons are 8px and "Never pill-shaped (`rounded.pill`) for primary actions" (line 370). Cards are 12px. Chips are 4px (`rounded.sm`, lines 749 and 859). A rounded-full chip is "**Admin console only**" (line 317).
- **New design**: All pages. Buttons 12 to 14px (`.btn`). Cards 22 to 26px (`.card`, `.facts`, `.panel`, `.score`). The menu panel's bottom corners are 30px. Pills on "Sign in", the header search, nav hover, every chip and the section-nav count.
- **Stakes**: The rule keeps shapes calm and print-like. Pill actions "read as social-media UI". The soft large radii are central to the new look. Not linted.
- **Size**: L
- **Recommendation**: combine. Add a 20 to 24px card radius and a 12px control radius to the scale, and let public chips be pills. Keep primary actions off the pill, so "Sign in" becomes a rounded rectangle.

### 13. Gradients, a noise texture and frosted glass
- **Rule**: No gradient backgrounds for impact and no decorative glassmorphism. DESIGN.md §6: "**Don't** use the AI color palette: ... gradient backgrounds for impact." "**Don't** use glassmorphism (blur, glass cards, glow borders) decoratively." Score Display range marker: "no fill, no gradient, no animation" (line 869). `shared/section-nav/section-nav.ts` records that a blurred sticky nav was removed because text showed through.
- **New design**: `.hero::before` two radial gradients and `.hero::after` an SVG noise overlay (all pages). Radial gradients on `.know` (page 8) and `.cm-card`. Gradient fills on `.scale .gap` (page 6) and `.meter i` (page 5). `.secnav.stuck { backdrop-filter: blur(12px) }` over a 94% surface (pages 6 to 8).
- **Stakes**: The rule keeps the site out of the AI-startup cohort. The gradients are subtle, but the noise and blur add nothing a solid Forest does not. Not linted.
- **Size**: S
- **Recommendation**: adopt. Use solid Forest and solid surfaces, and a solid sticky bar, as the section-nav history already decided.

### 14. Cards nest inside cards, including the vendor reply
- **Rule**: "**Don't** nest cards inside cards" (§6). Vendor replies sit "inside that article but below the review card, never inside it ... `--surface-sunken` with a full `border-default` border ... no side stripe" (line 559).
- **New design**: `.rates` boxes inside product cards (page 5), `.rv-scores` tiles and `.reply` and `.upd` panels inside each `.rv` review card (pages 6 to 8), `.vnote` boxes inside `.side` (page 8), `.reach` inside `.ifill` (pages 6, 7), and the Bone `.f-stat` panel inside `.facts`.
- **Stakes**: The rule keeps hierarchy flat and readable. Nested tinted boxes are the main source of visual noise in the mock. Not linted.
- **Size**: M
- **Recommendation**: adopt. Flatten with hairlines and spacing, and move the vendor reply below the review card as shipped.

### 15. Side-stripe accents
- **Rule**: "**Don't** use `border-left` or `border-right` greater than 1px as a colored accent stripe on cards ... **Side-stripe borders are banned**" (§6).
- **New design**: Page 6 to 8 `.score::before { width: 7px; background: var(--meter-a) }`. `.rs` and `.rv-empty .two span` use `box-shadow: inset 3px 0 0 var(--meter-a)` and `var(--meter-b)`.
- **Stakes**: Side stripes are a stock dashboard tell. The stripe is doing real work here: it codes quality versus onboarding. Not linted.
- **Size**: S
- **Recommendation**: adopt. Carry the two-score coding with the "Score one" and "Score two" label colour or a small leading dot, not a stripe.

## Layout and density

### 16. The detail page drops DetailLayout
- **Rule**: Detail pages use `DetailLayout`: "`lg:` two-column (2fr main / 1fr metadata) with sticky-top metadata", a hero "bordered below", and body sections in `space-y-12` (lines 1100 to 1106). Body-column tables are checked against 608px and kept under 38rem (line 1102). Resources are "up to two inline Forest text links" in the sidebar (line 494). Company facts are a sidebar panel on the vendor page (line 542).
- **New design**: Pages 6 to 8. No sidebar. A dark hero, then `.facts-shell` pulls a four-column facts card up over the hero (`margin-top: -96px`), then full-width bands. Resources become icon tiles with a trailing `↗`. The comparison table asks for `min-width: 1240px` (page 6) and 1020px (page 7), with zebra rows and a Forest-filled selected column.
- **Stakes**: The shell keeps the vendor, product and pair pages built one way, and the 608px figure stops tables scrolling inside a narrow well. Moving to full-width bands is the core of the new design and removes the 608px constraint. Pinned only by the layout shell itself and per-page specs.
- **Size**: L
- **Recommendation**: override. Rewrite DetailLayout as a band shell with a facts strip, and set a new table width check against the full 1216px column.

### 17. Spacing off the 4pt scale
- **Rule**: "**Do** vary spacing for visual rhythm (4pt scale: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96)" (§6). The canvas uses `py-8 md:py-12` (line 1098).
- **New design**: All pages. `.band { padding: 104px 0 96px }`, gaps of 22, 26, 28, 30, 34, 38 and 46px, `--gut: 56px`.
- **Stakes**: The scale keeps rhythm consistent across components built by different people. The values are close to the scale, so snapping them costs little. Not linted.
- **Size**: M
- **Recommendation**: adopt. Snap to the scale (22 to 24, 26 and 28 to 24 or 32, 104 to 96). The look survives.

### 18. Uniform card grids
- **Rule**: "**Don't** use identical card grids (3×3 or 4-up cards each with icon + heading + 8 words). Vary the layout, vary card sizes, break the grid intentionally" (§6). Product grids are 1, 2, 3 columns with a wide lead card (line 508). PRODUCT.md anti-references name the "equal-weight feature grid".
- **New design**: `.cards { grid-template-columns: repeat(4, ...) }` for integrations (pages 5, 6), `.rel` 4-up for similar products, `.ext-grid` 3-up, `.rv-list` 3-up, and `.use-row` 3-up of identical cards.
- **Stakes**: The rule keeps the catalogue from reading like G2 or Capterra. Page 7's grouped 3-up grid with group headers already breaks the rhythm. Not linted.
- **Size**: M
- **Recommendation**: combine. Keep cards, but cap at three columns and break each grid with a group header or a wider lead card, as page 7 does.

### 19. Charts and meters on public pages
- **Rule**: Multi-series data visualisation is "operator console only" (§5 heading, line 871). The score range marker is "a single vertical mark on a 1-10 axis with no fill, no gradient, no animation" (line 869). "**Don't** use sparklines as decoration" (§6).
- **New design**: Page 6 "On the same scale" (`.scale`, two pins and a gradient gap bar). Page 5 ledger meters (`.meter i` with gradients). Page 7 evidence bars (`.evb .bar`). Page 8 category bars (`.bars .bar`). Page 7 `.loadbar .meter`.
- **Stakes**: The rule keeps public pages honest: a number in text, never a decoration that looks like analysis. The bars carry real numbers printed beside them, which meets the "never the only representation" rule. Not linted.
- **Size**: M
- **Recommendation**: combine. Allow one public bar-meter pattern: single-hue Forest, no gradient, the number always printed. Rebuild the score scale to the Score Display range-marker spec.

## Components

### 20. Button anatomy
- **Rule**: Buttons use the label role (600, 13px), 8px radius, `spacing.3 spacing.5` padding. Secondary has a 0.5px border and sinks to sunken on hover. "No transform, no scale, no shadow on hover" (lines 370 to 374).
- **New design**: All pages. `.btn { min-height: 48px; border-radius: 14px; font-weight: 700; font-size: 15.5px }`. `.btn-soft` and `.linkbtn` are borderless fills. `.btn-primary` and `.btn-hero` carry shadows.
- **Stakes**: The rule keeps buttons calm and consistent everywhere. The 44 to 48px height is a real target-size gain. Not linted.
- **Size**: L
- **Recommendation**: combine. Take the 44px minimum height and a 12px radius. Keep the label role weight, the bordered secondary and no shadow.

### 21. The Link Treatment Rule
- **Rule**: "**Accent is spent on the primary action and nowhere else**" and there is one primary action per surface, "Visit website" (lines 314 and 320). Standalone links are `text-xs`, text secondary, underlined. In-text links are Forest and permanently underlined.
- **New design**: Bold Forest links without underline across all pages: `.f-learn a`, `.scope a`, `.inline-link`, `.cm-all` ("See all categories"), `.order summary`, `.card .go`, `.see-all a`, `.f-stat .know-link`. Page 6 has three filled primaries in view at once: "Visit website" (Clay), "Write a review" (Forest, in the sticky bar) and the review panel's "Write a review".
- **Stakes**: The rule keeps the reader's one task obvious and keeps link styling tied to its role (AECI-980). Not linted.
- **Size**: M
- **Recommendation**: adopt. Use the standalone-link recipe for "See all" and similar links, the in-text recipe with underline inside sentences, and keep one filled primary per view.

### 22. Many chip vocabularies
- **Rule**: "**One chip spec (AECI-841)**": `px-2.5 py-1`, 0.75rem, `font-medium`, `rounded.sm`, 29px tall. One second, denser in-row badge is allowed. TaxonomyBadge is bordered, `surface-raised`, 4px, 500 at 13px (lines 747 to 768, 859 to 861). "If you are writing a chip and reaching for different padding, you are making a second chip vocabulary."
- **New design**: At least seven chip styles: `.tagchip` (Forest-soft pill with icon), `.aud` (sunken pill with icon), `.mini`, `.mini.ct` (Clay-soft), `.obj` (shadowed pill with count), `.cat` (inset ring), `.inside` and `.score .sh .tag`. Weights 600 to 700, all pills, mostly with icons.
- **Stakes**: The rule exists because mixed chip metrics broke rows twice. Seven vocabularies will break them again. Not linted.
- **Size**: L
- **Recommendation**: combine. Define one public pill chip (neutral, optional leading icon) and one dense in-row variant, rewrite the chip section around them, and drop the Clay-soft category chip.

### 23. Inputs
- **Rule**: Inputs have a 1px `border-input` border, `rounded.md`, and a focus that is "a clean border swap ... No glow halo." Error is a `status-error` border with label and icon (lines 727 to 729). The border colour is load-bearing for WCAG 1.4.11.
- **New design**: Pages 5 to 8. `.field { border: 0; border-radius: 14 to 15px; box-shadow: var(--sh-1) }`. Focus adds a 4px tinted halo. Error uses Clay deep and a Clay-soft fill (`.field[aria-invalid="true"]`).
- **Stakes**: A borderless input can fail the 3:1 boundary that `border-input` exists to meet, and Clay errors break "Error ... Success states use Forest; warning states use Clay deep" (line 212). Not linted.
- **Size**: M
- **Recommendation**: adopt. Keep `.aec-field-control` and the red error, with the new 12px radius from entry 12.

### 24. The integrations section
- **Rule**: Product-detail integrations render as Disclosure group cards, one per counterpart, open by default (lines 386 to 413). The List filter sits in the section heading row (lines 422 to 452). Sort uses `<aec-listing-sort-select>`, an Aria combobox (line 489), and a cards and table toggle is `<aec-listing-view-toggle>`.
- **New design**: Pages 5 to 7. A Bone "deck" holds a search box, a direction segmented control, data-object filter chips with counts and a "+N more" toggle, partner-category chips, and a cards and table toggle. Page 7 adds grouping by partner category, a sticky jump rail with evidence bars, a per-group "Show 9 more" peek, and a native `<select>` sort.
- **Stakes**: The shipped pattern keeps both integration sections alike and crawlable (panel content always in the DOM). The deck is a real improvement for a 58-row product. A native select for sort contradicts the AECI-1486 ruling of one sort control everywhere. Not linted.
- **Size**: L
- **Recommendation**: combine. Build the deck from shipped parts (List filter, view toggle, listing sort select) and keep every row in SSR HTML. Take the grouping and jump rail to Chris as a Same-Behavior decision (entry 45).

### 25. A bare zero
- **Rule**: A zero count is never a bare "0". IntegrationStat "At zero ... renders 'Not yet connected' in `text-secondary`, never a bare `0`" (line 513). The glance band: "**A zero is never a bare 0**" (line 655).
- **New design**: Page 8 `.f-stat .big.zero` prints an 80px Forest "0" over "integrations on record". The section-nav count reads "0".
- **Stakes**: The rule stops a zero reading like a verdict on the product. Pinned by `product-card.component.spec.ts` for the card, not for this new figure.
- **Size**: S
- **Recommendation**: adopt. Show a sentence ("None on record yet") in place of the figure.

## Navigation and menus

### 26. The primary row's contents
- **Rule**: "**The row:** `Home · Products · Categories · Trades · Audiences · Phases`" (line 944). "**The Overflow Rule.** The primary row is width-budgeted, **public-only**, and closed." A new secondary destination "goes to the footer". A new primary destination "is a re-measure at 1024px" (lines 968 to 971). Methodology and For vendors are footer-only (line 1067).
- **New design**: All pages. The row is `Browse · How we rank · For vendors · Sign in`. Home and Products leave the row. The four facets fold into Browse.
- **Stakes**: The rule protects the header width budget and keeps the taxonomy as the directory's spine. The new row is narrower, so it fits better, but it promotes two footer-only pages. Pinned by `site-header.component.spec.ts` and `nav-menu.component.spec.ts`.
- **Size**: M
- **Recommendation**: combine. Accept Browse in place of the four facets. Treat "How we rank" and "For vendors" as new primary destinations that need the 1024px re-measure and a ruling, and keep Products reachable from the row.

### 27. Four flyouts become one mega-menu
- **Rule**: "**All four dropdowns in this row behave identically**: hover opens, mouseleave closes, Escape closes and returns focus to the trigger, and focus leaving the host closes" on the shared `layout/nav-disclosure.ts` base (line 946). Panels use the dropdown shadow (line 286). Panel type: column title 600 14px, group label overline 12px, destination 400 14px, "Pin the weight at the list component" (line 964).
- **New design**: All pages. One full-width `.cm` region with five columns, counts under every item and 24px serif "key categories". `catmenu.js` reimplements the contract with a 70ms open delay and a 260ms close grace, adds a page scrim (`.cm-scrim`, 50% tint), and opens with a clip-path wipe. Destinations are 500 at 15.5px. Group labels are 11px at +0.14em.
- **Stakes**: The rule keeps every header dropdown behaving the same and on one base. The mock honours the keyboard and Safari-press behaviour, which is good, but it lives outside `NavDisclosure`, and the scrim makes a nav disclosure act like a modal. Pinned by `nav-flyout-trigger.component.spec.ts` and `nav-flyout-list.component.spec.ts`.
- **Size**: M
- **Recommendation**: combine. Keep the one Browse panel and its column layout, but build it on `NavDisclosure`. Drop the scrim. If the hover grace delay is wanted, add it to the base so every dropdown gets it. Pin destinations at 400.

### 28. Active-state indicators
- **Rule**: The active route is Forest text with a 2px Forest bottom border on the element, `-mb-px border-b-2` (line 941). The in-page section nav marks the current link Forest and bold over a hairline (`shared/section-nav/section-nav.ts`).
- **New design**: `.cm-trigger::after` draws a 3px Clay bar under "Browse". The sticky section nav (`.snl`, pages 6 to 8) and the jump rail (page 7) mark the current item with a solid Forest pill.
- **Stakes**: The rule keeps "you are here" one treatment across router tabs, search tabs and the portal. Pinned by `section-nav.component.spec.ts` for the attribute, not the colour.
- **Size**: S
- **Recommendation**: combine. Use the 2px underline everywhere, in Bone on the Forest header and Forest on light grounds. Let the section nav keep its pill container but mark the current item with the underline.

### 29. The header: search, breakpoint and sign-in
- **Rule**: "The header search input appears at `xl`" and three classes move together if that changes (lines 950 and 963). The placeholder is "Search directory" (line 487). The sign-in control is a Forest `rounded-md` button (`site-header.ts`).
- **New design**: All pages. A 460px pill search link shows from 1040px, reads "Search products, vendors, data objects" and shows a `/` keyboard shortcut (`.search kbd`). "Sign in" is a Bone pill on Forest.
- **Stakes**: The breakpoint was measured (AECI-669) and a link styled as a field is not a field. A `/` shortcut has no existing rule and needs a focus-handling decision. Pinned by `site-header.component.spec.ts` and `search-trigger.component.spec.ts`.
- **Size**: M
- **Recommendation**: combine. Keep the real search field at `xl` and the icon trigger below it, keep "Search directory" until search indexes data objects, and write a rule for the `/` shortcut before shipping it.

### 30. The mobile menu
- **Rule**: "**Mobile:** collapses into a CDK-overlay dropdown with focus trap. No hamburger-as-mystery: the toggle is labeled" (line 945).
- **New design**: All pages below 760px. `.menu-btn` is an icon-only button with `aria-label="Menu"` and no visible label. `.mm` is an absolute panel with a scrim and no focus trap.
- **Stakes**: The rule protects keyboard and screen-reader users and first-time visitors. Pinned by `nav-menu.component.spec.ts`.
- **Size**: S
- **Recommendation**: adopt. Keep the labelled toggle and the CDK overlay, and restyle the panel rows to the new serif look.

### 31. The breadcrumb separator
- **Rule**: The public breadcrumb uses "the same `›` separator marked `aria-hidden`" (line 608; `products/product-detail.ts` line 127).
- **New design**: All pages. `.crumbs .sep` renders `/`.
- **Stakes**: The rule keeps one breadcrumb grammar from the public pages to the admin console. The docs top bar uses a slash, so either way one place changes. Not linted.
- **Size**: S
- **Recommendation**: adopt. Keep `›` on public and console pages.

### 32. The footer
- **Rule**: The footer is a white `surface-base` ground with four labelled nav columns, Directory, Help, Legal and Company. "**Column labels are overlines**; links are `text-secondary` rising to `text-primary`" (lines 1051 to 1079).
- **New design**: All pages. A dark Forest footer (`--foot-bg: #15291F`). Columns are Browse, How we work, Company and Legal, with Vendors, Data objects, Attestations and Cookies added and the Help column gone. Labels are sentence-case 14px 700.
- **Stakes**: The footer is the only server-rendered home of the taxonomy for crawlers and of Methodology, Updates and Roadmap. `site-footer.component.spec.ts` pins the columns, so a quiet column change fails a test.
- **Size**: M
- **Recommendation**: combine. Accept the Forest ground under entry 1, and keep the four shipped columns and overline labels.

## Iconography and imagery

### 33. Arrows used for "go somewhere"
- **Rule**: "**The Arrow Rule** (AECI-919). **An arrow glyph means data-flow direction and nothing else.**" A click affordance uses Lucide `chevron-right` (lines 295 to 302).
- **New design**: `→` in "It does exist" (pages 5, 8), "See all categories" and the other menu links, `.card .go .arr` circles on every integration card, "All construction accounting products" (page 8), and `↓` after "reviews" in the hero rating panel (pages 6 to 8). The same cards also carry real direction arrows ("Revu sends").
- **Stakes**: The rule exists because a nav arrow next to a direction arrow misled readers on the pair page. These cards repeat that exact collision. Not linted.
- **Size**: S
- **Recommendation**: adopt. Use `chevron-right` for every navigation affordance and keep arrows for direction only.

### 34. Icon density, the icon set and logo tiles
- **Rule**: "Lucide icons exclusively" (§6, PRODUCT.md, BRAND_GUIDELINES.md §7). A company mark is a rectangle with `LogoOrInitial` tokens (line 1001). The detail header logo is 64px (line 536). PRODUCT.md "Earned attention": "Hierarchy through scale and weight contrast, not color and decoration."
- **New design**: All pages. A hand-built SVG icon map (`ICONS` in each page's script) sits on nearly every heading, chip, label and list row. Logo marks are 22%-radius squircles with a shadow (`.mark`), 104px in the hero (`.hero-mark`).
- **Stakes**: Lucide-only keeps glyphs consistent with the shipped app. An icon on every element stops icons meaning anything. Not linted.
- **Size**: M
- **Recommendation**: combine. Map every glyph to its Lucide equivalent, keep icons on facet headings and data objects, drop them from chips and list labels, and allow a larger hero logo with a border, not a shadow.

### 35. The hero diagram (no existing rule)
- **Rule**: No existing rule. The nearest guidance is BRAND_GUIDELINES.md §7: "diagrams, screenshots, and original photography only", and the Arrow Rule's ban on separator glyphs between a pair (line 301).
- **New design**: Page 6 and 7 draw a "constellation" of up to eight partner logos on spokes with data-object beads around the product. Page 5 draws two tilted product tiles joined by a ribbon. Page 8 draws empty dashed slots. All animate in.
- **Stakes**: It is the most distinctive element of the new look and it shows real data. It needs rules for what it may show (real integrations only, no implied ranking by position), how it reads without JS and to a screen reader, and what it does at zero.
- **Size**: M
- **Recommendation**: override. Write a "pair and product diagram" rule into DESIGN.md: real records only, static in SSR, a text equivalent, no ranking implied by position.

## Motion

### 36. Durations and decorative animation
- **Rule**: "Default durations: 120ms (hover), 180ms (default), 280ms (page transitions)" (§6, PRODUCT.md). BRAND_GUIDELINES.md §7: "Motion has a purpose ... Decorative animation is noise."
- **New design**: Transitions of 200, 250, 300, 420, 450 and 600ms. Cards and table rows `rise` with a 30 to 45ms stagger on render. The hero ring draws over 1.4s. `.halo` "breathes" on an infinite 4.5s loop. The menu wipes open with clip-path and staggers its columns. `.need.bump` bounces the counter.
- **Stakes**: The rule keeps motion as feedback, not show. An infinite loop on a reading page is a distraction. Entrance animation on SSR content replays on hydration. Reduced motion is honoured throughout, which is good. Not linted.
- **Size**: M
- **Recommendation**: combine. Move to the 120, 180 and 280ms set, keep one entrance for the hero diagram, and drop the infinite loop, the per-card stagger and the bounce.

### 37. Hover and press transforms
- **Rule**: Buttons: "No transform, no scale, no shadow on hover" (line 371). Cards: "no fill change, no shadow, no scale" on hover (line 383).
- **New design**: `.card:hover { transform: translateY(-4px) }`, `.xt:hover` and `.obj:hover` lift, `.btn:active { transform: translateY(1px) scale(.98) }`, `.cat:active` and `.peek:active` scale down.
- **Stakes**: The rule keeps the page still under the pointer, in line with editorial restraint. Lift on hover is the main source of a "SaaS app" feel. Not linted.
- **Size**: M
- **Recommendation**: adopt. Use the border-strong hover for cards and a colour shift for buttons.

### 38. Global smooth scrolling
- **Rule**: CLAUDE.md: "Router scroll restoration is already solved; don't re-solve it", across `withInMemoryScrolling`, `ScrollBehaviorManager` and related pieces.
- **New design**: All pages. `html { scroll-behavior: smooth }`, plus scroll-margin rules for the sticky bar.
- **Stakes**: A global smooth scroll changes how Back and fragment restoration land, which the scroll e2e suites guard. Pinned by the scroll-restoration e2e specs.
- **Size**: S
- **Recommendation**: adopt. Leave scroll behaviour to the existing router setup.

## Trust and brand rules

### 39. A public "claimed" label
- **Rule**: "Unclaimed note ... It is never a chip, a badge or a header, and no public label says Claimed" (line 534, AECI-1618, ADR 0051, counsel wording). No account or plan label on public pages (line 815).
- **New design**: Pages 6 and 7 show a hero status pill, "Listing claimed by Bluebeam", with a Clay pip, and a "Listing claimed by …" caption in the facts card. Page 5 compares "Claimed by {vendor}" against "Not claimed" in the ledger.
- **Stakes**: The rule exists because a "claimed" mark reads as endorsement and marks who engaged with us. It came out of the counsel review, so changing it is a legal decision, not a design one. Pinned by `unclaimed-note.component.spec.ts` for the note.
- **Size**: S
- **Recommendation**: adopt. Remove the claimed label and keep the unclaimed note, which page 8 already renders correctly.

### 40. The maintenance marker and field captions
- **Rule**: "the maintenance chip uses exactly two labels everywhere, 'AEC Integrations maintained' and 'Vendor maintained'. ... The company is never in the visible label." It has "**no dot**, no icon" (lines 777 to 787). The field caption "must never become" a badge and has "no fill, no border, no chip, no icon" (line 851).
- **New design**: Page 8 hero pill "Maintained by AEC Integrations" with a Clay pencil pip. Pages 6 and 7 caption "Maintained by Bluebeam" with a pencil icon under Categories.
- **Stakes**: The wording is a ruling (2026-09-28) about not attributing work to a company the page cannot prove. An icon turns attribution into a status light. Pinned by `maintenance-marker.component.spec.ts` and `field-caption.component.spec.ts`.
- **Size**: S
- **Recommendation**: adopt. Use the two marker labels on the neutral chip, and plain-text captions.

### 41. The agreement states
- **Rule**: The agreement badge has four states with a tonal ladder. "`single_source` shares the neutral chip with `unverified` on purpose ... must never borrow the affirmative Forest treatment." "`confirmed` is the only badge that earns the wash" (lines 816 to 829).
- **New design**: Pages 5 to 7. `.att` renders "Confirmed by both companies", "Confirmed by Sage" and "Confirmed by Bluebeam" in the same bold Forest text with the same link icon. "Listed by AEC Integrations" gets an info icon. None is a chip. Page 7 adds aggregate counts ("5 confirmed by both companies") and evidence bars.
- **Stakes**: The rule stops a one-sided claim looking like an agreed one, which is the core trust promise of the product. Pinned by `agreement-badge.component.spec.ts`.
- **Size**: M
- **Recommendation**: adopt. Render `<aec-agreement-badge>` on the cards. The aggregate counts can stay if they use the same state words.

### 42. The wordmark
- **Rule**: The header and footer wordmark is an `<img>` of `apps/web/public/branding/wordmark.svg`, outlined Atkinson letters with the connector mark (BRAND_GUIDELINES.md §8). Logo changes go through `branding/logo-construction.md`.
- **New design**: All pages. `.wordmark` sets "AEC Integrations" as live Source Serif 4 text beside an invented Clay "seal" glyph.
- **Stakes**: The rule keeps one recognisable mark that matches the OAuth logo, OG cards and email banner. A new mark is a rebrand. Not linted.
- **Size**: S
- **Recommendation**: adopt. Use the shipped wordmark, in its Bone variant on the Forest header (the email banner already has Bone type).

### 43. Public demand signals (no existing rule)
- **Rule**: No existing rule. The nearest are PRODUCT.md "Transparent by default" and the Badges rule that no visual treatment may signal "promoted, sponsored, or verified".
- **New design**: Page 5. "Looked up 34 times in the last 90 days" with a note that automated visits are excluded. An "I need this too" counter (12). A "Watch this pair" email field. Page 8 "Know of one?" prompt.
- **Stakes**: These are public numbers about traffic and demand. Production page views are mostly bot traffic, so a look-up count is only as honest as the classifier. A public demand counter also invites gaming. The correction prompt is low risk.
- **Size**: M
- **Recommendation**: combine. Ship "Know of one?" now. Write a rule before any public count ships, covering the source, the bot exclusion and a floor (the mock already hides the count below 10).

## Process rules

### 44. The Anchor-Site Rule and the Mobbin reference
- **Rule**: "When a surface uses a Mobbin reference site as its theme, components for that surface come from the *same* Mobbin site. ... Record the anchor site with the surface" (line 231). CLAUDE.md design checklist step 2. The site chrome anchor is Stripe (line 1051). The catalog anchor is Faire (line 502).
- **New design**: No anchor is recorded. The header, footer and detail pages depart from the Stripe chrome and the Faire catalog.
- **Stakes**: The rule keeps AECi reading as one publication, not a mashup. A precedent exists for an in-repo mock-up as the anchor (the Free plan surfaces, line 659: "Anchor: the in-repo mockup"). Not linted.
- **Size**: S
- **Recommendation**: adopt. Record these mock-ups as the anchor for the new language, and use Mobbin only for components the mock-ups do not cover.

### 45. The Same-Behavior Rule
- **Rule**: "A pattern behaves the same way on every page that has it. ... Filters live in `<aec-facet-panel>`. Sort sits in the toolbar row ... Empty, loading and error states read alike. ... Anyone building or reviewing a page that departs from an existing pattern stops and tells Chris before shipping" (line 364).
- **New design**: The integrations deck filters outside the facet panel, sorts with a native select, pages with a per-group "Show 9 more" and a "Load more" bar with a meter, and shows illustrated Bone empty states with a call to action. None of these departures is recorded.
- **Stakes**: The rule exists because `/search` shipped a different paginator and nobody raised it. If the new look goes site-wide, each departure either becomes the pattern everywhere or stays a recorded exception. Not linted.
- **Size**: M
- **Recommendation**: combine. List each departure for Chris with the page that sets the current pattern. Where he keeps the new one, record it in DESIGN.md and plan the change on the other pages.
