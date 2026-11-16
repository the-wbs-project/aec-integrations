# Mock-up 10: the browse lists, decision note (AECI-1790)

**Legal impact:** none. A design artefact. No order changes. Question 6 asks about one new caption that describes orders the code already uses.

The browse lists move into the new language with the same behaviour they have today. `/products`, the four taxonomy term pages and `/search` share one layout: a white page header, the filter panel on the left, the toolbar, cards or a table, the pagination footer and the mailing-list band. No list changes its order. Chris needs to answer the questions in section 3 before AECI-1793 to AECI-1796 build it.

- Mock-up: `mockups/10-browse.html`. Open it in a browser. The "Options" control switches page, view, state and two alternates. Its defaults are my recommendation, not decisions.
- The file is generated. Its sources are `mockups/src/10-build.py`, `10.css`, `10-data.json` and `10-wordmark.svg`. Edit those and run `python3 -I 10-build.py` from `mockups/src`.
- Screenshots: `screens/10-browse-*.png`. The list is in section 8.
- Baseline: `baseline/products-*.png`, `category-term-*.png`, `categories-*.png` and `search-*.png` (AECI-1817).

## 1. Scope

The issue names one file, `10-browse.html`, for `/products` and a category term page, in cards and table views, with the empty state. It also says `/search` shares the layout, so `/search` is in the file. AECI-1795, the taxonomy index pages, is blocked by this issue and asks for "the browse mock-up's header and chip language", so `/categories` is in the file too.

The vendor page is not here. It is AECI-1791 and its own mock-up, `11-vendor.html` (AECI-1797). The brief that started this work expected four files numbered 10 to 13. I followed the issue.

The Options control picks one of seven views of the file:

| Page | Results | Empty state |
| -- | -- | -- |
| `/products` | Newest, 24 of 445 | Accounting & ERP and Roofing checked: "No products match these filters." |
| `/categories/accounting-erp` | Newest, 24 of 92 | An empty term, Robotics: "No products are tagged Robotics yet." |
| `/search?q=procore` | Newest, 24 of 124 | `geotextile loom`: "No results. Try a broader search or browse by category." |
| `/categories` | 32 terms, Name (A–Z) | none |

## 2. What changes from today, and why

| Part | Today | Mock-up 10 | Why |
| -- | -- | -- | -- |
| Header and footer | White header, six links | The shipped Forest header and footer, copied from mock-up 9 | Not redesigned. |
| Page width | The 7xl canvas | The 1328px wrap, 24, 32 and 48px gutters | Lines up with the header and footer. Question 3. |
| Page header | Breadcrumb, h1 with a dead `text-4xl md:text-5xl`, lede | White. Breadcrumb, h1 at the Headline role, lede at the Lede role, hairline below. No hero. | List pages are not detail pages, so no Forest hero and no Bone. The h1 size is what renders today. |
| Filter panel | 12px uppercase legends, 24px checkbox rows, Forest "Show more" and "Clear filters" | Overline legends, 44px rows, counts kept, "Show more" and "Clear filters" as standalone links, an order caption at the end | The 44px floor for inputs. Link roles from the Link Treatment Rule. The caption is question 6. |
| Toolbar | Sort trigger 44px. View toggle 42px with a 1.25:1 edge. | Both 44px on the field edge. The pressed view is solid Forest with a tick. | The 3:1 control edge, and clash 5: a pressed segment shows a tick. |
| Cards | 24px radius, card shadow, stretched title link (AECI-1765) | The same recipe. Initial tiles. The integration count is a quiet chip. No lead card. | Already on the new recipe. The lead card is question 2. |
| Table | Header 12px, count number stacked over its noun, rating dash named by `aria-label` on a span | Header at the Label role, 13px. The count on one line, so every row is the same height. The dash is `aria-hidden` with visually hidden "No ratings yet". | Even rows read faster. An `aria-label` on a plain span is not reliably read. |
| Pagination footer | "Showing X of Y", "Load more" | Unchanged | Same-behaviour rule. |
| Empty states | Dashed sunken box | Sunken panel, 24px radius, no dashed edge. Same words. | Text only, alike on every page (R5 row 4). |
| Mailing-list band | Bone band, bordered panel, uppercase field label | The page's one Bone band. A card with the card shadow. The field label in sentence case. Same copy. | A list page has no hero, so this is its one Bone band. The label follows AECI-1850. |
| `/search` query box | `border-default` edge, 1.22:1 | The field edge, 48px, with a search icon | Designs out AECI-1850. |
| `/search` tabs | Forest 2px underline | Forest 2px underline, 44px tall, weight 600 when selected | Question 9. |
| `/categories` | Bordered term boxes, a pressed-button sort labelled "A → Z" and "Products" | Term cards on the card recipe, three columns at most. The shared sort control. | Question 7. |

Copy is unchanged, except for the order caption (question 6), the `/products` lede (question 8) and the table's "Rating" header (question 4).

### Live defects this design answers

- **AECI-1863, the `/products` grid rebuilt after load.** The cause is not confirmed. The mock-up adds nothing to the grid that depends on browser state. Dropping the lead card (question 2) removes one candidate, because the first card's shape depends on `idx.firstPage()` and `idx.sort()` in the browser. The build must still find the cause.
- **AECI-1850, inputs below the 3:1 edge.** The `/search` box, the sort trigger and the view toggle all draw `--border-field`.

### A live defect found while gathering data

- **AECI-1867 (filed, Bugs, High).** Production's Algolia product records still carry `logo_url` for unclaimed products. Examples: CooperBuild AI, Punch and Amazon Business. `GET /api/products` returns `null` for the same three. So `/search` in production can show an unclaimed product's logo off its own page, against counsel's ruling 9. A full reindex should fix it. The mock-up shows initial tiles on `/search`, as the rule requires.

## 3. Questions for Chris

Most important first. Each has my recommendation.

### Question 1. Do the browse lists adopt the R5 departures?

R5 kept three departures for the integrations list: its own filter panel, grouping with a sticky jump rail, and "Show more" per group with a load bar. A kept departure becomes the rule "for every page with that pattern".

- **A. No. The browse lists keep `aec-facet-panel`, the sort control and `aec-pagination-footer`.** The mock-up does this.
- **B. Yes. Group products by category, page by "Show more" per group.**

**Recommendation: A.** The browse lists do not have the pattern R5 ruled on. They are flat, sortable lists of products, not a product's integrations grouped by partner category. A product sits in several categories, so grouping would show it more than once or pick a "main" category, which the card deliberately does not. "Load more" is a real `?page=2` link that crawlers follow (`ssr-listing-crawlability.spec.ts`). DESIGN.md §5 should record that the browse lists keep the facet panel and the pagination footer.

### Question 2. Keep the wide lead card on `/products` and the term pages?

Today the first product on page 1 at Newest is a wide Bone card, "Recently added". Ruling R3 dropped the wide lead card on the integrations list and left this grid to this mock-up.

- **A. Drop it. A uniform grid at every sort.** Screenshot `10-browse-products-1440.png`.
- **B. Keep it.** Screenshot `10-browse-products-lead-1440.png`.

**Recommendation: A.** A wide first slot looks like a featured slot, and these pages must not look like paid placement. The grid also changes shape when the sort changes, which the same-behaviour rule does not like. Today the slot goes to viAct Project Control Center, a product with no integrations, so it does not earn the space. It adds a second Bone surface beside the mailing-list band. It is also one candidate cause of AECI-1863.

### Question 3. Do the browse and search pages move to the 1328px wrap?

DESIGN.md §4 "Open values" leaves this to this mock-up.

- **A. Yes.** The mock-up does this. Content lines up with the header and footer from mock-up 9.
- **B. No.** They stay on the 7xl canvas.

**Recommendation: A.** It is the same answer as mock-up 9 question 6. It is one constant, `BAND_WRAP_CLASS`, in `BrowseLayout`.

### Question 4. How do the lists show a rating below five reviews, and which score is it?

Lists show one score, `rating_overall_avg`. The product page labels it "Overall". The other score, onboarding, is not in lists. Every product in today's data has under five reviews, so no list shows a rating.

- **A. As today: no line on a card, a dash in the table. Rename the column header from "Rating" to "Overall".** The mock-up shows today's look and keeps "Rating" until you rule.
- **B. "Not yet rated" on every card and in every table cell.** Screenshot `10-browse-products-not-yet-rated-1440.png`.
- **C. Show both scores, in two columns and two card lines.**

**Recommendation: A.** With 445 of 445 products below the gate, B prints "Not yet rated" 24 times per page and says nothing. "Overall" names the score the way the product page does, so no reader takes it for a merged figure. C adds a column that is empty for every product today.

### Question 5. The filter order differs between `/products` and `/search`.

| | `/products` and term pages | `/search` |
| -- | -- | -- |
| Group order | Categories, Audiences, Trades, Phases | Categories, Audiences, Phases, Trades, Vendor, Integrations |
| Term order | Directory order: categories and trades by `display_order`, audiences A to Z, phases in project order | Most matching products first, phases in project order |

The same-behaviour rule says a pattern works the same everywhere. Changing either order is an order change, and ruling R1 keeps existing orders.

- **A. Keep both orders. State each one under its panel.** The mock-up does this.
- **B. Put `/search` on directory order.** A front-end sort over the facet values Algolia returns.
- **C. Put `/products` on count order.** It would order audiences and trades by product count, which only a Managed plan can raise (AECI-1814).

**Recommendation: A now. B is worth a separate issue.** C is ruled out by the firewall finding. The group order is a one-line fix in either file. I recommend Phases before Trades on both, to match `/search`, but that also needs your yes.

### Question 6. An order caption under each filter panel.

The Browse menu states its orders in a footer line. The mock-up adds one line under each filter panel:

- `/products` and term pages: "Phases in project order. Other terms A to Z."
- `/search`: "Terms with the most matching products first. Phases in project order."

"Other terms A to Z" is true today because `display_order` is alphabetical for categories and trades. It stays true only while editors keep it that way.

- **A. Keep the captions, and add a test that categories and trades `display_order` stays A to Z.**
- **B. Drop the captions.**

**Recommendation: A.** Every list on the site should say how it is ordered. Neither line promises anything about ranking. If you read either as something "How ranking works" must back, say so and the build waits for that text.

### Question 7. The taxonomy index sort control.

`/categories` and the other three index pages sort with a row of pressed buttons, "Sort by: A → Z | Products", plus "Sequence" on `/phases`. Every other list uses the listing sort control. The label "A → Z" also uses the text arrow, which the Arrow Rule keeps for data-flow direction.

- **A. Use the shared sort control.** Options "Name (A–Z)", "Most products", and "Project order" first on `/phases`. Same orders, same defaults. The mock-up shows this.
- **B. Keep the buttons, relabel "A → Z" as "A to Z".**

**Recommendation: A.** One sort control on every list. The orders and their defaults do not change.

### Question 8. The `/products` lede count follows the filters.

The lede reads "Every AEC software product indexed on AEC Integrations (445 in total)". The number is the filtered total, so with filters it can read "(0 in total)". Screenshot `10-browse-products-empty-1440.png` shows it. I read this from the code and the API. I did not reproduce it on a running page.

- **A. Drop the number from the lede.** "Showing X of Y" already says it.
- **B. Use the unfiltered total.**
- **C. Keep it.**

**Recommendation: A.** One count, in one place, that is always right.

### Question 9. Two smaller settings.

- **Filter rows are 44px tall.** That is the input floor in the brief. It makes the filter panel about twice today's length, longer than the results on `/search`. The alternative is 32px rows, which pass WCAG 2.5.8 (24px). **Recommendation: keep 44px.** It is the stated floor.
- **The `/search` tab marker.** DESIGN.md §5 lists Forest underline or Clay bar as open. The mock-up uses the Forest underline. **Recommendation: Forest.** Clay is 2.3:1 on white, so it cannot be the only state cue. Weight 600 is the second cue.

### Not a question for this mock-up: `/search` opens on Newest.

Relevance was dropped as a sort on 2026-10-26. So a search for "procore" shows CooperBuild AI first, and Procore itself is not on page 1. The mock-up shows that order, because orders do not change here. If you want to revisit it, it needs its own issue.

## 4. Every list, its order, and where the order comes from

Nothing here is new, and nothing is ordered by plan.

| Page | List | Order | Source |
| -- | -- | -- | -- |
| `/products`, term pages | Results | The sort control. Default Newest: `created_at` descending, then id. Options: Newest, Name (A–Z), Recently updated, Highest rated, Most reviewed. | `lib/sort.ts` `resolveProductOrderBy`, `product-sort-options.ts` |
| `/products`, term pages | Filter groups | Categories, Audiences, Trades, Phases. A term page hides its own facet. | `facet-sidebar.ts` `DIMENSIONS` |
| `/products`, term pages | Categories, Trades | `display_order`, then name. A to Z today. | `routes/product-facets.ts` |
| `/products`, term pages | Audiences | Name, A to Z | `routes/product-facets.ts` |
| `/products`, term pages | Phases | `display_order`: project order | `routes/product-facets.ts` |
| All filter lists | Which terms show | Zero-count terms hidden unless checked. First 10, then "Show more (N)". | `facet-sidebar.ts`, `search-refinement-list.ts` |
| `/search` | Results | The sort control. Default Newest: the `created_desc` replica. Ties fall to text relevance, then `listing_tier`, then review count. | `docs/SEARCH_RANKING.md` §5a |
| `/search` | Filter groups | Categories, Audiences, Phases, Trades, Vendor, Integrations | `search-controller.ts` |
| `/search` | Filter terms | Most matching products first. Phases in project order. | Algolia default, `search-facet-order.ts` |
| `/search` | Integrations menu | All, 0, 1–10, 11–50, 51+ | `search-controller.ts` `COUNT_BUCKETS` |
| `/search` | Tabs | Products, then Vendors | `search-page.ts` |
| `/categories` | Terms | Name A to Z by default. "Most products" sorts by count, then integrations, then name. | `taxonomy-index.ts` `sorted()` |
| All | Header and footer links | Fixed | `site-header.ts`, `site-footer.ts` |

## 5. Departures from DESIGN.md and the rulings

None is built into the default without a question.

- The browse page wrap, the toolbar height and the lead card are open values DESIGN.md leaves to this mock-up. They are questions 3, 2 and 1.
- No Forest feature card. One per page is allowed, not required. A list page has no block that needs it.
- The brief cites "ruling A8" with R3. I found no A8 in the records, as mock-up 9 also found. R3 is the rule I applied.
- Claimed listings show their logo in lists. In today's data no product on these pages is claimed, so every mark is an initial tile. That is the data, not a design choice.

## 6. Components the build uses

All exist on the integration branch. Nothing new is needed.

| Need | Component |
| -- | -- |
| Shell | `BrowseLayout` on `BAND_WRAP_CLASS`, `SiteHeader`, `SiteFooter`, `SkipLink` |
| Breadcrumb | `aec-breadcrumb` |
| Filters | `aec-facet-panel`, `aec-facet-sidebar`, `aec-search-refinement-list`, `aec-search-numeric-menu` |
| Toolbar | `aec-listing-toolbar`, `aec-listing-sort-select`, `aec-listing-view-toggle` (gains the tick and the field edge) |
| Cards | `ProductCardGrid` on `aecCard interactive` and `CARD_GRID_CLASS`, `aec-search-product-card` |
| Table | `tr[aec-product-card]`, `tr[aec-search-vendor-row]` |
| Marks and stats | `aec-logo-or-initial` (`'server-filtered'`), `aec-integration-stat`, `aec-rating-summary`, `aec-role-badge` over `aec-chip` |
| Paging | `aec-pagination-footer` |
| Buttons and fields | `aecButton` (`primary`, `secondary`), `.aec-field-control` |
| Band | `aec-mailing-list-signup` as the page's one Bone band (AECI-1799) |
| `/search` extras | `aec-company-facts-note` |
| `/categories` | `taxonomy-index.ts` on `aecCard interactive` and the shared sort control |
| Icons | `aec-icon`: `search`, `chevron-down`, `grid`, `list`, `check`, `link`, `menu`, and `aec-new-tab-icon` |

Specs that pin today's classes and will change: `facet-sidebar`, `facet-panel`, `listing-view-toggle`, `product-card*`, `pagination-footer`, `taxonomy-index`, `taxonomy-browse`, `products-index`, `search-page` and `mailing-list-signup`.

## 7. Where the data comes from

Read on 2026-11-16 from production, through the same public reads the site's own pages make. `mockups/src/10-snapshot.py` records the calls. Only the fields the mock-up draws are kept, in `10-data.json`.

| Data | Source |
| -- | -- |
| `/products` first 24, total 445 | `GET /api/products?per_page=24` |
| Filter counts, unfiltered and scoped | `GET /api/products/facets`, with `category_id` and `trade_id` |
| Accounting & ERP first 24, total 92 | `GET /api/products?category_id=…` |
| The empty filter result | `GET /api/products?category_id=…&trade_id=…` returned 0 |
| `/categories` terms, descriptions, counts | `GET /api/categories` |
| `/search` hits, totals and facets | The public search-only key, `production_products_created_desc` and `production_vendors_name_asc` |

No review counts or scores are shown, because every product read has fewer than five reviews. The search results use `product_role` where the record has it. Older records lack it, so they show no role chip, as the site does.

## 8. Verification

Run on 2026-11-16 with Playwright 1.64 and axe-core 4.11.4 against the file, in 13 states, each at four widths. axe ran the WCAG 2.0, 2.1 and 2.2 A and AA rules plus best practice.

| Width | Sideways scroll | Clipped elements | axe violations |
| -- | -- | -- | -- |
| 1440 | None | None | 0 |
| 1024 | None | None | 0 |
| 768 | None | None | 0 |
| 390 | None | None | 0 |

Each page has one `h1`. Filter legends, card titles and the band heading follow it in order. Tables have real `th` headers. Buttons and inputs are 44px. Focus is a 3px Forest ring, Bone on the Forest header and footer. One-line truncation of long product names is deliberate, as today.

Screenshots in `screens/`:

| State | Files |
| -- | -- |
| `/products`, cards | `10-browse-products-1440.png`, `-390.png` |
| `/products`, table | `10-browse-products-table-1440.png`, `-390.png` |
| `/products`, filters open on a phone | `10-browse-products-filters-open-390.png` |
| `/products`, no filter match | `10-browse-products-empty-1440.png` |
| `/products`, lead card on (question 2) | `10-browse-products-lead-1440.png` |
| `/products`, "Not yet rated" (question 4) | `10-browse-products-not-yet-rated-1440.png` |
| Category term | `10-browse-category-1440.png`, `-390.png`, `-table-1440.png` |
| Empty term, Robotics | `10-browse-category-empty-term-1440.png` |
| `/search` | `10-browse-search-1440.png`, `-390.png`, `-table-1440.png`, `-empty-1440.png` |
| `/categories` | `10-browse-categories-1440.png`, `-390.png` |

Not done: a screen reader pass, and the `impeccable` detector against a rendered app page, because nothing is built yet. Mobbin was not searched. Mock-ups 5 to 9 cover every component on these pages, and they are the anchor (clash 44).

## Summary

- Decide question 1: the browse lists keep the facet panel, sort and "Load more". I recommend yes, and DESIGN.md records it.
- Decide question 2: drop the wide lead card. I recommend dropping it.
- Decide question 3: the browse shell moves to the 1328px wrap. I recommend yes.
- Decide question 4: keep today's below-five look and rename "Rating" to "Overall". I recommend that.
- Decide questions 5 and 6: keep both filter orders and state each under its panel. I recommend that, with a separate issue to align `/search`.
- Decide questions 7 and 8: one sort control on the index pages, and no count in the `/products` lede. I recommend both.
- Act on AECI-1867: reindex production search so unclaimed products lose their logos.
