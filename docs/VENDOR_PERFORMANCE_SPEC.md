# AEC Integrations — Vendor Performance Reporting Specification

**Version:** 0.1 — **build contract** (the decomposition of the three vendor-performance epics)
**Date:** 2026-09-14
**Status:** Build contract, admitted into **Stage 2.5** as the second named exception to its "no new surface area" rule (`STAGE_2_5_SPEC.md` §10). Promotes `docs/design/vendor-performance-direction.md` from discovery draft to a buildable spec; that draft stays as the rationale record and the evidence of the 2026-09-14 repository verification. Decisions in §1.1 were settled with the operator on 2026-09-14.
**Supersedes:** nothing. `STAGE_2_SPEC.md` §2.2 and §8.1(3) list "vendor analytics" as a Verified benefit; this is that benefit's contract.
**Inherits from:** Stage 1 / 1.5 / 2 — every constraint carries. In particular the no-pay-for-placement firewall (`STAGE_2_PAID_TIERS_SPEC.md` §3.2): this surface **reports** attention and never influences it.
**Companion docs:** `ANALYTICS.md` (events, consent tiers — §2, §3), `ADMIN_PANEL_SPEC.md` (`page_views`, classification, caveat envelope — §2, §4.4), `DATABASE_SCHEMA.md` §9 (analytics tables — §3), `API_CONTRACTS.md` §6.14 (vendor portal endpoints — §4), `AUTH_AND_RLS.md` §4 (Layer-1 authz — §4.3), `STAGE_2_REALTIME_SPEC.md` (why this page is not a live scope — §4.3), `STAGE_2_PAID_TIERS_SPEC.md` (the `analytics.view` capability — §4.3), `waf-rate-limits.md` §3b (the AI-crawler allow posture the crawl panel depends on — §2.3).

> **Data-layer note (ADR 0016 / 0021).** Every write goes through `getDb(env)` and a single `db.batch([...])`. The reads in this spec are reads: **no `audit_log` row**, no rate limit (AECI-773), no live-portal scope (§4.3). There is no Prisma, no Postgres, no RLS on app tables.

---

## 1. Overview

**The question the page answers:** *what attention did our listings receive, what did visitors do next, and what should we improve?* It exists so a vendor's founder or marketing lead can decide whether their AECi presence deserves continued investment, and so AECi can show that the information it holds is being seen.

**What it must never do:** claim that paying caused exposure, turn a click into a lead, turn a request into a person, or feed anything back into ranking. The rationale for each of those is in the discovery draft and is not repeated here.

**Integration pages carry equal weight to product pages** in every section. AECi is a directory of integrations; a product-only view of attention misrepresents it. That is why AECI-929 is the first blocker (§3.1).

### 1.1 Decisions (settled 2026-09-14)

| # | Decision | Answer |
|---|---|---|
| 1 | Stage | **Stage 2.5**, all three epics. Admitted under `STAGE_2_5_SPEC.md` §10. |
| 2 | Commercial placement | **Included in Verified.** `analytics.view` is already held by the `verified` tier (`packages/shared/src/entitlements.ts`); no new rung. |
| 3 | Comparative figures (share of catalogue, category percentile) | **None until Stage 3, possibly 4.** The page shows the vendor's own counts only. Recorded in `STAGE_3_SPEC.md` §4. |
| 4 | Privacy policy | **Add a sentence** that aggregate listing statistics are shared with the vendor whose listing they concern, and that **no individual's information is included**. Exact wording in §7.1. |
| 5 | Who sees it inside a vendor | **All seats** (owner and members). |
| 6 | Monthly report delivery | **In-app download only.** Emailed reports are **Stage 4** (`STAGE_3_SPEC.md` §4). |
| 7 | Search consoles | **Google Search Console and Bing Webmaster Tools both in scope.** The operator provisions the GSC service account (shared with AECI-820) and the Bing API key. |
| 8 | Pre-claim history | **Shown**, labelled as the organic baseline recorded before the vendor claimed. |
| 9 | Design fidelity | **Wireframes before any build**, produced with Mobbin under the Anchor-Site Rule. The wireframe issue blocks the page issue. |

Defaults taken without objection: report days are **UTC**, labelled on the page; nav label **Performance**; route `/vendor/:vendorSlug/performance`.

### 1.2 Issue map & build order

Three epics. Each sub-issue opens with `**Spec section:** §X.Y (docs/VENDOR_PERFORMANCE_SPEC.md)`. **The subsection numbering below is load-bearing — do not renumber without updating the issues.**

| Epic | Anchor | Issue | Surface |
|---|---|---|---|
| **A — Measurement foundation** | §3 | **AECI-930** | Makes the counts attributable and honest. Operator-facing; no new public surface. |
| A | §3.1 | AECI-929 | Pair-page views and crawls attributed to both endpoint products (filed first, High) |
| A | §3.2 | AECI-933 | Outbound-click ownership properties on `external_link_clicked` |
| A | §3.3 | AECI-934 | Vendor self-visit exclusion flag at ingest |
| A | §3.4 | AECI-935 | Consented pair-page view event + `ANALYTICS.md` catalogue fix |
| A | §3.5 | AECI-762 (existing, under AECI-788) | Crawler purpose split; related, not re-parented |
| **B — Search-console channel** | §6 | **AECI-931** | Per-URL search data for the vendor's pages |
| B | §6.4 | AECI-949 | Operator: Google service account (shared with AECI-820) + Bing API key; blocks 936 and 938 |
| B | §6.1 | AECI-936 | Per-URL storage + Google Search Analytics per-page pull (extends AECI-820) |
| B | §6.2 | AECI-937 | Weekly URL Inspection for paying vendors' URLs |
| B | §6.3 | AECI-938 | Bing Webmaster Tools pull |
| **C — The Performance page** | §4, §5, §7 | **AECI-932** | The vendor-facing surface. Blocked by A. |
| C | §5.4 | AECI-939 | Wireframes via Mobbin (blocks the page build) |
| C | §4 | AECI-940 | `GET /api/vendor/performance` + caveat codes + CSV export |
| C | §5 | AECI-941 | The page: route, nav, sections, states, fixtures |
| C | §7 | AECI-942 | Public disclosures: privacy policy sentence + `/methodology` update |

**Build order.**

```
A: 929 → 933 ∥ 934 ∥ 935      (762 runs on its own epic; C reads its output when present)
B: 820 (existing) ∥ 949 (operator credentials) → 936 → 937 ∥ 938
C: 939 (wireframes) → 940 (endpoint) → 941 (page) → 942 (disclosures, same release as 941)
C is blocked by A. C may ship before B; the search-console section then renders its "not yet connected" state (§5.3).
```

### 1.3 Explicitly not in this contract

Comparative figures (decision 3), emailed reports (decision 6), enquiries or any outcome layer (§8), on-site listing impressions in browse and search results (§8), per-vendor history beyond the 400-day `page_views` retention (§3.7), and any capability that touches ranking.

---

## 2. Measurement contract

### 2.1 Sources and what each can honestly say

| Source | Consent | What it counts | Use on the page |
|---|---|---|---|
| D1 `page_views` | none (Tier 1, server-side, `ANALYTICS.md` §5) | Every full-document arrival and SPA navigation, including crawlers, with `is_bot` / `bot_name` and the entity ids | **Views and crawls.** The primary source. |
| PostHog product events | opt-in (Tier 3) | `product_viewed`, `external_link_clicked`, and (after §3.4) the pair-page view event | **Outbound clicks only.** Never totals: it is a funnel, not a census. |
| Google Search Console | n/a | Per-URL impressions, clicks, CTR, position; per-URL index verdict and last crawl | **Discovery** (§6). Two-to-three-day lag. |
| Bing Webmaster Tools | n/a | Per-URL page and query stats, per-URL last crawl | **Discovery** (§6). Labelled Bing's, never blended with Google's. |

### 2.2 Population and classification

The report reads **one** population definition, the versioned classification record AECI-872 introduces (`ADMIN_PANEL_SPEC.md` §13 D19 when agreed; `DATABASE_SCHEMA.md` §9.7). Until that record exists the report reads the same predicates the digest and `/admin/overview` read (`lib/page-view-predicates.ts`), and says so in its caveat envelope (§4.4). It adds **no third predicate set**. Days evaluated under different classifier versions are flagged, never blended, and the version in force is shown in the definitions block (§5.2 item 7).

Rows from 2026-09-07 to 2026-09-12 are degraded (AECI-868) and carry the corresponding caveat when the range includes them.

### 2.3 Counting rules

1. **A view is one `page_views` row** for the vendor's entity, after the §2.2 population filter, excluding operator rows (`is_operator`) and owner-visit rows (§3.3). Arrival and SPA rows both count; the AECI-743 dedupe key already prevents the double-fire.
2. **A crawl is one `page_views` row with `is_bot = 1`** for the vendor's entity, grouped by purpose: **search indexing**, **AI training**, **on-demand assistant fetch**, **preview / social**, **other**. Until AECI-762 lands the purpose split, the page shows the operator label (`bot_name`) and marks purpose as unavailable. A crawl is a request. The page states that it is not indexing, not model inclusion, and not a citation.
3. **On-demand assistant fetches** (`ChatGPT-User`, `Perplexity-User`, `Claude-User`) are reported on their own line: each one means a person asked an assistant a question and the assistant fetched the vendor's page. They are the nearest observable thing to an AI-answer referral.
4. **Crawl history for AI crawlers starts 2026-09-09** (AECI-800). The zone-level allow posture in `waf-rate-limits.md` §3b is a measurement dependency; when it changes, the crawl panel changes with no error. The DQ check in §3.5 exists for that, and **AECI-948** (due 2026-09-16) is the operator re-check after the toggle deprecates.
5. **A pair view counts once for each endpoint product**, and **once in the vendor's total** even when the vendor owns both endpoints. Both URL orientations are one pair.
6. **Outbound credit follows destination ownership** (§3.2). A click to the other endpoint's website or to a connector's listing is not a visit delivered to this vendor. Pair-page interest and clicks delivered to the vendor are separate measures.
7. **Unknown is a state, not zero.** Unavailable source, outage, no eligible activity, and degraded telemetry are different states and each has a caveat code (§4.4) and a rendering (§5.3). Missing days are gaps in the chart, never zeroes.
8. **Previous period** is the same-length window immediately before, in absolute counts beside the change. A zero previous period shows counts only, never a percentage.
9. **Pre-claim history is shown** (decision 8), labelled "before you claimed this listing" from the claim's approval date. The page must not present post-claim growth as caused by claiming.
10. **Definition changes are dated** in the definitions block. No growth is computed across a classifier version boundary.

### 2.4 Privacy

Aggregate only. No individual browsing trail, no visitor-attributed search text, no inferred company identity, no contact details, no per-visitor row. The one text this report carries is the search-console **per-URL query aggregate** (§6.1) — Google's and Bing's own already-aggregated top queries for a page, never joined to a visitor, a session, or a `page_views` row. Country and referrer-source breakdowns apply a small-group floor (fewer than 5 rows in a cell renders as "fewer than 5"), and the floor also applies to the CSV export so a filter cannot reconstruct a suppressed cell. The privacy policy sentence in §7.1 ships in the same release as the page.

---

## 3. Data model — Epic A (measurement foundation)

### 3.1 Pair-page attribution on `page_views` — AECI-929

The contract is the issue. Summary: two nullable product columns holding the pair's endpoints as an **unordered pair** (canonical order), keyed on product ids and never on an integration row id (edges move between `integrations` and `connector_evidenced_pairs`; a pair page with no edge still renders). `product_id` stays NULL on pair rows so the existing XOR readers hold. Partial index mirroring `page_views_product_idx`. Retraction deletes pair rows referencing either endpoint. One-time `concrete_path` backfill under `scripts/ops/`, not run against production inside that issue. `home.trending_products` and the admin product breakdown count pair views for both endpoints.

### 3.2 Outbound-click ownership — AECI-933

`external_link_clicked` gains four properties, all identifiers (`ANALYTICS.md` §2): `owner_vendor_id` (the vendor whose destination this is, or null when unknown), `source_entity_type` (`product` | `vendor` | `pair`), `source_entity_id` (for a pair, the canonical unordered pair key), `link_purpose` (`website` | `docs` | `listing` | `social` | `connector`). The directive already receives `source`; the owning component supplies the rest via inputs. Historical events without these properties stay unattributed; **no backfill from URLs**.

Surfaces today: `product_detail` (product website), `vendor_detail` and `vendor_detail_social`, `pair_detail` (listing and docs URLs per mechanism). The mechanism's owner is `built_by_vendor` when present, else the connector product's vendor for `powered_by_product`, else null.

### 3.3 Vendor self-visit exclusion — AECI-934

`page_views.is_owner_visit` (boolean, NULL = unknown, reads as not owner). Set at ingest by extending `lib/operator-session.ts` to return `vendor_id` for a verified `vendor_admin` session; the flag is `1` when the row's entity (product via `product_vendors`, vendor, or either pair endpoint) belongs to that vendor. One boolean whose only consumer is an exclusion predicate, no identity stored, the same D7-safe shape as `is_operator`. Signed-out self-visits stay unknowable and the page says so.

### 3.4 Consented pair-page view event — AECI-935

`integration_viewed` has no emitter and its catalogue row cites a file that no longer exists. Re-home it: emit from the pair page with `product_a_id`, `product_b_id` (canonical order) and `source`. Fix the `ANALYTICS.md` §4 row in the same PR (§7 checklist item 4). It exists so the outbound funnel on pair pages has a denominator in the same consented slice as its clicks; it is never a total.

### 3.5 Crawler purpose split — AECI-762 (existing)

Not re-parented. What this spec needs from it: a `bot_purpose` value beside `bot_name` (index / training / assistant-fetch / preview / other), `Claude-User` and `Claude-SearchBot` matched, `perplexity-user` and `chatgpt-user` separated from their index crawlers, and a DQ check that AI-crawler rows have not dropped to zero for three consecutive days (the §2.3(4) dependency). A comment recording these asks is on the issue.

### 3.6 Search-console per-URL storage — AECI-936

`search_console_daily` (`DATABASE_SCHEMA.md` §9, new subsection): `day`, `engine` (`google` | `bing`), `host`, `url`, `product_id` / `vendor_id` / pair columns resolved from the URL at write time (nullable, existence-checked), `impressions`, `clicks`, `ctr`, `position`, `fetched_at`. Primary key `(day, engine, host, url)`. Every row carries its host filter (the AECI-820 rule). Index-status reads (§6.2) land in `search_console_url_status`: `url`, `engine`, `verdict`, `last_crawled_at`, `canonical_url`, `checked_at`. Neither table joins `metrics_daily`, which stays platform-wide.

### 3.7 Retention and rollups

`page_views` retention is 400 days (`PAGE_VIEWS_RETENTION_DAYS`) and the page aggregates live over `page_views_product_idx` and the §3.1 pair index, the same pattern as the admin panel. **No per-vendor rollup table in this contract.** Re-open trigger: the first vendor anniversary, or a request for a comparison older than 400 days. `search_console_daily` is retained indefinitely (it is small and is the only copy).

---

## 4. API contract — Epic C

Full shapes go in `API_CONTRACTS.md` §6.14 when AECI-940 lands; this section fixes the semantics.

### 4.1 `GET /api/vendor/performance`

Query: `from`, `to` (UTC `YYYY-MM-DD`, default the last 30 complete days, maximum 400 days back), `product` (optional owned product id; a miss is 404, the AECI-520 rule). Response:

```
{
  window: { from, to, timezone: 'UTC', previous: { from, to } },
  measurement: { started_at, classifier_version, claimed_at | null, last_refreshed_at },
  totals: { profile_views, product_views, pair_views, outbound_clicks, crawls, assistant_fetches }  // each { current, previous }
  series: [{ day, profile_views, product_views, pair_views, outbound_clicks } | { day, unavailable: true }]
  products: [{ product_id, slug, name, views, pair_views, outbound_clicks, previous: {...} }]
  pairs: [{ pair_key, products: [{id, slug, name}], views, crawls, assistant_fetches, outbound_clicks_to_you, outbound_clicks_elsewhere, previous: {...} }]
  crawls: [{ purpose, bot_name, count }]
  sources: [{ referrer_source, arrivals }]            // small-group floor applied
  search: { google: {...} | { unavailable: reason }, bing: {...} | { unavailable: reason } }   // §6
  suggestions: [{ kind, entity, href }]                // ≤ 3, §5.2 item 6
  notes: VendorNote[]                                  // §4.4
}
```

Every number is a count of rows after the §2 rules. `distinct visitors` does not exist on this contract.

### 4.2 `GET /api/vendor/performance/export`

Same query, `Content-Type: text/csv`, one row per day per metric, plus a header block carrying `window`, `measurement`, and the note codes, so the file is self-describing. The small-group floor applies. The print-friendly monthly report is the page's own print stylesheet over the same payload; there is no server-rendered PDF.

### 4.3 Authorization and gating

- `requireVendor()` then `requireCapability(c, 'analytics.view')`, in that order. The vendor id comes from the session and never from the request. All seats (decision 5): no owner check.
- A connector-only vendor holds no `vendor_entitlements` row (`STAGE_2_SPEC.md` §8.9) and therefore never passes the gate; the no-entitlement state (§5.3) must not imply that vendor can buy its way in. A `hybrid` vendor counts as an endpoint and does.
- **No `audit_log` row** (a read). **Never rate-limited** (AECI-773). **Not a `VendorPortalScope`**, not in `GET /api/vendor/updates`, not in `GET /api/vendor/me`; the page fetches on demand and re-fetches on its own filter changes only.
- `requireCapability` is the first consumer of `analytics.view`; no registry edit.

### 4.4 Caveat envelope — `VendorNote`

A **vendor-safe subset** of `AdminNoteCodeSchema` (`packages/shared/src/api/admin-panel.ts`), exported from a new `packages/shared/src/api/vendor-performance.ts` with the same `{ code, message }` shape, so the operator console and the vendor page describe the same bias in the same words. Minimum codes: `automation_filter_applied`, `arrival_telemetry_degraded`, `classifier_version_changed`, `search_console_not_connected`, `search_console_stale`, `pair_attribution_starts_at` (the AECI-929 backfill boundary), `small_group_suppressed`, `partial_failure`. Codes are additive; removing one is a contract change.

---

## 5. The page — Epic C

### 5.1 Route, nav, fixtures

- Route `performance` under `VENDOR_SECTION_ROUTES`, one entry in `VENDOR_NAV_ITEMS` labelled **Performance** (the two-file rule). It is vendor-level, not product-level; the product filter lives on the page.
- `/preview/vendor-dashboard/performance` renders the same component against fixtures, and the fixture set includes the zero-activity, no-entitlement, degraded, and search-not-connected states on day one.
- Data loads on demand from §4.1, never through `VendorPortalStore`.

### 5.2 Sections, in order

1. **Period and scope.** Default last 30 complete days; 7 / 90 / custom where history exists. Product filter. Shows timezone (UTC), measurement start date, claim date when present, last refresh, classifier version.
2. **Attention and actions.** Profile views, product views, pair views, outbound clicks, crawls, assistant fetches. Views and actions never share a card. Previous-period absolute counts beside changes. No funnel across unmatched populations.
3. **Activity over time.** One metric at a time with its previous period. No dual axes. Table alternative. Gaps stay gaps.
4. **Product performance.** Sortable table: views, pair views, outbound clicks, change. Row selection narrows the page.
5. **Integration interest.** Same columns as the product table, plus crawls and assistant fetches per pair, both orientations merged. Selecting a pair shows outbound clicks split into "to you" and "elsewhere" with destination ownership. Delivered / reachable / buildable vocabulary retained where it applies.
6. **Crawlers and discovery.** Crawls by purpose with the §2.3(2) disclaimer; referrer sources with the small-group floor; the search-console block (§6) or its not-connected state; at most three suggestions, each an evidence-attached gap (an unconfirmed claim on a viewed pair, a missing docs URL on a clicked mechanism, an empty rich field on a viewed product), linking to the existing editor and promising nothing about traffic or ranking.
7. **Download and definitions.** CSV export; print view; inline definitions naming every rule in §2 in plain words, including the crawl disclaimer and the pre-claim label.

### 5.3 States

| State | Behaviour |
|---|---|
| First use | Measurement start date and when the first complete report will exist. |
| Valid zero | "No recorded activity" with one profile-management action. Never implies an upgrade brings visitors. This is the **normal** launch state (draft finding 2). |
| Small sample | Counts stay; percentages and breakdowns withheld. |
| Loading | Skeletons in the report layout. |
| Partial failure | Available sections stay; stale sections show their timestamp and an inline retry. |
| Degraded telemetry | The interval is marked and the chart does not join across it. |
| No entitlement | Explains that Performance is part of Verified; portal and plan panel stay reachable. Connector-only wording per §4.3. |
| Search not connected / stale | The block explains the console is not connected or the last pull is older than 7 days. |
| Long history | States the earliest available date (400 days). |

### 5.4 Design — wireframes first (decision 9) — AECI-939

Before any component is written: `/impeccable critique` of the existing portal for the baseline, then a Mobbin search for the anchor site of *this* surface (an analytics or performance dashboard inside a B2B product that reads restrained and evidence-first), recorded on AECI-939 under the Anchor-Site Rule. Wireframes for sections 1–7 and every §5.3 state, on desktop and a narrow viewport, reviewed by the operator before AECI-941 starts. Design work then runs the `CLAUDE.md` design checklist: build via Impeccable, `npx impeccable detect` against the running route (never a file path), axe locally, light theme only.

### 5.5 Accessibility and i18n

Every visible string through `i18n` / `$localize`. The chart has a table alternative and never encodes meaning in colour alone (`dataviz` skill). Keyboard-operated filters and sortable headers with visible focus. Long product names wrap. The suggestions list is a list, not a card grid.

---

## 6. Search-console channel — Epic B

### 6.1 Google per-URL pull — AECI-936

Extends AECI-820's weekly pull. Same service account, same host-filter rule. Search Analytics with `page` dimension for every catalogue URL (`/vendors/:slug`, `/products/:slug`, pair pages), writing `search_console_daily` (§3.6). The `query` dimension is pulled **per page in aggregate** and stored only as counts of distinct queries plus the top ten query strings per page, which is what Google already exposes and never joins a visitor. `searchAppearance` per page is stored where present. Fail-open, `discardResponseBody` on every unread body, no unbounded fan-out (AECI-666).

### 6.2 URL Inspection — AECI-937

Weekly, **paying vendors' URLs only** (those with an active `vendor_entitlements` row), writing `search_console_url_status`. Budget stated in code as a constant with the reasoning: the quota is roughly 2,000 inspections a day per property and AECI-824 needs it clean; never used to sample an indexed count (the AECI-820 rule). If the budget is exceeded the job stops and warns; it never fails the cron.

### 6.3 Bing Webmaster Tools — AECI-938

Key-based API. Per-URL page stats and per-URL query stats into `search_console_daily` with `engine = 'bing'`; per-URL info (last crawled, discovered) into `search_console_url_status`. **Method names are verified against the Bing Webmaster API reference in the issue before any code**, because this spec's list came from memory. Bing's index feeds DuckDuckGo, Yahoo, Copilot, and ChatGPT search, which is why it is in scope; every Bing figure is labelled Bing's.

### 6.4 Credentials

The operator provisions the GSC service account (shared with AECI-820) and the Bing API key, per the per-env secret convention in `environments.md` — tracked as **AECI-949**, which blocks AECI-936 and AECI-938. Absent credentials → the block renders "not connected" (§5.3); nothing errors.

---

## 7. Public disclosures — AECI-942

### 7.1 Privacy policy

Add to `apps/web/src/content/legal/privacy-policy.md`, in the sharing section, in sentence case:

> We share aggregate statistics about a listing, such as how many times it was viewed, crawled by search engines, or clicked through, with the vendor that owns that listing. These statistics are counts only. They do not include your name, email address, IP address, browsing history, search terms, or any other information about you as an individual.

Update the "last updated" date. Ships in the same release as AECI-941, never before it.

### 7.2 `/methodology`

`STAGE_2_5_SPEC.md` §7.1 point 5 currently **forbids** the page from claiming `analytics.view` does anything, and the shipped page says nothing about analytics at all — verified 2026-09-14: `apps/web/src/content/methodology.md` contains no analytics sentence, and `methodology.component.spec.ts` pins the `integration.version_diff` halves, not this. So AECI-942 **adds** a sentence rather than editing one:

> Verified vendors can see aggregate attention statistics for their own listings. Those statistics have no effect on ranking, placement, or badges.

Amend `STAGE_2_5_SPEC.md` §7.1 point 5 in the same PR so the prohibition it states no longer contradicts the page, and pin the new sentence in `methodology.component.spec.ts` the way point 5's other halves are pinned.

---

## 8. Deferred, with re-open triggers

| Item | Where it goes | Trigger |
|---|---|---|
| Comparative figures (share of catalogue, category percentile) | Stage 3, possibly 4 (`STAGE_3_SPEC.md` §4) | Vendor feedback asking "compared to what"; a disclosure decision on platform totals. |
| Emailed monthly report | Stage 4 (`STAGE_3_SPEC.md` §4) | A vendor asks for it, or renewal conversations show the in-app export is not being used. |
| Enquiries and outcomes (submitted, accepted, demo, won) | Separate spec | The commercial model adds a lead-generation offer. |
| On-site listing impressions (browse, search results) | Not scheduled | A vendor question the search-console data cannot answer. |
| Per-vendor rollup table | §3.7 | First vendor anniversary. |
| Edit-to-recrawl timeline, Trending appearances, external demand from the review app, Bing backlink counts | Draft "further ideas" | Pilot vendor feedback after the first release. |

---

## 9. Docs to update as each issue lands

| Issue | Docs |
|---|---|
| AECI-929 | `DATABASE_SCHEMA.md` §9.1, `ADMIN_PANEL_SPEC.md` §7.3 + §13, `POST_LAUNCH_MONITORING.md` if the digest's top-products table changes |
| AECI-933, AECI-935 | `ANALYTICS.md` §4 (rows), §6 (funnel) |
| AECI-934 | `DATABASE_SCHEMA.md` §9.1, `ADMIN_PANEL_SPEC.md` §13 (a decision beside D13) |
| AECI-936, AECI-937, AECI-938 | `DATABASE_SCHEMA.md` §9 (new subsections), `OBSERVABILITY.md` (the crons), `environments.md` (secrets), `ANALYTICS_BASELINE.md` (what is now automatic) |
| AECI-940 | `API_CONTRACTS.md` §6.14, `AUTH_AND_RLS.md` §4 (the capability consumer) |
| AECI-941 | `STAGE_2_VENDOR_PORTAL_SPEC.md` §6 (an as-built subsection), `DESIGN.md` (the surface entry and its anchor site), `docs/design/LESSONS.md` |
| AECI-942 | `privacy-policy.md`, `/methodology` content, `STAGE_2_5_SPEC.md` §7.1 |
| all | this document's as-built subsections; `CLAUDE.md` source-of-truth row if the description changes |

## 10. Cross-references

- `docs/design/vendor-performance-direction.md` — the discovery draft and the 2026-09-14 verification findings this contract rests on.
- `STAGE_2_5_SPEC.md` §10 — the admission paragraph.
- `STAGE_3_SPEC.md` §4 — the two deferrals recorded there.
- `ADMIN_PANEL_SPEC.md` §7.3, §13 — `page_views` ingest and its decisions.
- `STAGE_2_PAID_TIERS_SPEC.md` §3.1–§3.3 — the capability registry and where `hasCapability` may be consulted.
- `STAGE_2_REALTIME_SPEC.md` §2.2 — the cursor invariant this page stays outside.
