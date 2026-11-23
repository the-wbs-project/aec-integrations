# Mock-ups 11 and 12: the vendor page and the pair page with integrations, decision note (AECI-1791)

**Legal impact:** none. A design artefact. Captions, agreement states and the Unclaimed note keep their approved wording. Question 4 asks about one new order caption.

Both pages move into the product page's language. The vendor page takes the band shell: a Forest hero, a facts card in place of the sidebar, and the page's one Bone band. The pair page takes mock-up 5's hero: the statement on the left, the two products on the right. No order changes, and no wording changes except the caption in question 4. Chris needs to answer section 3 before AECI-1797 and AECI-1798 build them.

- Mock-ups: `mockups/11-vendor.html` and `mockups/12-pair.html`. Open them in a browser. The "Options" control switches vendor, pair and states. Its defaults are my recommendation, not decisions.
- Both files are generated. The sources are `mockups/src/11-build.py`, `11.css`, `11-data.json` and `10-wordmark.svg`. Edit those and run `python3 -I 11-build.py` from `mockups/src`.
- Screenshots (archived outside the repo on 2026-11-23): `11-vendor-*.png` and `12-pair-*.png`. The list is in section 8.
- Baseline (archived outside the repo on 2026-11-23): `vendor-*.png` and `pair-with-integrations-*.png` (AECI-1817).

## 1. Scope

The issue asks for two files, `11-vendor.html` and `12-pair.html`. Both are here. The brief that started this work said "11-*". The issue is the contract, so the pair page is mock-up 12.

| File | Page | Options |
| -- | -- | -- |
| `11-vendor.html` | `/vendors/autodesk`, unclaimed, 19 products | Vendor: Autodesk or Rental Leak (claimed). Description: hero or About section. Products: table or cards. |
| `12-pair.html` | `/products/rental-leak/integrations/quickbooks-online` | Pair: Rental Leak or JobTread with QuickBooks Online. View: Detailed or Basic. States: production only, or illustrative. |

**Illustrative states.** Production has no confirmed, single-source, conflicting or refuted claim on any pair I read, no version data and no row caption. The "Illustrative" option draws all of them on the real pair so the build can see where each sits. A dark strip at the top of the page says the values are not production data. Every illustrative value is marked `ILLUSTRATIVE` in `11-build.py`.

**Not drawn.** The vendor page with no products: no live vendor has none. The build keeps today's sentence in the sunken empty panel from mock-up 10. Field captions on the vendor page: no vendor has a correction or an under-review field. They keep today's slots under the hero. A pair with two mechanisms: none of the pairs I read has more than one. The data-object chip that appears then is in the code path.

## 2. What changes from today, and why

### The vendor page

| Part | Today | Mock-up 11 | Why |
| -- | -- | -- | -- |
| Shell | `DetailLayout` columns: hero, body, a metadata sidebar | The band shell: Forest hero, facts card, Bone band, white body band, white mailing list | DESIGN.md §4 "The detail page band shell" names this page. Question 1. |
| Hero | White. Eyebrow, marker, h1 at the Headline size, the unclaimed line, "Visit website", social buttons | Forest with the glow. The same parts. The name at Display, as DESIGN.md §3 says for the vendor masthead. | Same parts, new ground. |
| Mark | Claimed: 64px logo. Unclaimed: no large mark, a 32px mark beside the note | Claimed: the 104px hero mark with the logo. Unclaimed: no large mark, a 32px initial tile beside the note | The ruling: no unclaimed logo above 32px. Question 6. |
| Description | An "About" section in the body | The hero lede. "About" is an Options alternate. | Question 3. |
| At a glance, company facts, actions | Three sidebar blocks | Three cells of the facts card. "At a glance" is the Bone stat cell with one figure. | One large figure per band. The integration count drops to inline text. |
| OGL note | Last line of the sidebar | Under the facts card, on the Bone band | Same words. |
| Products | A table, 34rem minimum | The same table on the 1328px wrap, 44px row links, an order caption | Question 4. |
| Mailing list | Bone band | White with a hairline above | The band shell rule: the facts ground is the one Bone band. |

### The pair page

| Part | Today | Mock-up 12 | Why |
| -- | -- | -- | -- |
| Hero | White header: eyebrow, marker, h1, the Basic and Detailed toggle | Forest hero. Eyebrow and marker, then the h1 at the Statement size with the product names in Bone at 600 | Mock-up 5's hero, as the issue asks. Question 8. |
| The two products | A grey rail box under the header, a hairline between them | Two white cards on the hero joined by a Clay ribbon and a medallion that states the sync headline | The rail becomes mock-up 5's diagram. Question 9. |
| Version selects | A second row of the rail | Inside each product card, under the name | The card's name is a link, not the whole card, so a select inside it is valid. |
| Data heading | h2 in the body, the toggle in the header | h2 and the toggle together at the head of the data band | The toggle governs the band, so it sits with it. Question 11. |
| Mechanism card | Bordered box | The card recipe with the card shadow | Cards take the shadow (ruling A7). |
| Card title and lanes | h2 and h3 | h3 and h4 | The data heading is the h2 above the cards. Question 10. |
| At a glance | Bone strip with a border | Bone nested fill, no border | A nested fill, not a band. |
| Claim lanes | Grey boxes, stacked | Forest-soft nested panels, side by side from 1024px when there are two | The settled nested panel fill. |
| Sources trigger | A 24px "i" letter | A 44px button with the info icon | The 44px floor. |
| Unclaimed note | Replaces the large mark with a small mark and the note | The initial tile stays at 64px, the note sits under the name | Question 6. |
| Mailing list | Bone band | Bone band, the page's one | The pair page is not on the band shell. Question 12. |

Copy is unchanged except the order caption in question 4.

## 3. Questions for Chris

Most important first. Each has my recommendation.

### Question 1. Does the vendor page take the band shell?

- **A. Yes. Forest hero, facts card, Bone ground, white body and a white mailing list.** The mock-up does this.
- **B. No. A Forest hero only, and the sidebar stays.**

**Recommendation: A.** It is the product page's layout, which the issue asks for. `DetailLayout` already has `shell="bands"` (AECI-1778), so the build passes it and moves the three sidebar blocks into the facts card.

### Question 2. Does the vendor hero get a visual on the right?

At 1440px the right half of the hero is empty Forest. The product page fills it with the category hub (R3 decision 1).

- **A. No visual.** The mock-up does this.
- **B. A visual of the vendor's products.** It would need its own order rule, A to Z by name (DESIGN.md "The hero diagram").

**Recommendation: A.** The products table sits one scroll below and already shows every product in A to Z order. A second picture of the same list adds an ordering surface and no new fact. The facts card fills the width under the hero.

### Question 3. Where does the vendor description go?

- **A. The hero lede.** The mock-up does this. The words are unchanged. The "About" heading goes.
- **B. An "About" section, as today.** Options, "Description".

**Recommendation: A.** A vendor has one description, and the product page uses its short description as the hero lede. Without it the hero holds only a name and two buttons. The longest live description, Terracon, is about 400 characters, which is five lines at 1440px. If you want "About" kept for search engines, choose B.

### Question 4. The products list: table, and an order caption

The products are sorted A to Z by name in the API (`compareText`, then id). The page does not say so.

- **A. Keep the table. Add the caption "A to Z by name." under the heading.** The mock-up does this.
- **B. Keep the table, no caption.**
- **C. Cards, as on the browse lists.** Options, "Products list".

**Recommendation: A.** Every list should say how it is ordered (mock-up 10, question 6). The table scans faster for a vendor with 19 products, and the browse lists' cards add nothing the row lacks. The caption is new copy, so it needs your yes.

### Question 5. The Rating column on the vendor table

Every product on both sample vendors has 0 reviews, so the column is all dashes. Mock-up 10, question 4, asks the same about the browse table and recommends renaming "Rating" to "Overall".

**Recommendation:** follow your answer to mock-up 10, question 4. The mock-up keeps "Rating" until you rule.

### Question 6. The unclaimed mark on its own page

The ruling says an unclaimed listing never shows a logo above 32px. Counsel's ruling 9 allows a small sourced logo beside the Unclaimed note on the listing's own page, and `aec-logo-or-initial` does that today at 32px.

- **A. The component decides, as today.** The 32px slot beside the note may show the sourced logo. The mock-up draws the initial tile there, because I did not copy unclaimed logos into the repo.
- **B. Always the initial tile for an unclaimed listing, even on its own page.**

**Recommendation: A.** It is the shipped rule and counsel's reading. On the pair page the unclaimed side keeps its 64px initial tile and gets the note under its name. That is a tile, not a logo, so the 32px limit holds.

### Question 7. "Claim {vendor}" on a claimed vendor

Rental Leak is claimed, and its page still shows "Claim Rental Leak". That is today's rule: the claim action is stateless (AECI-1266, AECI-1365).

**Recommendation:** keep it. I raise it only because it looks odd on the claimed sample. Changing it would be a public signal of who has claimed, which the rulings avoid.

### Question 8. The pair hero is mock-up 5's hero

- **A. Yes.** Forest, the eyebrow and marker, the h1 "How {A} and {B} exchange data" at the Statement size with the names in Bone at weight 600, and the two product cards on the right. The mock-up does this.
- **B. A Forest hero with today's white rail box under it.**

**Recommendation: A.** It is what the issue asks. The h1 keeps today's words. The Statement is the page's one Display use.

### Question 9. The medallion repeats the data heading

The ribbon's medallion reads "1 type of data shared", and the h2 below says the same. The medallion is `aria-hidden`, so a screen reader hears it once.

- **A. Keep it.** The diagram needs a label, and today's sync headline is the honest one.
- **B. Show only the direction glyph.**

**Recommendation: A.** A bare arrow on the medallion says nothing a reader can act on.

### Question 10. Heading levels on the pair page

Today the data heading and each mechanism title are both h2, and the lanes are h3. The mock-up nests them: data heading h2, mechanism title h3, lane heading h4.

**Recommendation:** nest them. The mechanism cards belong to the data heading. Specs that pin the h2 change in AECI-1798.

### Question 11. The Basic and Detailed toggle moves into the data band

Today it sits at the top right of the page header. On Forest it would need an on-brand segmented control, which no ruling covers. The mock-up puts it beside the data heading, on white, with the tick a pressed segment shows (clash 5).

**Recommendation:** move it. The behaviour, the `?view=` URL and the cookie are unchanged.

### Question 12. Which band is Bone on each page

| Page | Bone | Why |
| -- | -- | -- |
| Vendor | The facts ground, under the card. The mailing list is white. | The band shell rule (DESIGN.md §4). |
| Pair | The mailing list. | The pair page has no facts card. The At a glance strips are nested fills, not bands. |

**Recommendation:** accept both. Each page has one Bone band.

### Question 13. Two smaller settings

- **Social buttons on Forest** use a Bone wash and a Bone edge at 50%. DESIGN.md leaves the secondary button on Forest open. **Recommendation:** use this as the on-brand secondary button.
- **No section nav on the vendor page.** It has two sections, the facts and the products. **Recommendation:** no section nav until the page has three.

## 4. Every list, its order, and where the order comes from

Nothing here is new, and nothing is ordered by plan.

| Page | List | Order | Source |
| -- | -- | -- | -- |
| Vendor | Products | Name A to Z, case ignored, then id | `apps/api/src/lib/drizzle-helpers.ts` (`compareText`) |
| Vendor | Company facts | Headquarters, Founded, Employees, Ownership, Parent company, Funding stage. A null fact is not a row. | `vendors/company-facts.ts` |
| Vendor | Social links | LinkedIn, X, YouTube, Facebook, Instagram | `vendors/vendor-detail.ts` |
| Pair | Mechanisms | As the API returns them | `products/products-pair.ts` |
| Pair | Claim lanes | Sends to, Receives from, Syncs both ways | `DIRECTION_ORDER` |
| Pair | Claims in a lane | As the API returns them | `products/products-pair.ts` `buildClaimGroups()` |
| Pair | Card links | Each side's own link, context side first, then AECi's. Listing before docs. | `mechanismLinks()` |

No agreement state sorts or filters anything, and no count of agreement states is shown (DESIGN.md §5 Badges).

## 5. Departures from DESIGN.md and the rulings

None is built into the default without a question.

- The pair page is not on `DetailLayout`. It keeps its own shell with a Forest hero (question 12).
- The vendor hero mark is the 104px hero mark for a claimed vendor, as on the product page. Today a claimed vendor shows 64px.
- The maintenance chip on Forest takes a Bone wash and edge, because its default fill vanishes there. Its words are unchanged.

## 6. Components the build uses

| Need | Component |
| -- | -- |
| Shell | `DetailLayout` with `shell="bands"` (vendor), `aec-hero-band` (both), `BAND_WRAP_CLASS` |
| Breadcrumb | `aec-breadcrumb` with `tone="on-brand"` |
| Marks | `aec-logo-or-initial` with `size="hero"`, `lg` and `sm`. `aec-unclaimed-note` with `tone="on-brand"` on the vendor hero. |
| Chips | `aec-maintenance-marker`, `aec-agreement-badge`, `aec-chip` |
| Figures | `aec-figure` at `--t-fig` for the product count |
| Facts | `aec-company-facts`, `aec-company-facts-note` |
| Buttons | `aecButton` (`primary`, `secondary`, on-brand), `aec-request-trigger` |
| Pair | `aec-pair-version-select`, `aec-claim-provenance` on the `.aec-popover` surface, `aec-field-caption`, `aec-under-review` |
| Band | `aec-mailing-list-signup`, `ground="white"` on the vendor page |

## 7. Where the data comes from

Read on 2026-11-16 from production, through the public API the site's own pages call. `mockups/src/11-snapshot.py` records the calls. Only the fields the mock-ups draw are kept, in `11-data.json`. No write, no review-app tool, no secret.

| Data | Source |
| -- | -- |
| Autodesk: facts, 19 products, social links | `GET /api/vendors/autodesk` |
| Rental Leak: claimed, vendor maintained, uploaded logo | `GET /api/vendors/rental-leak` |
| Claim survey: 4 of 251 vendors claimed, none with 0 products | `GET /api/vendors?page=1..11` and `GET /api/vendors/:slug` for all 251 |
| Rental Leak and QuickBooks Online | `GET /api/products/rental-leak/integrations/quickbooks-online` |
| JobTread and QuickBooks Online | `GET /api/products/jobtread/integrations/quickbooks-online` |

The Rental Leak logo is loaded from its public URL on the site. It is not copied into the repo.

### Two things in live data worth a look

- **Autodesk's "Integrations" count is lower than one of its products' counts.** The vendor payload says 48. The product row for Autodesk Forma says 54. Both are on the same page today. If the vendor figure counts something narrower, such as distinct partners, the label does not say so. Someone should check what `integration_count` on a vendor counts.
- **Rental Leak's own "listing" link is its sign-up page.** On the pair page it reads "Rental Leak listing" and goes to `app.getrentalleak.com/sign-up`. The curated listing and docs links are the same guide URL. This is data, not code.

## 8. Verification

Run on 2026-11-16 with Playwright 1.64 and axe-core 4.11.4 against the files, in 12 states, each at 1440, 1024, 768 and 390px. axe ran the WCAG 2.0, 2.1 and 2.2 A and AA rules plus best practice.

| Width | Sideways scroll | Clipped elements | Controls under 44px | axe violations |
| -- | -- | -- | -- | -- |
| 1440 | None | None | None | 0 |
| 1024 | None | None | None | 0 |
| 768 | None | None | None | 0 |
| 390 | None | None | None | 0 |

Each page has one `h1`. Focus is a 3px Forest ring on white and a Bone ring on Forest. Agreement chips carry their full meaning as screen-reader text, not as an `aria-label` on a span. The Sources popover is a disclosure that closes on Escape and returns focus.

Screenshots, archived outside the repo on 2026-11-23:

| State | Files |
| -- | -- |
| Vendor, unclaimed (Autodesk) | `11-vendor-autodesk-1440.png`, `-390.png` |
| Vendor, claimed (Rental Leak) | `11-vendor-rental-leak-1440.png`, `-390.png` |
| Vendor, About section (question 3) | `11-vendor-about-band-1440.png` |
| Vendor, products as cards (question 4) | `11-vendor-products-cards-1440.png` |
| Pair, Rental Leak and QuickBooks Online | `12-pair-rental-leak-1440.png`, `-390.png` |
| Pair, JobTread and QuickBooks Online | `12-pair-jobtread-1440.png`, `-390.png` |
| Pair, Basic view | `12-pair-jobtread-basic-1440.png` |
| Pair, illustrative states | `12-pair-illustrative-1440.png`, `-390.png` |
| Pair, Sources open | `12-pair-sources-open-1440.png` |

Not done: a screen reader pass, and the `impeccable` detector against a rendered app page, because nothing is built. Mobbin was not searched. Mock-ups 5, 6 and 10 are the anchor (clash 44). The screenshots are not posted to Linear.

## Summary

- Decide question 1: the vendor page takes the band shell. I recommend yes.
- Decide questions 2 and 3: no vendor hero visual, and the description becomes the hero lede. I recommend both.
- Decide question 4: keep the table and add "A to Z by name." I recommend that.
- Decide question 8: the pair page takes mock-up 5's hero with the rail as its diagram. I recommend yes.
- Decide questions 10 and 11: nest the pair headings and move the view toggle into the data band. I recommend both.
- Decide question 12: the facts ground is Bone on the vendor page, the mailing list is Bone on the pair page.
- Ask someone to check what a vendor's `integration_count` counts. Autodesk shows 48 beside a product with 54.

## Rulings 2026-11-16

Chris ruled on the thirteen questions above, in chat. Every recommendation was accepted. These bind the vendor page and pair page builds.

| # | Question | Ruling |
| -- | -- | -- |
| 1 | Vendor page takes the band shell | Yes. |
| 2 | A picture on the right of the vendor hero | None, for now. |
| 3 | Vendor description moves into the hero; the "About" heading goes | Yes. |
| 4 | Keep the products table; add the caption "A to Z by name." | Yes. The caption is approved. |
| 5 | The vendor table's "Rating" column | Renamed "Overall", as on the browse lists. |
| 6 | The unclaimed mark beside the note | The logo component decides, never above 32px. |
| 7 | "Claim {vendor}" on a claimed vendor | Keep today's rule. |
| 8 | Pair page takes the hero with the two products as the diagram | Yes. |
| 9 | The hero badge that repeats the data heading | Keep it. |
| 10 | Pair page heading levels h2/h3/h4 | Yes. |
| 11 | The Basic/Detailed toggle moves into the data section | Yes. |
| 12 | Bone band: facts area on the vendor page, mailing list on the pair page | Accepted. |
| 13 | Social buttons on Forest get a Bone wash; no section nav on the vendor page | Accepted. |
