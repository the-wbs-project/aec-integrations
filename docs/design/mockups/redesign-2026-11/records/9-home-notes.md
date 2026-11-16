# Mock-up 9: the home page, decision note (AECI-1789)

**Legal impact:** none. A design artefact. It adds no promise about ranking, reviews or data. Question 3 asks about two labels that describe orders the site already uses.

The home page keeps its four bands and its copy. It moves into the new language. The hero stays on Bone, which is now the page's only Bone band. The closing call to action moves off Bone onto white. The page's one Forest feature card is the "What we do instead" block. Chris needs to answer seven questions before AECI-1792 builds it.

- Mock-up: `mockups/9-home.html`. Open it in a browser. The "Options" control switches the alternates. Its defaults are my recommendation, not decisions.
- Screenshots: `screens/9-home-1440.png`, `screens/9-home-390.png`, and one 1440 shot per alternate (`9-home-trust-white`, `9-home-trust-vendor`, `9-home-h1-headline`, `9-home-popular-categories`, `9-home-popular-reserved`).
- Baseline: `baseline/home-1440.png` and `baseline/home-390.png` (AECI-1817).

## 1. What changed from today's home, and why

Today's page, from the baseline and `apps/web/src/app/home/`:

| Band | Today | Mock-up 9 | Why |
| -- | -- | -- | -- |
| Header | White, six links, Sign in | The shipped Forest header: wordmark, search pill, Browse, How we rank, For vendors, Sign in | Copied from `layout/site-header.ts`. Not redesigned. |
| 1. Hero | Bone. Display h1 that renders at 40px. Pair finder in a bordered white panel. Credibility row at the bottom. | Bone, now the page's one Bone band. h1 at `--t-display`, 72px at 1440. Pair finder is a white card with the card shadow. Credibility row kept. | One Bone band per page (clash 2). The pair finder is the page's main tool, so it takes the card. |
| "Popular:" row | Appears after load when it falls back to categories. Moves the page (AECI-1862). | Its height is reserved: two lines from 640px, three below. Its label states its order. | Stops the layout shift. See question 3. |
| Credibility counts | Serif at 16px | Sans 600 at 16px, Forest | Serif never sits below 20px (the Serif-Floor Rule). Today's row breaks it. |
| 2. Browse | Four rows, square-ish chips | Four rows, pill chips, and each row states its order under "View all" | Chips are pills (clash 12). Every list states its order (no pay-for-placement). |
| 3. The argument | Prose in a 3xl column with a blank right half. Three figures at 30px. Citation in a hover tooltip. Three bordered cards. | Heading left, prose right. Figures at `--t-24`. Citation printed under each figure. "What we do instead" is the Forest feature card. | A narrow column with a blank right half is a known defect. Clash 8 allows one large figure per band (question 4). A citation readers cannot see without hovering is weak proof for a trust claim. |
| 4. Closing CTA | Bone band, one bordered box with two panes | White band, one card with the card shadow, same two panes, same copy | Frees the Bone band for the hero. |
| Footer | Shipped dark Forest footer | The same, copied from `layout/site-footer.ts` | Not redesigned. |

The copy is unchanged except for three labels: "Most viewed, last 30 days:", "Largest categories:" and the order captions under each browse row. They are question 3 and question 5.

The structure from AECI-1554 stays. I found no reason to change the band order.

## 2. Departures from DESIGN.md and the rulings

Each departure is a question, below. None is built into the default without one.

1. **Display type on the home.** ADR 0056 replaced "Display on About, Home and vendor mastheads" with "Display sizes are allowed on detail pages". It does not say whether the home keeps Display. DESIGN.md §3 says the home hero "is re-decided in its own mock-up issue". Question 2.
2. **Three figures in one band.** Clash 8 says one large figure per band. The mock-up sets the three cited figures at `--t-24`, the sub-heading size, not the figure size. Question 4.
3. **Header and footer on the 1328px wrap.** DESIGN.md §4 lists this as Chris's call (AECI-1766). The brief for this mock-up put them on the wrap, so the mock-up does. Today they sit on the 7xl canvas, 8px to 16px off the bands. Question 6.

Two places where the docs are wrong:

- **DESIGN.md §2 says the home has a mid-page Forest trust pillars band.** It does not. `HomeTrustPillars` has been on `/about` only since AECI-273 (`home-direction.md`, "Trust band"). `home.ts` on the integration branch does not render it. The question the doc defers to this mock-up still applies to the home's own trust block, "What we do instead". Question 1 settles it. AECI-1792 should correct the DESIGN.md sentence.
- **The brief named "ruling A8" for the no-wide-lead-card rule.** I found no A8 in the records. DESIGN.md §4 has the rule as R3 (2026-11-14). The mock-up has no wide lead card. The closing CTA is one card with two panes at 2:1, not a grid item, so the rule does not reach it.

## 3. Questions for Chris

### Question 1. Which block is the page's one Forest feature card?

The home can carry one Forest feature card (clash 1). Today it carries none in the body.

- **A. "What we do instead" is the Forest card.** Bone ink, the three points in columns, and a Bone "How we rank" button that links to the existing page. Screenshot `9-home-1440.png`.
- **B. No Forest card.** Three white cards with the card shadow. Screenshot `9-home-trust-white-1440.png`.
- **C. The vendor call to action is the Forest card.** Bone "Claim or list your product" button. Screenshot `9-home-trust-vendor-1440.png`.
- A full-bleed Forest band, as on `/about`, is not offered. Clash 1 allows a card, never a mid-page band.

**Recommendation: A.** The no-pay-for-placement argument is the reason the site exists, so it should be the loudest block below the hero. It also sits mid-page, away from the Forest header and footer. C puts the vendor pitch above the reader's argument and stacks two Forest surfaces at the foot of the page.

### Question 2. How big is the hero headline?

- **A. Display, `--t-display`, 40 to 72px, weight 400.** The size the home was designed for. Screenshot `9-home-1440.png`.
- **B. Headline, `--t-fig`, 28 to 40px.** What renders today, because the unlayered `h1` rule beats the display class. Screenshot `9-home-h1-headline-1440.png`.

**Recommendation: A.** The home is the front door and has no product name to carry display type. It is still used once on the page. The build puts the size on an inner `<span>`, per the Unlayered-Heading Rule.

### Question 3. The "Popular:" row: its label and its fallback.

Today the row says "Popular:" for two different lists. One is the most-viewed products over 30 days. The fallback is the five largest categories, fetched in the browser. The fallback causes the layout shift in AECI-1862.

- **A. Name each order and serve both lists in the server HTML.** "Most viewed, last 30 days:" for products. "Largest categories:" for the fallback. The fallback reads the top five categories from the `browse` resolver, which is already in the cached page. Reserve the row's height as well.
- **B. Keep "Popular:" for both and only reserve the height.** The fallback stays browser-only.

**Recommendation: A.** Every list on the home must state its order, and "Popular" says nothing about how the list was made. Serving the fallback from the server removes the shift, because the content is there at first paint. The reserved height covers the case where both lists are empty. Both labels describe orders the site already uses, so I read the legal verdict as `none`. If "Most viewed" needs a line in "How ranking works", say so and AECI-1792 waits for the text.

The row is designed to hold its space: two lines of 24px from 640px, three lines below. Screenshot `9-home-popular-reserved-1440.png` outlines the reserved box.

### Question 4. The three cited figures and "one large figure per band".

- **A. Keep three figures at `--t-24`, Forest, in a hairline row.** They read as sub-headings, not as hero metrics.
- **B. Make one figure large and the other two inline text.**

**Recommendation: A.** The three figures carry equal weight in the argument. Ranking one above the others would be an editorial choice we have not made. The figures, descriptions and citations are copied exactly from `home-why.ts` (`docs/design/home-why-market-figures.md`).

### Question 5. Order captions on the browse rows.

Each row shows its order under "View all": "Most products first", "In project order" and "Roles chosen by AEC Integrations". The wording follows the Browse menu's footer line (`PLAN.md` §4.8).

- **A. Keep the captions.**
- **B. Drop them and state the orders once, under the heading.**

**Recommendation: A.** The rows use three different orders. One caption per row is clearer than a sentence the reader has to map back.

### Question 6. Do the header and footer move to the 1328px wrap?

- **A. Yes, on every page.** The mock-up does this. The left edges of the header, bands and footer line up.
- **B. No.** They stay on the 7xl canvas and sit 8px to 16px off the bands.

**Recommendation: A.** It is one shared constant, `BAND_WRAP_CLASS`. It is a shell change, so it belongs to the shell issue, not to AECI-1792.

### Question 7. Two search fields on the home at desktop width.

From 1024px the header search pill and the hero search both show.

- **A. Keep both.**
- **B. Hide the header pill on the home.**

**Recommendation: A.** The header must behave the same on every page (the Same-Behavior Rule). The hero field is the page's own tool.

## 4. How each list is ordered

Every list here uses an order the site already uses. Nothing is featured by plan.

| List | Order | Source |
| -- | -- | -- |
| Most viewed products | Most viewed over 30 days, among views the traffic classifier did not judge automated | `home.popular_products`, nightly (AECI-1572, AECI-1586) |
| Fallback categories | Most products first, top five | `topByCount` over `GET /api/taxonomy` |
| Category chips | Most products first, top 10 | `topByCount`, `TOP_N = 10` |
| Trade chips | Most products first, top 10, published trades only | `topByCount` with `isPublishedTrade` |
| Phase chips | Project order | `display_order` |
| Audience chips | A fixed role list chosen by AEC Integrations | `home-browse-block.ts`, `roles` |
| Footer links | Fixed | `site-footer.ts` |

## 5. Where the mock-up's data comes from

| Data | Source | Real? |
| -- | -- | -- |
| Copy | `apps/web/src/app/home/*.ts`, `site-header.ts`, `site-footer.ts` | Yes, verbatim |
| Market figures and citations | `home-why.ts` | Yes, verbatim |
| 445 products, 251 vendors | Review app, promoted products and their vendors, 2026-11-16 | Yes, as a stand-in for `stats_cache` |
| 3,162 integrations | Review app, all integration records | No. It counts records that were never promoted. The build reads `stats_cache`. |
| Category, phase and audience counts | Review app, promoted products per term, 2026-11-16 | Yes, as a stand-in for the live taxonomy |
| Trade chips | Real trade names | No. No read tool filters by trade, so membership, counts and order are placeholders. |
| Most viewed names and order | Real product names | No. View counts are not readable from here. |

Reviews and contributing firms are not shown. The credibility row drops a zero, and I could not read either figure.

## 6. Components AECI-1792 uses

All exist on the integration branch. No new component and no new token is needed.

| Need | Component |
| -- | -- |
| Header, footer, skip link | `SiteHeader`, `SiteFooter`, `SkipLink` (`layout/`) |
| Page wrap | `BAND_WRAP_CLASS` (`shared/band-wrap.ts`) |
| Hero ground | `aec-bone-band` (`shared/bone-band`), the page's one Bone band |
| Hero search and pair pickers | `SearchAutocomplete` (`search/search-autocomplete.ts`), behaviour unchanged |
| Buttons | `aecButton`: `primary`, `secondary`, `on-brand`, `on-brand-secondary` (`shared/button`) |
| Pair finder, idea cards, closing card | `aecCard` (`shared/card`), `base` look |
| Chips | `aec-taxonomy-badge` over `aec-chip` (`shared/taxonomy-badge`, `shared/chip`) |
| Icons | `aec-icon` with `search`, `scale`, `checklist`, `grid`, `chevron-down`, `menu` |
| Citation link | `aec-new-tab-icon` |
| Overlines and fields | `.aec-overline`, `.aec-field-control` (`styles.css`) |

The Forest feature card has no shared component. `aec-plan-cta-panel` is the only other one, and AECI-1802 rebuilds it. If Chris picks option A or C in question 1, AECI-1792 builds the card in `home-why.ts` or `home-closing-cta.ts` from tokens. A shared `aecCard` "brand" look would be cleaner, but that is a separate issue.

Specs that pin today's classes and will change: `home-hero.component.spec.ts`, `home-credibility-strip.component.spec.ts`, `home-why.component.spec.ts`, `home-closing-cta.component.spec.ts`.

## 7. Anchor

The anchor is the redesign mock-ups 5 to 8 (DESIGN.md §2, clash 44). The header, footer, buttons, cards, chips and fields come from them. A Mobbin search for a directory home with a search hero and a pair finder ran on 2026-11-16. It returned Canva, Givingli, Upwork, Fresha, Stripe and Dollar Shave Club. None was adopted, because the mock-ups already cover every component on the page. The old Faire anchor (`home-direction.md`) retires for the home once this is approved.

## 8. Verification

Run on 2026-11-16 with Playwright and axe-core 4.11 against the file, in every Options state.

| Width | Sideways scroll | Clipped elements | axe violations |
| -- | -- | -- | -- |
| 1440 | None | None | 0 |
| 1024 | None | None | 0 |
| 768 | None | None | 0 |
| 390 | None | None | 0 |

The page has one `h1`, then `h2` per band and `h3` and `h4` inside them. Buttons and fields are 44px high. Focus is a 3px ring, Forest on light grounds and Bone on Forest. No colour outside the `styles.css` tokens is used, except in the Options control, which is mock-up chrome.

## Summary

- Decide question 1: which block is the one Forest card. I recommend "What we do instead".
- Decide question 2: Display or Headline for the hero h1. I recommend Display.
- Decide question 3: name the two "Popular" orders and serve the fallback from the server. I recommend yes. It fixes AECI-1862.
- Decide questions 4 and 5: three figures at `--t-24`, and an order caption per browse row. I recommend both.
- Decide question 6: header and footer on the 1328px wrap. I recommend yes, done in the shell, not in AECI-1792.
- Confirm question 7: keep both search fields. I recommend yes.
- AECI-1792 corrects the DESIGN.md §2 sentence that places a trust pillars band on the home.
