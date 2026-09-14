# Vendor performance: planning proposal

**Version:** 0.1
**Date:** 2026-09-14
**Status:** Discovery record. Promoted on 2026-09-14 into the build contract `docs/VENDOR_PERFORMANCE_SPEC.md` (Stage 2.5 §10). This file keeps the rationale and the repository verification; the spec holds the decisions, the contract, and the issue map. Where the two disagree, the spec wins.

## Purpose

Help a vendor's founder or marketing lead decide whether their AECi presence deserves continued investment. They should understand what information received attention, which actions followed, and what they can improve.

Working assumption: the paid offering remains profile management and buyer engagement reporting. A lead-generation offering would add a separate outcome layer. The commercial emphasis and whether a visual wireframe is wanted are pending user input.

This proposal covers one vendor portal page and its measurement requirements. It contains no application implementation. It does not assign the feature to a delivery stage. The activation admission test in `STAGE_2_1_SPEC.md` must be resolved before scheduling a new reporting surface.

## What would make the spend defensible?

Views establish exposure. Relevant context makes that exposure useful. Outbound actions provide evidence of further interest. Vendor-confirmed enquiries and sales eventually connect that interest to business outcomes.

The report must allow an honest conclusion that value is currently low. A reassuring chart cannot create demand that the directory has not generated. Treat the following vendor needs as hypotheses to validate with pilot vendors.

Directory exposure can exist before a vendor pays. The report demonstrates the value of their AECi presence. It does not establish that payment caused that exposure or that a profile edit caused subsequent growth. Paid capabilities remain separate from organic ranking.

| Vendor question | Evidence to show | Priority |
| --- | --- | --- |
| Is anyone seeing our information? | Recorded views of the vendor profile, owned products, and relevant integration pair pages. Break these apart. | First release |
| Are visitors taking a next step? | Clicks to the vendor website, product website, documentation, and integration listing. Label each destination purpose. | First release |
| Which products earn attention? | Per-product views, outbound actions, and comparable previous-period counts. | First release |
| Which integration relationships matter? | Most-viewed pairs involving owned products, with actions attributed to their actual destinations. | First release |
| Where is attention coming from? | Search, directory browsing, referrals, and direct or unknown arrivals, where recorded. | First release where reliable |
| Is the audience relevant? | Aggregate countries and observed category, trade, or discipline browsing context. Later, voluntarily supplied buyer roles and firm characteristics. | Later |
| Are we being discovered before our profile is opened? | Visible listing impressions and the resulting profile opens. | Later instrumentation |
| Is interest becoming business? | Submitted enquiries, vendor-accepted leads, booked demos, and vendor-reported opportunities or sales. | Separate outcome phase |
| What should we change? | Specific profile or integration information gaps attached to observed attention. | Small, evidence-based first-release section |
| Can I justify renewal to my team? | A downloadable monthly report carrying the same definitions and caveats as the page. | First release |

An integration partner is not necessarily a competitor. Interest in a pair is evidence of interest in interoperability. It does not establish that the visitor owns either tool or is buying a replacement.

## Suggested page outline

Proposed navigation label: **Performance**. Proposed route: `/vendor/:vendorSlug/performance`, beside the existing vendor-level portal sections.

The primary action is to inspect the products and integration relationships producing outbound interest. Exporting the report is the secondary action.

1. **Period and scope.** Default to the last 30 complete days. Offer 7 days, 90 days, and a custom range only where history exists. Include an all-products or selected-product filter. Show the report timezone, measurement start date, and last successful refresh.
2. **Attention and actions.** A compact summary of recorded profile views, product views, integration pair views, and outbound clicks. Keep views and actions separate. Show absolute previous-period counts alongside changes. Do not draw a funnel from unmatched populations.
3. **Activity over time.** One simple chart with a selected metric and its matching previous period. Avoid dual axes. Include an accessible table alternative. Missing days are gaps, not zeroes.
4. **Product performance.** A sortable table of product, product views, associated pair views, outbound clicks, and change. Selecting a row narrows the report. Show distinct visitors or action rates only after their measurement contract is reliable.
5. **Integration interest.** A ranked list of pairs involving the selected vendor's products, with the same columns as the product table: views, crawler fetches by purpose, on-demand AI fetches, and outbound clicks. A pair page serves in both URL orientations and canonicalises to the alphabetically-first one, so each row merges both. Selecting a pair shows relevant recorded actions and destination ownership. Retain the directory's delivered, reachable, and buildable distinctions wherever applicable. Integration pages carry the same weight as product pages throughout this design; the first release must not ship a product-only view of attention.
6. **Discovery and useful next steps.** A compact source breakdown and at most three actionable observations. Example: a viewed integration has an unreviewed claim or missing documentation. Link to the existing editor. Do not promise that editing it will increase traffic or ranking.
7. **Download and definitions.** CSV export and a print-friendly monthly report. Include the selected scope, date range, source coverage, freshness, and definitions. On-page definitions expand inline.

An illustrative report sentence, with fixture values only:

> Your product pages recorded 120 views and 8 clicks to your websites this month. The most-viewed integration pair was Product A and Product B.

This sentence establishes recorded activity. It does not claim 120 people, 8 leads, or any revenue.

## Measurement rules that make the report credible

- **Count an observed view, not a delivery of bytes.** Define the eligible event and deduplication rule for each surface. Exclude known automation, operator traffic, vendor self-visits where identifiable, previews, and non-production data. Unknown traffic stays explicitly uncertain. Logged-out self-visits cannot always be recognized.
- **A person is not a request.** Do not derive unique buyers from request counts, hashed network information, or memory-only browser identifiers. If consented distinct-browser counts are introduced, label their scope and cross-device limitations.
- **A click is not a lead.** A website click proves an outbound action. A lead requires an actual enquiry and a defined qualification step. A sale requires a vendor-confirmed outcome.
- **Pair exposure is shared.** A pair view can be relevant to both endpoint vendors. Within one vendor's total, count that observation once even when the vendor owns both products. Per-product rows can overlap, so the vendor total must be computed independently. Never sum shared pair exposure into a platform-wide unique audience.
- **Destination ownership determines outbound credit.** A click to the other endpoint vendor or to a connector's website is not a visit delivered to this vendor. Pair-page interest and clicks delivered to the vendor are separate measures.
- **Use a consistent rate denominator.** A future outbound action rate should be eligible consented sessions with at least one vendor-bound click divided by eligible consented sessions with a qualifying view. Apply the same vendor, dates, filters, and session rules to both. Do not divide consented clicks by all D1 page records.
- **Preserve unknowns.** Unavailable measurement, an outage, no eligible activity, and a suppressed small group are different states. None should silently become zero. Never extrapolate consented activity into an estimated total audience by default.
- **Preserve comparable history.** Record measurement start dates and definition changes. Do not calculate growth across incompatible tracking versions. If the previous period is zero, show absolute counts instead of an infinite percentage.
- **Protect the audience.** Report aggregate activity. Do not publish individual browsing trails, raw search text, inferred company identities, or contact details. Any later role or firm breakdown needs an explicit source and a small-group suppression policy that also prevents reconstruction through filters and exports.

## What exists and what needs work

Repository inspection establishes available code and documented behavior. It does not verify live vendor-level counts.

| Foundation | Current evidence | Planning implication |
| --- | --- | --- |
| Paid reporting entitlement | `packages/shared/src/entitlements.ts` declares `analytics.view` without a consumer. | Reuse the capability rather than inventing a new tier. Gate the reporting API and its page. Preserve the existing portal and renewal access. |
| Public page activity | `apps/api/src/routes/page-views.ts` records enriched page observations, and `page_views` already carries `product_id` and `vendor_id` for product and vendor detail arrivals (partial index `page_views_product_idx`). **Pair-page views carry neither**: `products-pair.resolver.ts` sends a route-only view because a row holds one entity and a pair has two. `ADMIN_PANEL_SPEC.md` documents an unresolved-origin traffic headline. | Product and vendor views have a consent-independent source today. Integration-pair views have **no attributable history**; see the verification section below. Not a ready-made verified-buyer count. Reuse the applicable classification rules and state their limitations. |
| Consented engagement | `ANALYTICS.md` documents product views, integration views, and outbound clicks in PostHog. Verified 2026-09-14: `product_viewed` fires only from `product-detail.ts`; `integration_viewed` has **no emitter** (the file the catalogue cites no longer exists) and the pair page fires no view event at all. Consent is opt-in. | A small consented slice of an already small audience. Useful for the outbound funnel, not for totals. Fix the catalogue and instrument the pair page before relying on it. |
| Outbound attribution | `external-link-tracker.ts` sends destination URL and source surface. | Add explicit source entity, recipient vendor, and link-purpose attribution. Do not promise an accurate historical vendor breakdown from URLs alone. Keep ambiguous old events unattributed. |
| Portal navigation | `vendor-nav.ts` and `vendor.routes.ts` define the existing vendor sections. | Add a sibling page and reuse the portal shell. Reporting data should load on demand rather than inflate every portal visit. |
| Billing | `STAGE_2_PAID_TIERS_SPEC.md` keeps arrangement amounts as free text and admin-only. | Defer cost-per-click and return-on-investment calculations. They need a numeric, currency-aware, period-aligned cost model and an explicit vendor-visible billing decision. |

PostHog vendor groups currently describe vendor portal usage. They do not automatically attribute anonymous buyer activity to the vendor whose public product is being researched.

## Delivery proposal

**First: establish trustworthy attribution.** Inventory public view and outbound-link coverage. Specify event eligibility, ownership, deduplication, filtering, dates, retention, and source limitations. Verify the rules with controlled buyer journeys, self-visits, repeated actions, both-endpoints-owned pairs, and clicks to a counterparty. Do not backfill facts that were never captured.

**Then: deliver the useful reporting page.** Ship scoped counts, trends, product and pair breakdowns, source context where reliable, and exports. Prefer daily reporting with an explicit freshness timestamp. Authorize every read and export against the signed-in vendor. Never expose raw analytics queries or another vendor's private report.

**Later: add richer discovery and audience evidence.** Instrument viewable search and browse impressions. A suggested impression rule is that at least half the listing is visible for one second in an active tab. Validate it as an AECi definition before implementation. Add engagement with documentation, repeat interest, and aggregate audience breakdowns only when their signals and sample sizes support them.

**Separately: connect to commercial outcomes.** Add explicit enquiries or vendor-side referral attribution. Track submitted, accepted, demo booked, opportunity, and won as separate states. Attribute multi-vendor enquiries explicitly. State any attribution window and keep vendor-reported revenue distinct from observed activity.

Validate the first report with pilot vendors. Ask them to explain what attention they received, identify a useful product or integration insight, and say what evidence is still missing for renewal. Record willingness to pay and renewal behavior separately from report usage. Setting a traffic-growth target for the reporting page itself would confuse measurement with demand generation.

## Presentation and key states

Use the existing vendor portal as the visual anchor. This is a restrained product surface in the established light theme. A marketing lead is reviewing performance on an office laptop before a budget conversation and needs readable evidence they can share. Keep existing typography, Forest accents, neutral surfaces, and plain labels. No new illustration assets are needed for the written planning scope.

On smaller screens, stack the filters and summarize table rows with expandable detail. Keep the main metric and product name visible. Support keyboard-operated controls, visible focus, localized copy, readable long names, and a chart table alternative.

| State | Required behavior |
| --- | --- |
| First use | Show the measurement start date and explain when the first report will be available. |
| Valid zero activity | Show zero recorded activity and a relevant profile-management action. Do not imply that buying an upgrade creates visitors. |
| Small sample | Keep supported aggregate counts. Withhold unstable percentages and audience breakdowns. |
| Loading | Reserve the report layout and use skeletons. |
| Partial failure | Keep available sections and the timestamp of stale values. Provide an inline retry. |
| Tracking gap | Mark the interval as unavailable. Do not join the chart across it as continuous data. |
| No reporting entitlement | Explain reporting availability while retaining access to the vendor portal and plan information. |
| Long history requested | State the earliest available date. Historical annual renewal reports need their own aggregate-retention decision. |

Implementation should use the Impeccable product reference, the existing portal components, and `DESIGN.md`. The visual brief remains provisional until the commercial emphasis and requested fidelity are settled.

## Documentation and scheduling

This document is the proposal record. It does not supersede existing behavior. Once scoped for implementation, update `STAGE_2_VENDOR_PORTAL_SPEC.md`, `ANALYTICS.md`, `API_CONTRACTS.md`, `AUTH_AND_RLS.md`, and the paid-tier capability consumer documentation. Update `DATABASE_SCHEMA.md`, `migrations.md`, and retention documentation if reporting storage changes. Record the admitted delivery stage and project status when the implementation work is created.

Useful external context: [G2's buyer-intent documentation](https://documentation.g2.com/docs/buyer-intent) distinguishes several research signals and profile traffic. It supports treating engagement as multiple observable behaviors. It is not evidence that AECi has equivalent identity data or that a view produces revenue. [PostHog's identity documentation](https://posthog.com/docs/data/anonymous-vs-identified-events) explains why recorded identities and actual people are not interchangeable without an identity strategy.

## Verification against the repository (2026-09-14)

A second pass checked the proposal above against the code, the specs, and Linear. Nothing below changes the page's shape. Several items change its sequencing, and two change what the first release can honestly show.

### Findings that change the plan

1. **Integration-pair views are unattributable today, so the "most distinctive" section has no data source.** `products-pair.resolver.ts` deliberately sends a route-only page view (`/products/:contextSlug/integrations/:otherSlug`) because `page_views` holds `product_id` XOR `vendor_id` and a pair has two products. `concrete_path` has stored the real URL since AECI-585, so the two slugs are recoverable for rows written after that, but nothing joins them. Consequence beyond this page: `home.trending_products` and the admin "product" breakdown already ignore every pair-page view. Fix is an additive migration plus resolver and ingest changes, and a one-time parse of `concrete_path` for the backfillable window. Key the row on the **two endpoint product ids as an unordered pair**, never on an integration row id: delivered edges move between `integrations` and `connector_evidenced_pairs` (AECI-888), a pair page with no edge still renders (noindex, not 404), and the same page serves in both URL orientations. The same rows carry `is_bot` and `bot_name`, so this one change unlocks **both** the pair view count and the pair crawl count, and it credits the pair to both endpoint vendors. Filed as **AECI-929** (High, Stage 2.5 Hardening), sequenced **before** the reporting page. Nothing else on the page depends on it, so the page can technically ship without the pair section, but a product-only first release would misrepresent what AECi is, and the section must never be drawn from parsed URLs.

   **Surface coverage, so the gap is explicit.** Every source below is per URL or per row, and a pair page is a URL, which is why the search-console column is ahead of our own.

   | Surface | Views today | Crawls today | After the pair-attribution prerequisite | Google / Bing per-URL data |
   | --- | --- | --- | --- | --- |
   | Vendor profile `/vendors/:slug` | Yes (`vendor_id`) | Yes (`vendor_id` + `bot_name`) | Unchanged | Yes |
   | Product page `/products/:slug` | Yes (`product_id`) | Yes | Unchanged | Yes |
   | Integration pair page `/products/:a/integrations/:b` | **No** (route only) | **No** (route only) | Yes, both orientations merged, credited to both endpoint vendors | Yes, once the pull is per URL |
   | Connector hub and powered listings | Yes, as the connector product's `product_id` | Yes | Unchanged | Yes |
   | Browse and search result listings | No (impressions are uninstrumented) | n/a | Unchanged; stays deferred | Search-result impressions only, from the consoles |

2. **The audience is too small for absolute counts to carry a renewal argument yet.** Measured 2026-09-13 over five days: about 16 real browser page loads per day site-wide, and the consented PostHog slice is smaller still because the banner is opt-in and DNT/GPC are hard denies. Spread over a 500-product catalogue, a 30-day per-vendor report will mostly show zeros or single digits. The "valid zero activity" state is therefore the **normal** state at launch, not an edge case. Two consequences. The first release should be framed to pilot vendors as "here is exactly what we can see", not as proof of value. And a **share-of-catalogue** line ("your products received N of the M product views recorded this month") is the one figure that stays meaningful at this volume, but it discloses platform totals to vendors, which needs an explicit decision.

3. **Traffic classification is being rewritten right now. Build on the new version, not the current predicates.** Epic AECI-867 restored arrival network telemetry (AECI-868, promoted to production 2026-09-13; arrival rows from 2026-09-07 to 09-12 are degraded and backfilled) and AECI-872 (In Progress) introduces versioned classification records with four reporting classes, reason codes, and a shadow-mode evaluation before any number changes. The proposal's "record definition changes and never compare across incompatible versions" rule is exactly what AECI-872 delivers. The vendor report should read that classification record and display its version, and must not add a third predicate set beside `page-view-predicates.ts` and `swarm-detection.ts`.

4. **A caveat envelope already exists. Reuse it.** Every admin analytics response carries `notes: AdminNote[]` with a closed `AdminNoteCodeSchema` (`packages/shared/src/api/admin-panel.ts`), the `aec-admin-notes` pattern: automation filter applied, arrival telemetry missing, and so on. The vendor report needs a vendor-safe subset of those codes rather than a new mechanism, so the operator console and the vendor page describe the same bias in the same words.

5. **History is 400 days and has no vendor dimension.** `page_views` retention is 400 days (`PAGE_VIEWS_RETENTION_DAYS`, also the admin aggregation ceiling). `metrics_daily` is a platform-wide key/value table with no vendor or product key, so it cannot hold per-vendor history. The first release can aggregate live over `page_views_product_idx`, which is what the admin panel does and is cheap at this volume. An annual renewal report, or any comparison older than 400 days, needs a per-vendor daily rollup table decided before the first vendor anniversary. Do not add per-vendor keys to `metrics_daily`.

6. **Search impressions can come from Google Search Console, not from a new impression tracker.** AECI-820 (Stage 2.5, High, Backlog) provisions a service account and pulls Search Analytics into `metrics_daily`. As written it stores platform-level keys only. Extending that pull with a per-page dimension gives each vendor's `/vendors/:slug`, `/products/:slug`, and pair URLs their own impressions, clicks, and average position at a two-to-three-day lag. That answers "are we being discovered before our profile is opened" for the search channel without the viewable-impression definition the proposal deferred. On-site listing impressions in browse and search results remain uninstrumented and should stay deferred.

7. **Outbound attribution is narrower than the proposal assumes.** Only four surfaces carry `aecTrackExternalLink`: `product_detail` (the product website), `vendor_detail` and `vendor_detail_social` (the vendor website and social links), and `pair_detail` twice (the mechanism's listing URL and docs URL). The pair links point wherever the mechanism's listing lives, which may be the counterparty's domain or a connector's domain. The event carries only `destination` and `source`, so ownership cannot be reconstructed later. At emit time the event needs the owning `vendor_id`, the source entity id, and a `link_purpose` value, per the proposal's destination-ownership rule. No Algolia click-insights are wired, so "searches that surfaced your product" is not available from any source.

8. **Vendor self-visits can be excluded the same way operator visits are.** `page_views.is_operator` is set at ingest by `lib/operator-session.ts`, which verifies the session JWT and re-reads `profiles.role`. Extending that read to return `vendor_id` for a `vendor_admin` session lets ingest set one boolean, "the viewer owns the entity viewed", with no identity stored. That is the same D7-safe shape as `is_operator`. Signed-out self-visits stay unknowable, as the proposal already says.

9. **There is no enquiry surface of any kind today.** `vendor_requests` holds only `claim` and `correction` kinds, both vendor-initiated. Nothing records a buyer contacting a vendor. The outcome layer in the delivery proposal is therefore a full new feature (form, storage, audit row, moderation, email, vendor-side accept), not an extension of an existing table.

### Findings that constrain the build

10. **The page is not a live-portal scope.** `GET /api/vendor/updates` issues six `SELECT`s per poll every 20 seconds per focused seat, and every cursor query must reuse its handler's scoping predicate. Reporting data is daily and must not join that cursor, `VendorPortalStore`, or the `GET /api/vendor/me` payload. It loads on demand from its own read endpoint. It is a read, so it writes no `audit_log` row, and it is never rate-limited (AECI-773).

11. **Wiring follows the portal's existing rules.** Handler order is `requireVendor()` then `requireCapability(c, 'analytics.view')`; the vendor id comes from the session, never the request. Adding the section is one entry in `vendor-nav.ts` plus one child route in `vendor.routes.ts`. The `/preview/vendor-dashboard` surface mounts the same section routes against fixtures, so the page needs a fixture payload on day one, including the zero and no-entitlement states.

12. **Connector vendors never see this page, by design.** `STAGE_2_SPEC.md` §8.9 gives a pure connector vendor a catalogue-maintenance seat with no `vendor_entitlements` row, so `analytics.view` never resolves for them. A `hybrid` vendor counts as an endpoint and does. The no-entitlement state should not imply a connector vendor can buy its way in.

13. **`/methodology` must change when this ships.** `STAGE_2_5_SPEC.md` §7.1 point 5 forbids the public methodology page from claiming `analytics.view` does anything today. Shipping a consumer flips that prohibition into a positive disclosure, and the ranking firewall (§3.2) must be restated: the page reports attention and never influences it.

14. **Stage placement is undecided and blocks Linear seeding.** The page fails the Stage 2.1 admission test (new feature) and Stage 2.5's no-new-surface rule, whose only admitted exception is §7. It therefore lands in Stage 3, or as a second explicitly admitted Stage 2.5 exception. The standing "no production data work before go-live" rule does not block the code work here. No existing Linear issue covers a vendor performance page; the nearest neighbours are AECI-820 (GSC ingest), AECI-858 (exclude the operator from PostHog product analytics), and AECI-717 (autocomplete telemetry).

### Documentation debt found on the way

- `ANALYTICS.md` §4 lists `integration_viewed` as emitted from `integrations/integration-detail.ts`. That file no longer exists and nothing emits the event.
- `STAGE_2_5_SPEC.md` §7.1 point 5 **forbids** the page from claiming `analytics.view` does anything; it does not require a positive disclosure, and the pin it names (`methodology.component.spec.ts`) covers the `integration.version_diff` halves, not analytics. Re-checked 2026-09-14: `apps/web/src/content/methodology.md` has no analytics sentence and the component spec asserts nothing about one. Shipping a consumer therefore **adds** a sentence and amends point 5 — see `VENDOR_PERFORMANCE_SPEC.md` §7.2.

### Crawler visibility, search-console data, and further ideas (second pass, 2026-09-14)

**Crawl frequency per vendor is available today for product and vendor pages, with two caveats.** `page_views` keeps every crawler request as a row with `is_bot`, `bot_name`, and the `product_id` or `vendor_id` of the page fetched, so "Googlebot fetched your product pages 14 times in the last 30 days; GPTBot 3 times" is one grouped query over data we already hold. Pair pages are excluded by finding 1 above. The caveats:

- **The classifier records who, not why.** `lib/bot-classification.ts` labels by operator and merges purposes: `perplexity-user` (a live fetch because a person asked) lands under `PerplexityBot` (index crawling), `chatgpt-user` under the same `OpenAI` label as `OAI-SearchBot`, and `google-extended` under `Googlebot`. `Claude-User` and `Claude-SearchBot` are not matched at all. A vendor-facing panel needs the four purposes AECI-872's class table already names: search indexing, AI training, assistant retrieval on demand, and previews. `bot_name` is set once at ingest, so revising it is a one-way backfill keyed on `user_agent_hash`, the same mechanism AECI-582 used. AECI-762 (Backlog, Stage 2.5, under AECI-788) is the issue that splits AI crawlers and AI referrals for an internal view. The vendor panel is that work with a vendor filter, so it should sequence after AECI-762 and AECI-762 should split by purpose, not only by operator.
- **The rows only exist while the edge lets the crawlers through.** AI crawlers were returned 403 until AECI-800 flipped the `Block AI bots` toggle on 2026-09-09, so AI-crawl history starts there. That toggle deprecates on 2026-09-15 and its mixed-purpose default moves to block (`waf-rate-limits.md` §3b). Re-verify the AI Crawl Control presets after that date, or the vendor panel goes quiet with no error. SEO-tool scrapers (Ahrefs, Semrush, MJ12, DotBot) are blocked at the WAF since AECI-747 and will never appear.

**What a crawl does and does not prove, and the page must say so.** A crawler fetch is a request. It is not indexing, not inclusion in an AI model, and not a citation in an answer (the AECI-762 non-goal). The user agent is self-declared and spoofable; AECI-872 asks for reverse-DNS or published-range verification, and Cloudflare's verified-bot category is the trustworthy signal if `request.cf` exposes it on the Pro plan (unverified, per AECI-872). The one crawler class that is closer to a human action is the **on-demand assistant fetch** (`ChatGPT-User`, `Perplexity-User`, `Claude-User`): each one means a person asked an assistant a question and the assistant pulled the vendor's page to answer it. Report those separately from training and indexing crawls. They are the nearest thing to an AI-answer referral we can observe first-hand.

**AI-referred human visits are recoverable.** `referrer-classification.ts` has no AI-engine sources, so a visit from `chatgpt.com`, `perplexity.ai`, `copilot.microsoft.com`, `gemini.google.com`, or `claude.ai` is labelled `Other` today. Because `page_views.referrer` stores the external host, a relabel is possible for every row written since that column shipped. AECI-762 covers it. Referrer-Policy stripping still under-counts, as the digest already notes.

**Google Search Console adds four things per URL, and pair pages are URLs.** AECI-820 (Stage 2.5, High) provisions the service account and pulls platform-level Search Analytics. The same API, filtered by page, gives each vendor's `/vendors/:slug`, `/products/:slug`, and pair-page URLs their own **impressions, clicks, click-through rate, and average position**, sixteen months back, at a two-to-three-day lag. This is the one channel where pair-page attention is measurable before finding 1 is fixed, because Google keys on the URL. Three more reads worth planning:

| Read | What it gives a vendor | Constraint |
| --- | --- | --- |
| Search Analytics, query dimension filtered by the vendor's pages | The search phrases that surfaced their pages ("procore quickbooks integration"). The most persuasive discovery evidence, in the buyer's words. | Google withholds rare queries, so small vendors see a partial list. Aggregate only; never store query text against a visitor. |
| Search Analytics, `searchAppearance` dimension | Whether their pages earn rich results. | Sparse. |
| URL Inspection API, weekly, per paying vendor's URLs | Index verdict, Google's last crawl time, selected canonical, robots state. The authoritative "when did Google last crawl your page" answer beside our own bot rows. | Quota is about 2,000 inspections a day per property and AECI-824 needs it clean. Budget it explicitly: paying vendors only, weekly, their listed URLs only. Never use it to sample an indexed count (the AECI-820 rule). |
| Crawl stats and Page indexing reports | Nothing. | UI-only, no API. |

The property is a Domain property spanning `www.` and `demo.`, so every stored row carries its host filter (the AECI-820 rule). AECI-820 as written stores platform keys in `metrics_daily`, which has no page dimension, so the per-URL pull needs its own table or a per-vendor rollup, the same decision as finding 5.

**Bing Webmaster Tools is cheaper to integrate and reaches further than Bing.** AECI-799 verified the property. The API is key-based (no OAuth) and, from memory of the reference, offers per-URL page stats, per-URL query stats, site crawl stats by day, per-URL info (last crawled, discovered, status), crawl issues, inbound link counts, and a keyword-volume read. Method names must be checked against the Bing Webmaster API reference before an issue is written. Two reasons it matters more than its share of search suggests: Bing's index feeds DuckDuckGo, Yahoo, and the web results behind Microsoft Copilot and ChatGPT search, so Bing impressions are the closest available proxy for exposure inside those assistants; and the keyword-volume read can estimate demand for a phrase such as "A B integration", which is a per-pair external demand figure no on-site signal can give. Every Bing figure must be labelled as Bing's, never blended with Google's.

**Further ideas, each checked for a data source**

1. **Catalogue presence, not traffic.** Derivable today with no instrumentation: how many pair pages list the vendor's products, how many carry an attestation, how many sit in `single_source` or conflict state waiting on a counterparty, how many pairs are connector-reachable (the AECI-892 reach count), and any open corrections. This is the "what to fix" section's real content and it is meaningful at zero traffic.
2. **Category percentile instead of platform totals.** "Your product is in the top quarter of Estimating products by views" discloses less than a share-of-catalogue count and answers the same question. Small categories need a suppression floor.
3. **An edit-to-recrawl timeline.** The AECI-826 IndexNow buffer records when a changed URL was submitted; GSC last-crawl and Bing URL info record when each engine fetched it again. Shown together, "your edit on the 10th was submitted within the hour and Bing re-crawled on the 12th" is service-level proof that editing the listing does something, without claiming it moved traffic. The buffer is drained, so a submission ledger would need to be retained.
4. **Trending appearances.** `home.trending_products` is computed daily and never snapshotted. Persisting the five slugs per day is one small write and gives "your product appeared in Trending on N days this month".
5. **External demand context from the review app.** The curation app already computes search demand and Reddit mentions per product (`compute_product_search_demand`, `compute_product_reddit_mentions`). Neither is promoted into the app database. If they were promoted as product fields, the page could show demand context beside on-site attention, labelled as an external estimate with its source and date.
6. **Backlinks to their AECi pages.** Bing's inbound link count per URL is a minor trust signal for vendors and costs nothing once the Bing pull exists.

### Revised sequencing

1. Pair-page attribution on `page_views` (migration, resolver, ingest, `concrete_path` parse) is **AECI-929**. The outbound-click ownership properties are not yet filed. Both are small, additive, and useful to the admin panel on their own.
2. Wait for AECI-872's classification record and read it.
3. The reporting endpoint and page, with the caveat envelope, the share-of-catalogue decision made, and fixtures for the preview surface.
4. Per-page GSC dimension on top of AECI-820.
5. Per-vendor rollup table, only if an annual report is promised.
6. Enquiries, as a separate feature with its own spec.

## Quick decisions

- Propose a Performance page focused on recorded attention and outbound actions.
- Prioritize product and integration-pair breakdowns, which make the evidence specific to AECi.
- Fix event coverage and vendor attribution before presenting totals as commercial proof.
- Keep clicks, leads, and confirmed revenue as distinct measures.
- Include a shareable monthly report and honest zero, missing, and low-volume states.
- Defer audience identification, cost metrics, and lead-generation scope until their data and commercial model are defined.
- Keep this as a discovery draft pending the commercial emphasis and requested visual fidelity.
- Fix pair-page attribution first (AECI-929); it unlocks integration views and crawls together, and integration pages carry equal weight to product pages in every section. Outbound-click ownership is the other prerequisite.
- Read AECI-872's versioned classification rather than adding predicates.
- Decide whether vendors may see platform totals (share-of-catalogue) before the first release.
- Decide the stage (Stage 3, or an admitted Stage 2.5 exception) before seeding Linear.
- Crawl counts per vendor exist today for product and vendor pages; split them by purpose (index, training, on-demand fetch) via AECI-762 before showing them, and re-check the AI Crawl Control presets after 2026-09-15.
- Google Search Console per-URL data reaches pair pages before our own attribution does; plan the per-URL pull as an extension of AECI-820 and budget URL Inspection for paying vendors only.
- Add Bing Webmaster Tools; it is key-based and proxies Copilot and ChatGPT-search exposure.
