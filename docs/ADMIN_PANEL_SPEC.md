# AEC Integrations — Admin Panel Specification (Operator Console)

**Version:** 1.0 — **build contract**
**Date:** August 2026 (v1.0 promoted 2026-08-12 by AECI-573)
**Status:** **Build contract.** Scope, data inventory, build order, and timing are all settled. §13 **D1** places this in **Phase 8.3** — post-launch operate-and-tune, per `PHASE_8_COMPLETION.md` §F4 and Note D — on the **`main` line**, integrated via the **`admin-panel`** epic branch. Sections are numbered so a Linear issue can anchor to one via `**Spec section:** §X (docs/ADMIN_PANEL_SPEC.md)` per the `spec-anchor` skill.
**Inherits from:** Stage 1 (`STAGE_1_SPEC.md`, §22 admin surfaces + §26 audit), Phase 5.12–5.14 (the `/admin` shell + gate), Phase 6.9–6.11 (the requests + reviewer queues)
**Tracker:** epic **AECI-572**, sub-issues **AECI-573 … AECI-587** (mapped to the §10 build order). AECI-573 was the decision gate: it settled §13's seven open questions as **D5–D11**, chose the phase and base branch (**D1**), and promoted this document from draft to contract.
**Companion docs:** `API_CONTRACTS.md` (endpoint shapes), `DATABASE_SCHEMA.md` (tables/indexes), `OBSERVABILITY.md` (Datadog metric catalog), `POST_LAUNCH_MONITORING.md` (the runbook this panel operationalizes), `ANALYTICS_BASELINE.md` (what PostHog does and does not see), `email.md` (the two cron digests), `AUTH_AND_RLS.md` (`requireAdmin()`), `adr/0022-cron-bookkeeping-exempt-from-audit-invariant.md` (the §26.1 carve-out this epic's crons rely on)

> **Data-layer note (ADR 0016).** The application database is **Cloudflare D1 + Drizzle**; Supabase is auth-only. Every read in this document goes through `getDb(env)`. The panel's HTTP surface is **read-only** — every endpoint is a `GET`, and none of them writes, emails, purges, or calls an external API (§6, §13 D8). The only writes in the epic are the two cron-written bookkeeping tables (§7.1, §7.2) and the retention prune (§7.4); §13 **D11** and **ADR 0022** govern their audit obligations — bookkeeping inserts are exempt from the §26.1 audit-in-batch invariant, scheduled deletes are not.

---

## 1. Overview and motivation

AECi has three operator-facing information channels today, and none of them is a screen:

1. **The daily analytics digest** (`lib/analytics-digest.ts`, 05:00 UTC cron → `ANALYTICS_DIGEST_EMAIL_TO`) — yesterday's traffic, top products, sources, sign-ins, moderation depth, crawler activity.
2. **The daily data-quality digest** (`lib/data-quality.ts` + `lib/data-quality-email.ts`, 04:00 UTC cron → `ADMIN_ALERT_EMAIL`) — ten catalog-integrity checks.
3. **Datadog + PostHog** — infrastructure metrics, and consented product analytics.

Each has a structural limit. The emails are **push-only and yesterday-shaped**: you cannot ask a follow-up question, drill into a number, or look at a range. The data-quality checks are computed daily and then **discarded into an inbox** — nothing persists them. And PostHog, by design, sees only the slice of traffic that clicks **Accept** on the consent banner (`app/analytics/consent.ts` is strict opt-in; `posthog-js` is not even imported until `state() === 'granted'`).

That last point is the immediate trigger for this work. On 2026-08-10 the digest reported 92 human page views across four traffic sources; PostHog recorded essentially none of them, because a single-page arrival from Google never grants consent. The **D1 `page_views` table is the consent-independent record of who visits AECi**, and today it has no read surface at all — `ANALYTICS_BASELINE.md` describes it as "write-only today (no reporting endpoint); query D1 directly."

**This panel is the pull-based operator console over data AECi already collects.** It does not replace the emails (§13, decision D2) — push keeps the daily nudge; pull answers the follow-up.

### 1.1 Design principles

- **Read what exists before collecting more.** Phase 1 (§10) adds **zero schema changes**; it renders data already in D1.
- **Be honest about resolution.** Every number states its window, its timezone, and its known bias (bot heuristic, referrer stripping, no sessions). A panel that quietly overstates certainty is worse than an email.
- **Operator-first, not stakeholder-first.** This is a working tool for catalog and traffic decisions, not a metrics showcase.
- **Never pollute what it measures.** The panel must not write `page_views` rows for its own navigation (§9.6).

---

## 2. Scope and non-goals

**In scope**

- A `/admin` console covering traffic, audience, catalog, moderation, and system health (§5).
- Read-only API endpoints behind `requireAdmin()` (§6).
- A daily metrics-snapshot table so counts-over-time become answerable (§7.1).
- Persisting cron and data-quality results so "current status" is inspectable (§7.2) — **shipped, AECI-583**.
- Hand-rolled SVG charts, no new client dependency (§8).

**Out of scope**

- Any public or vendor-facing analytics. Vendor-visible stats are Stage 2 (`STAGE_2_SPEC.md`).
- Replacing Datadog or PostHog. The panel **links out**; it does not re-implement APM, RUM, or funnels.
- Editing catalog data. Promotion remains the review-app → `POST /api/promote` path (`REVIEW_APP_PROMOTE_API.md`).
- Real-time / streaming updates (Stage 2 concern).
- De-anonymizing visitors (§9.7).

---

## 3. Data inventory (what exists today)

Census taken against **production D1 on 2026-08-12**. These numbers decide what is worth building first — several engagement tables are empty, and a panel over them renders zeros.

| Source | Rows / state | Time-series capable? |
|---|---|---|
| `page_views` | 26,126 rows, 2026-06-23 → present | **Yes** — raw event log with `created_at` |
| `audit_log` | ~9,300 rows, 2026-06-26 → present | **Yes** for *events*; not for net totals (§4) |
| `products` | 171 (all `promotion_status='promoted'`) | `created_at` only — **not** a go-live date (§4) |
| `integrations` | 496 | same caveat |
| `vendors` | 126 | same caveat |
| `claims` / `attestations` | 915 / 915 | `created_at` present |
| `taxonomy_*` | 33 categories · 30 audiences · 5 phases · 34 trades · 20 data objects | static vocabularies |
| `product_categories` | 373 | — |
| `product_trades` | **0** — the fourth facet (AECI-538) is live but untagged | — |
| `profiles` | 2 | `created_at` |
| `reviews` | **0** | `created_at`, `moderated_at` |
| `mailing_list` | **0** | `created_at` + soft-delete `unsubscribed_at` |
| `feedback` | **0** | `created_at` |
| `vendor_requests` / `workflow_instances` | **0** / **0** | `created_at` + transitions |
| `stats_cache` | 12 keys, recomputed 07:00 UTC daily | **No** — snapshot, overwritten |

Other observations from the census that the panel should surface as findings, not hide:

- **171 of 171 products have `logo_url IS NULL`** (vendors do carry logos).
- **`home.integrations_added_30d` reads 496 — identical to `home.total_integrations`**, an artifact of the 2026-07-25 `catalog.integrations_reset`. The metric is currently indistinguishable from the total.
- ~~**`page_views` bot classification is only trustworthy from ~2026-08-05.** 17,784 of 26,126 rows have `is_bot IS NULL` and therefore read as *human*…~~ **Resolved 2026-08-13 by AECI-582** (P2.2): the backfill ran on all four tiers. Every row is now classified, and live classification is trustworthy from **2026-08-03** (measured; the ~08-05 above was an estimate). The correction is large — production's "reads as human" fell **18,322 → 2,096**, i.e. **~89% of all traffic ever recorded as human was bots** (Jun ~94%, Jul ~93%). Treat every June/July traffic figure written before this date as overstated. Nothing after 08-03 moved, so no daily digest shows a discontinuity.
- **`referrer_source` is null on every row before August** and is not backfillable — the header was never stored.
- ~~**`page_views.user_id`, `.session_id`, `.profile_role` are dead columns.**~~ **Dropped 2026-08-13 by AECI-585** (P4.1, §13 D7). The ingest handler never wrote them; they are gone rather than filled, so a page view still cannot be tied to a signed-in user and there is still no session concept — that is now structural rather than an omission.
- ~~`resolveEntity` maps only `product`/`vendor`, so a taxonomy page view cannot say *which* term was viewed, and `Direct` mixes true arrivals with in-app SPA hops.~~ **Fixed at ingest 2026-08-13 by AECI-585**, which also began capturing `cf_as_organization`. Read this as a *forward* fix only: rows written before that deploy carry null in all four columns and none of it is backfillable, so any figure spanning the boundary must show the earlier population as unknown.

---

## 4. Feasibility matrix

The four questions that motivated this document, answered against §3.

| Question | Source | Answerable today? | Gap |
|---|---|---|---|
| **Visitors over time** | `page_views.created_at` | **Yes**, from 2026-06-23 | No sessions — "visitor" must be defined as distinct `(user_agent_hash, cf_asn)` per day (§9.8). Bot split unreliable pre-August until the backfill runs. Sources unavailable pre-August. |
| **Mailing list over time** | `mailing_list.created_at` + `unsubscribed_at` | **Structurally yes; 0 rows today** | Nothing to chart until signups start. Schema is well-suited: cumulative, net-new, churn, plus `utm_source/medium/campaign`, `country/city/region`, `asn`, `as_organization`. |
| **Current status** | `/api/version`, `/_version`, `stats_cache.computed_at`, Algolia watermark, the 10 DQ checks, queue depths | **Yes** — highest value per unit of work | Cron last-run/outcome lives only in Datadog, not D1 (§7.2). |
| **Product + integration counts over time** | `stats_cache` (snapshot), `audit_log` (events), `products.created_at` | **Only partially** | See below. |

**Why catalog counts-over-time is the hard one.** Three sources, each insufficient alone:

- `stats_cache` is overwritten by the 07:00 cron. **No history exists.**
- `products` has **no `promoted_at`** column. §13 **D6** adds one — but not for the reason a first reading suggests, and the difference decides how it is implemented (see the correction below).
- `audit_log` *is* a genuine event stream (`product.created` 131, `integration.created` 827, `vendor.created` 94, since 2026-06-26), so **additions** are chartable. But **net totals are not**: 827 `integration.created` events against 496 live rows, because the 2026-07-25 `catalog.integrations_reset` removed rows without per-row audit; ~40 products predate the log entirely; and 5,375 `claim.created` events back 915 live claims because promote re-creates the claim spine.

> **Correction (AECI-573).** An earlier draft of this section claimed that "a row sits at `promotion_status='ready'` before going live, so `created_at` is not a go-live date." **That describes the review app's lifecycle, not AECi's D1.** In D1: `POST /api/promote` is the only INSERT path into `products` and it sets `promotion_status='promoted'` on both its insert and update branches; nothing in the repo ever writes `'ready'`, `'pending'`, `'retracted'`, or `'rejected'` to D1 (`'ready'` is an Airtable-side status that never crosses the promote boundary); and retraction is a **hard delete** (`lib/retract-product.ts`), not a status transition. So **`products.created_at` is already the first-promote timestamp, exactly** — Drizzle stamps it at insert and a re-promote never touches it. The census agrees: all 171 products read `promoted`.
>
> Two consequences. **(1)** `promoted_at` (§13 D6) is adopted as *future-proofing* — it becomes load-bearing only if a Tier-1 retract endpoint ever introduces a genuine un-promote → re-promote cycle — and its backfill is therefore **exact** (`promoted_at := created_at` for every row), not a reconstruction. **(2)** Because promote re-asserts `'promoted'` on the update branch too, and `product.updated` (358) outnumbers `product.created` (131) ~2.7:1, a naive `promotedAt: now` in that `.set()` would mean *last* promoted and buy nothing over `updated_at`. Set-once is mandatory — `COALESCE("promoted_at", ?)` inside the same batch.

**Conclusion:** for the **products** series, `products.created_at` (and, since D6 landed with AECI-581, `promoted_at`) gives an exact answer for every currently-live row. For **integrations, vendors, claims, traffic, subscribers, and queue depths** — where there is no equivalent stamp and rows can vanish without per-row audit — a **daily snapshot table is still the only honest way to get counts-over-time** (§7.1), with an approximate historical series backfilled from `audit_log` and labelled as approximate in the UI.

> **As shipped (AECI-581).** The backfill split finer than "approximate vs exact" along the way. `traffic.*` and `accounts.sign_ins_new` come from durable per-row timestamps (`page_views`, `profiles.created_at`) that the live endpoint reads anyway, so they backfill as **measured** — flagging them approximate while the live path served the identical number unflagged would have been incoherent. Only `catalog.{integrations,vendors,claims}_created`, which come from `audit_log` events that outlive their rows, are **reconstructed**. And the *stock* metrics are not backfilled at all: a cumulative sum of `*.created` would be wrong rather than approximate, so those series simply start at the first cron run. See §7.1.

---

## 5. Information architecture

Nine routes under the existing `AdminShell` (`app/admin/admin-shell.ts`). The shell's `h1` changes from "Moderation" to "Admin" and its flat nav becomes three groups.

```
/admin                     → redirect to /admin/overview
  Insights
    /admin/overview        §5.1
    /admin/activity        §5.2
    /admin/traffic         §5.3
    /admin/audience        §5.4
  Catalog
    /admin/catalog         §5.5
  Operations
    /admin/reviews         existing (Phase 5.13)
    /admin/requests        existing (Phase 6.10)
    /admin/reviewers       existing (Phase 6.11)
    /admin/system          §5.6
```

**Shell restructure — SHIPPED (AECI-576, P1.2).** The `h1` reads "Admin", `/admin` redirects to `/admin/overview`, and the nav is grouped. Two mechanics were settled while building it:

- **An unbuilt route is omitted, not disabled.** P1.2 shipped **Insights → Overview** and **Operations → Review queue · Requests · Reviewer bans**; the other five entries appear when their screen does. A group with no items renders no heading either, so `Catalog` is absent until AECI-579. This is the "do not link to a 404" requirement resolved in favour of a nav that only ever shows working destinations — a disabled entry advertises a capability the operator cannot use, and there is no second surface where these routes are discoverable, so nothing is lost by adding them one at a time. The nav is a `readonly AdminNavGroup[]` in the shell, so a later unit adds one array entry rather than editing markup.
- **Group labels are `<p>` + `aria-labelledby`, not headings.** The shell owns the only `h1` and each screen owns the only `h2` (asserted by every queue's component spec). A heading in the nav would sit between them and break axe's heading-order rule for no navigational gain — the `<ul>` gets its accessible name from the label either way.

The three Operations queues moved under a heading and are otherwise untouched. The header user-menu / nav-menu admin links still point at `/admin/reviews`, deliberately: that link carries the pending-review count.

### 5.1 Overview

The analytics digest as a live page. Stat tiles with sparklines — human page views, unique visitors, new sign-ins, active subscribers, catalog totals — each with a day-over-day and 7-day delta matching the email's `deltaText` semantics. Below: a 30-day traffic chart (human vs bot), top traffic sources, top viewed products, and a status strip (prod SHA · stats freshness · failing DQ checks · Algolia drift · moderation depth). A **"recompute today's digest"** action so the operator is not waiting for 05:00 UTC — implemented as `GET /api/admin/overview?recompute=1`, which re-runs the digest's metric collection (already a pure read) and returns it. It does **not** send the email and writes nothing; §13 **D8** draws that line.

**SHIPPED (AECI-576, P1.2), with one paragraph above corrected by what P1.1 actually returns.**

- **"each with a day-over-day and 7-day delta" overshoots the contract.** `/api/admin/overview` returns `delta_7d` for **human page views only**; `new_sign_ins` carries a day delta, and `active_subscribers` + catalog totals are live snapshots that are deliberately not windowed at all (`AdminOverviewAudienceSchema`, `AdminOverviewCatalogSchema`). The screen therefore **renders only the deltas the API returns and derives none client-side** — re-deriving one in the browser would fork `computeDelta`, the single implementation the digest email and the panel share, which is the property §6's P1.1 note 1 exists to protect. Tiles with no delta state their window instead. Adding the missing deltas is an additive change to the endpoint; it is not a UI concern.
- **Sparklines come from two sources.** Human page views uses the bundle's own `series_30d`. Unique visitors and new sign-ins are fetched in a **second, non-blocking wave** from `/api/admin/metrics/timeseries` over the same window, so the tiles paint on the first response and a failed series costs one sparkline rather than the page. `active_subscribers` has **no metric key** — it is a live `mailing_list` snapshot, not a series — so that tile ships with no sparkline rather than an invented one.
- **The status strip reads two version endpoints.** The bundle's `status.version` is the API Worker's; the strip additionally fetches the SSR Worker's own `GET /_version` and flags a mismatch. That comparison is why both endpoints exist (AECI-92) — `/api/version` is proxied, so a stale SSR bundle in front of a current API is invisible from it alone. A sha of `"unknown"` (the placeholder when `COMMIT_SHA` was not injected) is never reported as drift.
- **`null` renders as "Not measured", never as zero.** `data_quality` and `algolia_drift` are absent by default; showing `0 failing` would claim a clean bill of health nobody checked for.
- **A failed recompute keeps the page.** Initial-load failure and recompute failure are separate states: the first replaces the page with a retry, the second shows an inline alert and leaves the figures already on screen intact. Discarding a good response because an *optional* refresh failed would lose real information.
- **A day picker is out of scope for P1.2.** The endpoint's `?day=` is unused by the UI, which always reports the digest's default window (the prior complete UTC day). Historical navigation belongs with §5.3's Traffic section.

### 5.2 Activity

The consent-independent equivalent of PostHog's Activity explorer — a reverse-chronological feed of `page_views` with day separators.

| PostHog column | AECi column | Source |
|---|---|---|
| EVENT | `Pageview` + bot chip (`Googlebot`, `Datacenter (AWS)`) | `is_bot`, `bot_name` |
| PERSON | Visitor — `365d59e9 · AS23700` (truncated UA hash + ASN) | `user_agent_hash`, `cf_asn` |
| CITY NAME | Location — country + Cloudflare colo (the colo *is* the nearest city) | `cf_country`, `cf_colo` |
| URL / SCREEN | Page — concrete path, or route pattern hydrated to the real entity name | `path` + `product_id`/`vendor_id` join |
| TIME | Relative, absolute UTC on hover | `created_at` |
| REFERRER URL | Source — `Google` / `Direct` + host | `referrer_source`, `referrer` |

Operator-only paths (`/admin/*`, `/account`) never appear in this feed — §9.6 / §13 D12 excludes them **beneath** the filters below, historical rows included, so no filter setting can surface them.

Filters: date range · traffic type (humans / bots / all, default humans) · source · country · path contains · **"filter out internal traffic"**, mirroring PostHog's toggle, backed by an `ANALYTICS_INTERNAL_ASNS` var. That last one is not cosmetic: on 2026-08-10, **67 of 92 "human" views came from the operator's own ISP** (AS23700, Jakarta). It is bound by the three constraints in §13 **D10** — query-time only (it never touches `is_bot` and never runs at ingest), both numbers always shown, and the var ships unset.

Entity hydration follows the `target` `LinkRef` pattern already used by `GET /api/admin/requests`, so `/products/:slug` renders as a linked product name.

**How D10 constraint 2 resolves on a row feed (settled by AECI-577).** "Show both numbers, never substitute" falls out of `AdminCount` for free on a *count* endpoint, but this is a *row list*: `exclude_internal=1` removes rows, so computing the counts the same way would leave the operator reading a smaller number with nothing beside it — the substitution the constraint exists to prevent. So `GET /api/admin/page-views` resolves the filter **twice**: `window_total` and `window_visitors` are computed both ways **unconditionally** whenever the var is set, toggle or no toggle, and `exclude_internal` governs only which rows come back. The screen therefore always reads "1,204 views · 312 excluding internal traffic", and the toggle's effect is legible before it is used rather than only after. `/api/admin/overview` already set this precedent — it always asks. One local consequence: `internal_filter.applied` means *"the row list was filtered"* on this endpoint, which `API_CONTRACTS.md` §6.10 records.

### 5.3 Traffic

Time series over `page_views`: views/day split human vs bot · unique visitors/day (§9.8) · sources over time · top pages · top products · geography (country + colo) · crawler activity per bot over time. A UTC ↔ WIB toggle (§9.5), since the digest and every cron are UTC-only and the operator is at UTC+7. "Top pages" is public routes only — the §13 D12 exclusion applies here too, so the console's own routes can never rank in it.

**Shipped in AECI-578, with three items deferred by decision.** Three of the list
above are not reachable from the P1.1 contract, which was found while building the
UI rather than while writing P1.1:

| Asked for | Why it does not exist yet |
|---|---|
| sources **over time** | `/traffic/breakdown` returns one flat total per group — no time axis — and `/metrics/timeseries` has a fixed metric vocabulary with no group-by |
| crawler activity per bot **over time** | same |
| geography by **colo** | `colo` is not a member of `AdminBreakdownDimensionSchema`, though `page_views.cf_colo` is populated |

§10 scopes P1.4 as **UI only**, so rather than widen a UI ticket into API work,
all three are deferred: sources, crawlers and geography render as **windowed**
horizontal-bar breakdowns, and colo is absent. The API additions — a `colo`
dimension (a five-line change) and a multi-series day-bucketed endpoint that
serves both over-time views — are tracked as their own issue so they can carry
their own handler specs against the D1 harness. **Nothing else on the page is
missing**: human-vs-bot per day, unique visitors per day, top pages, top products,
the UTC ↔ WIB toggle, the §9.8 definition beside the number, the internal-ASN
toggle and the honesty envelope are all live at `/admin/traffic`.

### 5.4 Audience

Subscribers cumulative and net-new · unsubscribes and churn rate (`unsubscribed_at` is a soft delete, so churn is exactly computable) · UTM source/medium/campaign breakdown · signup geography · and the **feedback inbox** as a readable list. `feedback` is written by `POST /api/feedback` and has **no read surface anywhere in the product today**.

Renders empty states until signups begin (§3). Cheap to build alongside §5.3 and needed the day the first subscriber arrives.

### 5.5 Catalog

**SHIPPED 2026-08-13 (AECI-579 / P1.5)** — `/admin/catalog`, the console's first screen.

- **Counts over time** — products / integrations / vendors / claims (§7.1), with the pre-snapshot segment visually marked as an audit-log approximation.
- **Additions per day** from `audit_log` `*.created` events.
- **Promotion funnel** — `pending → ready → promoted → retracted / rejected` from `products.promotion_status`.
- **Coverage gaps as actionable lists** — products without a vendor, without a logo (171 today), without a description, untagged per facet (`product_trades` is 0), missing API docs, `research_status` distribution.
- **Taxonomy usage** per facet, plus the trades publication gate (`TRADES_VOCABULARY.md`).
- **Claims / attestations** counts and coverage per integration (Stage 1.5 spine).

This is the section that steers daily catalog work, and the one whose underlying data is richest today.

**Three things this section says that the build had to correct or sharpen (AECI-579):**

**(1) The gap lists cannot link out to the review app, and do not.** An earlier draft of this section, and the "Read-only, emphatically" framing below it, both required every gap row to be *"a link out to the review app, not an edit surface"*. The read-only half stands and is absolute. The link half is **not constructible**: **ADR 0021 deliberately kept the curation key out of D1** — `REVIEW_APP_PROMOTE_API.md` states plainly that *"AECi does **not** store your Airtable/record IDs"*, and that ADR vetoed `airtable_record_id` on `products` as "no curation-tool key in the public schema". There is therefore no identifier in D1 from which a per-row review-app URL could be built, and adding one would reopen a settled decision for a convenience link. **Sample rows link to the AECi product page** (`/products/:slug`) instead, which is the honest available target and is also the more useful one for verifying a gap: it shows the operator exactly what a visitor sees. Nothing about the read-only rule changes — there is no edit affordance anywhere on the screen.

**(2) "Counts over time" and "additions per day" are one series, and it is not this endpoint's.** Both bullets are served by `GET /api/admin/metrics/timeseries` with the `catalog.*` metric keys, which P1.1 already shipped complete with `catalog_series_is_additions_only`. `GET /api/admin/catalog/coverage` deliberately does not carry a second copy. Until §7.1's snapshot exists there is exactly one honest series here — **additions**, from the event stream — and the screen renders it as such with the approximation banner attached, rather than drawing a cumulative curve that §4 shows would be wrong (827 `integration.created` events against 496 live rows).

**(3) The untagged-trade count is not a backlog.** This section lists "untagged per facet (`product_trades` is 0)" alongside missing logos and missing vendors. Those are not the same kind of number. `TRADES_VOCABULARY.md` §1.1 tags a product **only** where it has trade-*specific* value, so horizontal platforms (Procore, Autodesk Build, Bluebeam) correctly carry zero rows — the join is sparse by design and most of the catalog will never be tagged. The count is still worth surfacing (nothing at all is tagged today), but it ships with a `trade_facet_sparse_by_design` note. Presenting it as a to-do list without that caveat would make the screen actively misleading.

### 5.6 System — SHIPPED (AECI-580, 2026-08-13; completed by AECI-583, 2026-08-13)

- SSR + API `sha` / `deployedAt` / `environment` from the two existing endpoints (`/api/version` and the SSR Worker's own `/_version` — they differ precisely so a stale SSR deploy is detectable). The UI reads both and flags a mismatch as a `role="alert"` band; an unknown SHA (the `wrangler --var` injection missing) reads as *unknown*, not as a difference. The bundle carries the **API** Worker's half — nothing reachable from the API Worker knows the SSR Worker's SHA.
- **Cron liveness** — last run, duration, outcome per job, for all nine crons (§7.2).
- **The ten data-quality checks** rendered with severity and sample rows — formerly visible only in an email. **Delivered as specified:** since AECI-583 the default view reads the last persisted `job_runs` result (labelled with the run's own `computed_at`) and `?recompute=1` is the refresh. Both are pure reads, so neither writes anything or needs an `audit_log` row (§13 **D8**).
- Algolia sync watermark, index drift, orphan-sweep results.
- D1 size and per-table row counts.
- Link-outs to the Datadog dashboards and PostHog.

Effectively the daily procedure in `POST_LAUNCH_MONITORING.md` turned into one screen.

**What P1.6 could and could not deliver, and how the response says so.** Three of the five blocks were not knowable from D1 until §7.2 landed, and the contract made the gap explicit rather than papering over it (`AdminCronRunSchema.source`, a `null` `orphan_sweep`, a `null` `size_bytes`). AECI-583 closed all three; the honesty machinery stayed:

| Item | State after AECI-580 | State after AECI-583 |
|---|---|---|
| Cron **last run** | Derived for two of nine — `home-stats` from `MAX(stats_cache.computed_at)`, `algolia-sync` from the `algolia_sync_watermark` row's stamp — and `unknown` for the other seven. | Read from `job_runs` for every job that has run. `derived` survives only as the pre-first-run fallback (deleting it would blank all nine for 24h after each deploy), and still reports no outcome — a stamp proves the job *ran*, never that it *succeeded*. |
| Cron **outcome / duration** | `null` on every row. `'ok'` is unreachable in P1.6 by construction; the screen renders "Unknown". | Populated. `'ok'` is now reachable — but only from a row that says so: an **open** row (`finished_at IS NULL`) reports `run_state: 'in_flight'` with a null outcome *whatever is stored*, and an unrecognized stored value reads as null. An interrupted run cannot render as a pass. |
| **Orphan sweep** | Permanently `null` + an `orphan_sweep_not_persisted` note. The sweep runs inside the 09:00 drift cron and reports only to Datadog — there is no D1 read that could fill it, and inventing a persistence layer here is AECI-583's job, not this one's. | Filled from the 09:00 run's `job_runs.detail`, including the `capped` count an operator needs for the `--force` decision. The note is no longer emitted (kept in the enum — removing a code is breaking). `null` now means "no completed run has stored one", never "clean". |
| **D1 size** | From D1's own `meta.size_after`; `null` (rendered "unknown") where unavailable. Never approximated from the row counts. | Unchanged. |
| Everything else | Live: version, the ten checks on demand, drift on demand, the watermark, per-table row counts, `stats_cache` freshness. | The ten checks now **default to the last stored 04:00 result** (`source` + `computed_at` say so); drift stays recompute-only. The rest unchanged. |

Two decisions worth carrying forward. **The recompute is opt-in, matching §6's "Overview and System keep the same convention"** — the checks HTTP-probe logo URLs and query three Algolia indexes, and a screen an operator refreshes should not do that on load; the button is the affordance. And **the nav gained a flat "System status" item** rather than pulling P1.2's three-group restructure forward; AECI-576 still owns that and the `h1` rename.

---

## 6. API surface

All endpoints are `GET`, admin-gated, read-only. They register on the existing `authAdmin` sub-router in `apps/api/src/index.ts` behind `requireAdmin()`, which stays the single enforcement point (`AUTH_AND_RLS.md`). Contracts live in `packages/shared/src/api/admin-panel.ts` and reuse `PageQuerySchema` (`page` / `perPage`, capped at 100) and `paginatedResponseSchema` so list shapes match `/api/admin/requests`.

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET /api/admin/overview` | The §5.1 bundle | One round trip; **calls** `collectAnalyticsMetrics` (see the P1.1 note below). `?day=YYYY-MM-DD` picks a UTC day, default the digest's prior complete day; `?recompute=1` runs the two network-dependent status items (pure read; sends no email) |
| `GET /api/admin/page-views` | §5.2 feed | Paginated + filtered; entity-hydrated `LinkRef` |
| `GET /api/admin/metrics/timeseries` | `?metric=&from=&to=&interval=day` | Serves `metrics_daily` (§7.1); falls back to live aggregation pre-snapshot |
| `GET /api/admin/traffic/breakdown` | `?dimension=source\|country\|path\|product\|bot` | Grouped counts over a window |
| `GET /api/admin/catalog/coverage` | §5.5 gap lists + funnel | Capped sample rows, exact counts. `?sample=` (0–50, default 10); `0` returns counts only. **No `window`** — see the P1.5 notes below |
| `GET /api/admin/audience` | §5.4 aggregates | Subscribers, churn, UTM, geo |
| `GET /api/admin/feedback` | Paginated feedback list | First read surface for the table |
| `GET /api/admin/system` | §5.6 bundle — **SHIPPED (AECI-580, completed AECI-583)** | Version, cron runs (from `job_runs`), the last stored DQ result, Algolia incl. the orphan sweep, table counts. `?recompute=1` re-runs the ten DQ checks + drift live (pure read — writes nothing, not even a `job_runs` row) |

**Conventions.** No `audit_log` rows (reads only — §26.1 governs writes). No `Cache-Tag`, no edge caching; `/admin/*` is absent from `ROUTE_CACHE_PATTERNS` in `server-runtime.ts` and therefore takes the non-cacheable branch with `private, no-store`. That must stay true (§9.2). Response validation in dev via `validateResponseInDev`, as with the other admin routes.

**Manual job triggers — the line is side effects, not manual-ness (§13 D8).** *Recomputation* is in scope and is a `GET`: both `runDataQualityJob` and the digest's metric collection are already pure reads, so `?recompute=1` on the two endpoints above writes nothing, sends nothing, and carries no `audit_log` obligation. *Running a job for real* — sending the digest, `algolia-sync`, the retention prune, the reconcile sweep, anything that writes, emails, purges, or calls an external API — stays **deferred**, and `POST /api/admin/jobs/:job/run` is not built. Owner: **@chrisw**. Revisit when an operator first needs to force a job outside its window during an incident; at that point it is a state-changing write and needs its `audit_log` row in the same batch.

**What `?recompute=1` actually gates in Phase 1 (settled during AECI-574).** D8 wrote the rule (side effects, not manual-ness) but not the Phase-1 mechanics, and there is a wrinkle: before `metrics_daily` exists (P2.1), `/api/admin/overview` *always* live-aggregates, so a "re-run the collection" flag would be a no-op. The flag is therefore made load-bearing now, along the line that actually matters on a dashboard — **network cost**:

- **Default response** — the traffic/audience/catalog figures (all live D1 reads) plus the cheap half of the status strip: prod SHA, `stats_cache` freshness, moderation depth. The two network-dependent items, `data_quality` (whose logo-404 check HTTP-probes a sample of URLs) and `algolia_drift` (three Algolia queries), come back `null` with a `requires_recompute` note.
- **`?recompute=1`** — additionally runs all ten §23.1 checks and the drift count. Check #10 *is* the drift check, so the drift runner is invoked **once** and its result feeds both the strip and the suite.

Nothing about D8's boundary moves: both are still pure reads. From P2.1 the flag additionally means "bypass the snapshot", which is the meaning D8 anticipated; the response's `source` field (`'live'` today, `'snapshot'` later) is what tells the two apart. Overview and System keep the same convention.

**And they keep it by sharing one implementation (AECI-580).** The recompute block moved out of `routes/admin-overview.ts` into `lib/admin-status.ts` (`runExpensiveStatusItems`), which both endpoints call — the same reasoning P1.1 note 1 applies to `collectAnalyticsMetrics`: two screens reporting the same check must not be *able* to disagree. It carries the memoize-at-the-promise trick with it, so the drift runner is invoked once per request even though check #10 and the drift panel both consume it. `statsFreshness` moved for the same reason.

**P1.1 implementation notes (AECI-574).** Contracts in `packages/shared/src/api/admin-panel.ts`; handlers in `apps/api/src/routes/admin-{overview,metrics,traffic}.ts` over `apps/api/src/lib/admin-analytics.ts`. Three choices are worth knowing before extending them:

1. **Digest parity is structural, not periodic.** The overview *calls* `collectAnalyticsMetrics(db, windowsForDay(day))` rather than mirroring its queries, and its deltas come from an exported `computeDelta` that the email's own `deltaText` also calls. There is one implementation of each number. Deltas cross the wire **structured** (`{ current, prior, diff, pct }`), not as the email's prose, because §9.4's i18n rule is unconditional — the semantics are shared, the strings are the UI's.
2. **Bias notes are derived from the window, not from a date.** `bot_classification_incomplete` fires because the window contains `is_bot IS NULL` rows, so it disappears on its own once P2.2 backfills. Nothing hardcodes 2026-08-05. *(This paid off: P2.2 ran 2026-08-13 and the note retired itself on every screen with no code change — the design's own test case.)*
3. **Note `code` is the contract; `message` is a fallback.** The UI localizes from `code` + `params`; `message` (and a null group's `label`) is untranslated operator text for curl and logs. This is what lets §1.1's "machine-readable notes rather than the UI hardcoding prose" coexist with §9.4.

**P1.3 implementation notes (AECI-577).** Contract in the same `packages/shared/src/api/admin-panel.ts`; handler in `apps/api/src/routes/admin-page-views.ts` over `listPageViews` / `pageViewFilterPredicate` in `lib/admin-analytics.ts`. Four choices are worth knowing:

1. **The D12 floor is structural, not a filter.** `listPageViews` builds its `WHERE` from `inWindow()`, the same choke point every other query in the module derives from, so `/admin/*` and `/account` are excluded beneath the caller's filters and no query string can surface them. A hand-rolled `and(gte(...), lt(...))` would silently lose it — which is why there is one `inWindow` rather than a repeated range predicate.
2. **The internal-ASN filter is resolved twice** — see the §5.2 note above.
3. **The UA hash is truncated in SQL**, not in the template (`substr(user_agent_hash, 1, 8)`). §9.7 permits a truncated pseudonymous id and forbids correlation beyond it; truncating at the query makes that a property of the contract instead of a habit of the UI, and the full hash never crosses the wire.
4. **The feed's `source` / `country` dropdowns are fed by `traffic/breakdown`**, not by a duplicated vocabulary. The options are then exactly the values present in the selected window, the NULL bucket arrives as a real `key: null` group, and no list exists in two places waiting to drift. `ADMIN_PAGE_VIEW_NULL_FILTER` (`'__none__'`) is how that bucket is selected, since a query string cannot carry a null.

The UI half also lands three shared pieces under `apps/web/src/app/admin/` that P1.2/P1.4–P1.6 reuse: `AdminNotes` (the first rendering of `AdminNote` codes as localized prose), `AdminPaginator` (the panel's first real pagination — the moderation queues load one capped page), and `AdminSelect` (an Angular Aria combobox + listbox per ADR 0010).

**P1.5 implementation notes (AECI-579).** Contracts extend the same
`packages/shared/src/api/admin-panel.ts`; handler in `apps/api/src/routes/admin-catalog.ts`
over `apps/api/src/lib/admin-catalog.ts`. It renders `AdminNote` codes through the shared `AdminNotes` component landed by P1.3. Four choices are worth knowing before extending them:

1. **Coverage carries no `window`, and that is the point.** The three P1.1 endpoints aggregate over a UTC range. Coverage describes *current state* — "how many products have no logo" has no time range — so it reports `generated_at` / `source` / `notes` and nothing else from the envelope. Inventing a window would be the false precision §1.1 exists to prevent.
2. **The catalog time series stayed on `/metrics/timeseries`.** The screen makes five reads on arrival: one coverage call plus four `catalog.*_created` series. Widening the coverage response to carry them would have put a second implementation of the same number behind the same screen, which is the failure mode P1.1's note 1 already guards against for the digest.
3. **One statement for eight gap counts.** All eight gaps (plus the `has_api_docs`/`api_docs_url` consistency probe) come from a single conditional-aggregation `SELECT` over `products`, not eight `count(*)` round trips. Beyond cost, it means all eight see the same snapshot — a promote landing mid-request cannot make the numbers disagree with each other. Sample queries then run only for gaps that found something, and not at all when `?sample=0`.
4. **Correlated subqueries must be explicitly qualified.** Interpolating a Drizzle column into a `sql` template emits a **bare** name (`"id"`) when the surrounding statement has no join — and inside a correlated subquery a bare name binds to the *inner* table if it has a column of that name. `claims` has an `id`, so `… from claims where "data_object_id" = "id"` silently compares two `claims` columns and every data-object count returns 0. The facet joins (`product_categories` and friends) have no `id` column, so the same construction happens to work there, which is exactly the accident that rots when someone adds a surrogate key. `lib/admin-catalog.ts` derives `"table"."column"` from the schema (`col()` / `tbl()`) for every correlated reference; `lib/drizzle-helpers.ts` solves the same problem by hand-writing the qualified name into the template string.

---

## 7. Data-layer changes

None of these are needed for Phase 1 (§10). They are what makes Phases 2–4 possible.

### 7.1 `metrics_daily` — the snapshot table

**SHIPPED 2026-08-13 (AECI-581 / P2.1).** This section is reconciled to what
landed; the three places it deviates from the v0.1 sketch are called out inline.

The fix for §4's hard problem. A narrow key-value shape rather than one column per metric, so adding a metric never needs a migration — mirroring the `stats_cache` key convention (`home.total_products`, …):

```
metrics_daily
  day         TEXT NOT NULL   -- 'YYYY-MM-DD', UTC
  metric      TEXT NOT NULL   -- 'catalog.products_promoted', 'traffic.page_views_human', …
  value       REAL NOT NULL
  source      TEXT NOT NULL DEFAULT 'measured'   -- 'measured' | 'reconstructed'  (CHECK)
  computed_at TEXT NOT NULL
  PRIMARY KEY (day, metric)
  INDEX (metric, day)
```

**Deviation 1 — `source` is a fifth column, not an inference from `computed_at`.**
The v0.1 sketch had four columns and proposed marking a backfilled row by its
`computed_at`. That heuristic mislabels a legitimate late re-run of a *missed*
day, whose sources are still intact, as approximate — the honesty error in the
direction §1.1 cares least about, but an error the operator then cannot correct.
A stored column says it outright and yields one precedence rule both writers obey:
**a `measured` write always wins; a `reconstructed` write applies only over an
absent or already-`reconstructed` row.** That single asymmetry is what makes the
backfill re-runnable, in any order relative to the cron, without ever degrading a
real snapshot. The added `(metric, day)` index serves the endpoint's read
(one metric, day range); the PK's leading `day` serves §7.4's "is this day
captured?" probe.

**Deviation 2 — the cron takes 00:15 UTC, not a slot after the 07:00 stats job.**
A snapshot mixes two metric families: per-day **flows** (page views on that day)
and instantaneous **stocks** (products that exist right now). A stock has no
window at all, so the only thing that makes a single `day` label honest for both
is running just after midnight: the flows for D-1 are closed, and the stock sample
is ~15 minutes past the end of the day it is filed under rather than the ~7 hours
a 07:00 slot would cost. It also orders ahead of §7.4's pruning cron by
construction. Queue-less, like `moderation`/`waf`/`analytics` — every metric is
already isolated in its own try/catch, and a missed day is recoverable by
re-running the backfill over that range, which is the same idempotent
`(day, metric)` upsert.

Idempotent per `(day, metric)`: a re-run corrects rather than duplicates. Metric
vocabulary is `ADMIN_SNAPSHOT_METRIC_KEYS` in `packages/shared/src/api/admin-panel.ts`,
tabulated in `DATABASE_SCHEMA.md` §9.3 — **19 keys**: the 8 flow keys the
timeseries endpoint already served, plus 11 stocks (catalog totals, subscriber
counts, queue depths). The stocks are written from day one but **not yet readable
through the API** — no screen consumes them until §5.4/§5.5 — because a stock is
unrecoverable retroactively: a day not sampled is gone, so waiting for the reader
would cost history that cannot be bought back.

**No `audit_log` row** — this is derived bookkeeping and is exempt from the §26.1 audit-in-batch invariant under the carve-out settled in §13 **D11** / **ADR 0022**. Follow `stats_cache`'s precedent exactly (`lib/home-stats.ts`): write **per key, outside any batch**, each inside its own try/catch, so partial failure of one metric never aborts the others. Observability is Datadog (`aeci.metrics_snapshot.*`, `OBSERVABILITY.md`) plus the `job_runs` row from §7.2, not the audit log.

**Backfill** (`apps/api/scripts/backfill-metrics-daily.ts`, core in
`src/lib/metrics-backfill.ts`): derive the historical series from `audit_log`
`*.created` events plus `page_views`, and label the pre-snapshot segment. Do not
present it as exact — §4 explains why it cannot be. **The one exception is the
products series**, which is exactly recoverable from `products.created_at` (§4's
correction); it is backfilled from that column and marked measured, not
reconstructed — and it is *better* than the live audit-log series, which covers
131 of 171 rows.

**Deviation 3 — backfilled `traffic.*` is `measured`, gated on AECI-582.** This
section originally lumped `page_views` in with `audit_log` as a reconstruction
source. But a traffic backfill re-aggregates the very rows the live endpoint reads
through the same `metricSeries` function; flagging one and not the other would be
incoherent, and the endpoint would contradict itself either side of the boundary.
The one real hazard is concrete rather than epistemic: rows with `is_bot IS NULL`
read as human (AECI-582), and `metrics_daily` is kept forever, so a run today
would freeze the wrong human/bot split permanently. The script therefore
**refuses a range containing unclassified page views** unless `--force`, turning
the P2.2 dependency into an enforced gate rather than a hope. Only the three
`audit_log`-derived catalog series are `reconstructed`.

**Stocks are never backfilled.** Reconstructing a past total from a cumulative sum
of `*.created` events would be wrong, not approximate — 827 `integration.created`
events against 496 live rows. Those series simply begin at the first cron run,
and the endpoint reports days before it honestly rather than inventing them.

**Zero-fill is load-bearing, not cosmetic.** Both the cron and the backfill write
a row for every `(day, metric)` in range including zeros, because §7.4 forbids
the pruning cron from deleting a `page_views` day the snapshot never captured —
a quiet day with no row would block pruning for that day forever.

**Wiring:** `GET /api/admin/metrics/timeseries` reads `metrics_daily` per day and
falls back to live aggregation for any day it does not cover; `source` reports
`snapshot` / `live` / `mixed`, and each point carries `reconstructed`. `mixed` is
the normal case, not an edge — today is never captured. The internal-ASN filter
bypasses the snapshot entirely: `metrics_daily` stores only the unfiltered figure,
since `ANALYTICS_INTERNAL_ASNS` is read-time config that would rot if baked into a
stored row.

**Retention:** indefinite. This table is small and is the long memory.

### 7.2 `job_runs` — cron liveness and DQ persistence

Today a cron's outcome exists only as a Datadog metric, and the ten data-quality findings exist only in an email:

```
job_runs
  id          INTEGER PK AUTOINCREMENT
  job         TEXT NOT NULL     -- 'analytics-digest' | 'data-quality' | 'algolia-sync' | …
  started_at  TEXT NOT NULL
  finished_at TEXT
  outcome     TEXT              -- 'ok' | 'failed' | 'skipped'
  detail      TEXT              -- JSON: per-job payload (DQ results, counts, drift)
  INDEX (job, started_at)
```

Each of the nine cron handlers in `scheduled.ts` writes one row (eight at the time this was written; AECI-581 added the 00:15 `snapshot` job). The data-quality run stores its full result set in `detail`, which is what §5.6 renders. Retention: 90 days (§7.4).

**SHIPPED (AECI-583, 2026-08-13.)** `job` uses the nine `AdminCronJob` ids in `packages/shared/src/api/admin-panel.ts` (AECI-581 added the ninth, `metrics-snapshot`); the DDL above is the built shape and `DATABASE_SCHEMA.md` §9.4 is the implementation record. Four things settled during the build are worth carrying forward:

- **Written on entry, completed on exit.** `withJobRun` (`apps/api/src/lib/job-runs.ts`) awaits the entry insert *before* invoking the job, so a run the isolate never returns from leaves `finished_at IS NULL` — the unfinished row is the signal. The finish write is awaited too, never `ctx.waitUntil`: on the queue path `ack()` fires the instant the job returns, and a deferred write would race it and manufacture false timeouts.
- **All nine impls return a `JobRunReport` rather than `void`.** They swallow their own operational errors, so a wrapper that only watched for a throw would record `ok` for a failed run. A *thrown* handler is recorded `failed` **and rethrown**, preserving the reconcile job's deliberate queue retry; a *reported* failure does not throw, so instrumenting did not widen the retry surface to the other eight.
- **No `partial`.** `home-stats` and `algolia-sync` are natively partial and Datadog tags them so; §7.2's vocabulary has three values, so a partial run records `failed`, derived from the same `jobOutcome()` the metric uses. The panel never claims more success than Datadog for the same run.
- **Read as eight bounded seeks, never a scan.** `(job, started_at)` + `LIMIT 1` per job; the `GROUP BY` and window-function alternatives both scan the whole index, which matters because retention is not yet enforced (below).

**No `audit_log` row**, for the same reason as §7.1 — cron-internal bookkeeping, exempt under §13 **D11** / **ADR 0022**. `job_runs` *is* the observability record; auditing it would be auditing the audit. Asserted per cron in `scheduled.spec.ts`, not merely commented.

**Retention is specified but NOT yet enforced.** §7.4's 90-day window needs P3.2 (AECI-584), which is deprioritized. Until it ships this table grows without bound — ~44k rows/year, ~80% of them from the `*/15` reconcile. That makes P3.2 load-bearing sooner than §7.4's `page_views`-centric framing implies.

### 7.3 Backfills and ingest fixes

| Item | Why |
|---|---|
| ~~Run `scripts/ops/backfill-page-view-bots.sql` on production~~ — **DONE 2026-08-13 (AECI-582)**, all four tiers, via `scripts/ops/2026-08-page-view-bot-backfill/run.sh` | 17,784 rows read as human; every historical traffic chart was wrong until this ran. Production settled at 24,575 bot / 2,096 human. Was also a hard prerequisite for the §7.1 metrics backfill (which refuses a range containing unclassified rows, since `metrics_daily` is kept indefinitely and would otherwise freeze the wrong split permanently) — now satisfied on every tier. The runner adds a rule the ASN file could not: it recovers the **true crawler name** for 4,941 rows by matching their `user_agent_hash` against rows the live classifier has since named — `classifyTraffic()` tests the UA before the ASN, so such a verdict is UA-derived and transfers across ASNs. That reached 885 `Applebot` rows on AS714, **without** adding Apple to `DATACENTER_ASNS`, which would have taught the live classifier to call iCloud Private Relay visitors bots |
| Run `pnpm --filter @aeci/api ops:backfill-metrics-daily` per environment (AECI-581) | Reconstructs the pre-snapshot flow series. Dry-run by default; run it **after** the bot backfill on that tier. Stocks are deliberately not backfilled |
| Run `scripts/ops/backfill-products-promoted-at.sql` per environment (AECI-581) | Fills `promoted_at := created_at` for rows created before migration 0010. Exact, idempotent |
| ~~Capture taxonomy entities on page views~~ — **DONE 2026-08-13 (AECI-585)**, `taxonomy_kind` + `taxonomy_id` | `resolveEntity` mapped only `product`/`vendor`; category/audience/phase/trade ids were dropped, so ~600 rows cannot say *which* term was viewed. Two generic columns rather than four FKs: SQLite cannot point one column at four tables, and a hard FK would block ever deleting a term. The kind is stored **only** alongside an existence-checked id, so a dangling kind can never inflate a per-facet count |
| ~~Store the concrete path alongside the route pattern~~ — **DONE 2026-08-13 (AECI-585)**, `concrete_path` | Detail-page rows store `/products/:slug`; product/vendor rows recover the name via FK, taxonomy rows cannot. `path` keeps its existing (mixed) meaning — the pattern when the writer knows one — and `concrete_path` is always the real path. The SSR `firePageView` stamps it from the request URL, so no resolver changed |
| ~~Add a `navigation: 'spa' \| 'arrival'` flag to the page-view payload~~ — **DONE 2026-08-13 (AECI-585)** | `PageViewTracker` POSTs on every SPA navigation and the same-origin `Referer` classifies as `Direct`, so in-app navigation and true direct arrivals were indistinguishable — `Direct` was a mixed bucket. Each writer states its own half as a fact (the tracker fires only on SPA hops; `firePageView` only on full-document loads); the API never infers it, so an omitted flag stays null |
| ~~Capture `cf_as_organization` at ingest (§13 **D10**)~~ — **DONE 2026-08-13 (AECI-585)** | The ASN *number* alone cannot label itself. `mailing_list` already stores `as_organization` (`schema.ts`) from `LANDING_CF_HEADERS`, and `POST_LAUNCH_MONITORING.md` §3b already names holder-name matching as the durable fix — "not a longer list". Makes both the bot classifier's weekly audit and §5.2's internal-traffic filter self-labelling. Shipped on the header name `LANDING_CF_HEADERS` already uses, so the two enrichment paths cannot drift |
| ~~**Drop** the dead columns — `user_id`, `session_id`, `profile_role` (§13 **D7**)~~ — **DONE 2026-08-13 (AECI-585)**, migration `0013` | Settled: drop, do not fill. Per-column cost below — the recreate came out as predicted |
| **Add `products.promoted_at`** (§13 **D6**) — **SHIPPED 2026-08-13** (AECI-581) | Future-proofs the §4 catalog series against a future un-promote → re-promote cycle. **Set-once** — `COALESCE("promoted_at", ?)` in promote's update branch, else it degrades to "last promoted". Backfill `:= created_at` (exact — see §4's correction), run per environment via `scripts/ops/backfill-products-promoted-at.sql` |

**Dropping the dead columns is not symmetric, and the migration plan must say so** (AECI-585):

| Column | App-code references | Migration |
|---|---|---|
| `session_id` | none | plain `ALTER TABLE … DROP COLUMN` |
| `profile_role` | none | plain `ALTER TABLE … DROP COLUMN` |
| `user_id` | one — the GDPR erasure batch | **table recreate**: SQLite refuses `DROP COLUMN` on a column carrying an index or a `FOREIGN KEY` clause, and this has both (`page_views_user_idx` + the FK in `migrations/0000_init.sql`). Copies ~26k rows and is the repo's **first** table-recreate migration — every `ALTER` to date is an `ADD` |

**As built (AECI-585).** All three drop in **one** recreate — `session_id` and `profile_role` ride along in the `__new_page_views` copy for free rather than earning their own `ALTER`, so the destructive statement count is one, not three. Two things about `migrations/0013_careful_absorbing_man.sql` a reviewer should check rather than assume: the copy lists `id` explicitly, so the autoincrement PK survives (§5.2's feed paginates on `(created_at DESC, id DESC)` and would repeat or skip rows if ids were reassigned), and drizzle-kit's emitted `PRAGMA foreign_keys=OFF` / `=ON` pair was **hand-replaced** with a single `PRAGMA defer_foreign_keys = true`, which is the lever [D1's migration docs](https://developers.cloudflare.com/d1/reference/migrations/) specify. Regenerating the file reintroduces the wrong pragma. The five additive columns are a separate, safe migration (`0012`) generated ahead of it.

**The migration cannot reach a deployed tier before the epic merges.** `main`'s `apps/api/src/routes/account.ts` still nulls `page_views.user_id` inside the GDPR-erasure batch, so applying the drop to a tier whose Worker runs that code makes account deletion throw. Local and PR-preview only until `admin-panel → main`, then apply per tier with the code.

The one code change riding along: `apps/api/src/routes/account.ts`'s `db.update(pageViews).set({ userId: null })` inside the erasure batch was a permanent no-op and is deleted with the column. That **strengthens** the GDPR story — `page_views` can no longer hold any user linkage at all — so `AUTH_AND_RLS.md` gets a line (§12).

**What AECI-585 deliberately did not do.** It is an *ingest* issue. Nothing reads the new columns yet: `GET /api/admin/page-views` still returns `entity_type: product | vendor`, a taxonomy row still renders as its bare route pattern, and `direct_is_mixed_bucket` still fires (truthfully — every row written before the deploy really is mixed). Hydrating taxonomy terms, showing the concrete path in §5.2's feed, and splitting `Direct` by `navigation` in §5.3's breakdowns are a follow-up, deliberately separated so the write-time fixes — the only half that is not recoverable later — could ship without waiting on UI work.

**Why not write `session_id` instead.** There is no client-side session id anywhere in `apps/web`; `PageViewTracker` sends `{ route }` and injects only `Router`/`HttpClient`/`PLATFORM_ID`. Creating one means a durable first-party identifier, and `ANALYTICS_BASELINE.md` characterizes the `page_views` write as **consent-independent** precisely because it stores a UA *hash* and a referrer *host* (§9.7). A persistent session id is a materially different artifact and would drag the table back inside the consent question this panel exists to route around. `user_id` fails differently: it is reachable on the browser POST (which forwards the Supabase cookie) but never on the SSR arrival path (which deliberately forwards none), so it would populate on SPA hops and never on arrivals — right half the time, which is worse than absent.

### 7.4 Retention

`page_views` grows ~1,000 rows/day (18.15 MB total today, ~700 B/row). Settled by §13 **D5**: raw `page_views` kept **400 days**, `metrics_daily` kept **indefinitely**, `job_runs` kept **90 days**. Enforced by a pruning cron added with §7.2.

**Why 400 and not 180.** Storage is not the binding constraint at either figure — 180 d ≈ 125 MB and 400 d ≈ 280 MB against D1's 10 GB per-database limit (1.2% vs 2.8%). Irreversibility is: **D1 Time Travel gives only ~30 days** of point-in-time recovery, so anything pruned beyond that is permanently gone. 400 days is the first window that keeps **year-over-year** comparison possible, with ~5 weeks of overlap so a YoY chart never has a ragged edge.

Four binding rules on the cron:

- **Chunk the deletes.** D1 bills rows *written*, and a delete is a write; a single statement over a large window is a bad first run.
- **Never prune a day the snapshot has not captured.** Verify a `metrics_daily` row exists for **every** day inside the cut window before deleting — do not assume the schedule held (§10 states the same dependency).
- **Hard-exclude `audit_log`, `workflow_instances`, `workflow_transitions`, and `metrics_daily`.** The first three are governed by `STAGE_1_SPEC.md` §26.6 (indefinite, and this cron is not the vehicle for changing that); the fourth is the long memory §7.1 exists to keep.
- **Emit one summary `audit_log` row per run** — `actor_type='system'`, `action='retention.pruned'`, `metadata={table, cutoff, rowsDeleted}` — in the same batch as the delete. Scheduled deletion is the explicit **exception** to the §13 D11 / ADR 0022 carve-out: deletion is the one write whose fact cannot be recovered from the data afterwards.

The window lives in a **config constant**, not a literal, so it can be shortened later without a migration. Note the practical consequence: `page_views` data starts 2026-06-23, so at 400 days **this cron deletes nothing until ~2027-07**. That is deliberate — build the mechanism, set the threshold safe — and it is why §10 deprioritizes P3.2.

This does **not** contradict `STAGE_1_SPEC.md` §26.6 ("no archiving or pruning at launch"), which is scoped to the audit and workflow tables; §7.4 governs `page_views`, `metrics_daily`, and `job_runs` only. The two are cross-referenced so a future reader does not have to re-derive that.

---

## 8. Charting

**Hand-rolled SVG. No charting dependency.** `apps/web` currently has no chart library and the chart vocabulary here is small: sparkline, line, stacked bar/area, horizontal bar, donut. Components live in `apps/web/src/app/admin/charts/`.

> **Status.** The directory now exists — **P1.4 (AECI-578) created it** (§8.1). P1.5 (AECI-579) renders its counts-over-time as an accessible `<table>` rather than the SVG primitives; that is deliberate layering, not a shortcut: the "Accessible" rule below already requires a visually-hidden table carrying the same series under every chart, so a follow-up adds the SVG *above* P1.5's existing, already-tested table rather than replacing anything.

Rules:

- **SSR-safe.** Geometry is computed from data in pure functions — no DOM measurement, no `window`, no post-hydration layout pass.
- **Accessible.** Each chart is `role="img"` with a descriptive `aria-label`, plus a visually-hidden `<table>` carrying the same series. Charts are never the only representation of a number.
- **Tokenized.** Colors from `DESIGN.md` semantic tokens; light theme only (the Stage 1 constraint holds — no `dark:` variants).
- **Follows the `dataviz` skill** for form selection, categorical palette, and stat-tile composition.
- **Responsive** via `viewBox` + `preserveAspectRatio`, not JS resize handlers.
- Geometry functions are pure and unit-tested independently of rendering (§11).

### 8.1 As shipped (AECI-576 P1.2 + AECI-578 P1.4)

The `charts/` folder has **two coexisting primitive sets** today, a deliberate
outcome of the two issues landing independently:

- **P1.2 (AECI-576)** created `apps/web/src/app/admin/charts/` for the Overview's
  needs: `chart-geometry.ts` (the pure layer — `niceMax`, `sparklineGeometry`,
  `stackedBarGeometry`; non-finite/negative values clamp to 0 rather than emitting
  `NaN` path commands), `sparkline.ts` (`<aec-sparkline>` — empty renders nothing,
  a single value renders a flat line, no hidden table since the tile shows the
  figure), and `stacked-bar-chart.ts` (`<aec-stacked-bar-chart>` — scales on the
  column **total** so a stack never overflows; visible legend + visually-hidden
  `<table>`; Forest / Clay-deep fills, distinct in hue **and** lightness). Its
  `ranked-bar-list.ts` lives with the Overview, since a horizontal bar needs no
  SVG geometry.
- **P1.4 (AECI-578)** added the full §8 vocabulary as a separate, comprehensive
  library alongside it. Where the two overlap (a sparkline, a stacked time-series
  chart), the P1.4 components ship under distinct names —
  `series-sparkline.ts` (`<aec-series-sparkline>`, slot-based, tile owns the
  table) and `stacked-series-chart.ts` (`<aec-stacked-series-chart>`, the
  `[area]`-toggle bar/area with hover + data table) — so the merged Overview code
  is untouched. **Follow-up:** unify the Overview onto the P1.4 library and retire
  the P1.2 duplicates (`chart-geometry.ts` / `sparkline.ts` / `stacked-bar-chart.ts`).

The rest of this section describes the P1.4 library. Three things about it differ
from a literal reading of the rules above, each deliberate and each recorded here
rather than left for a reviewer to find.

**Modules.** `geometry.ts` (scales, ticks, paths, stacking, arcs), `format.ts`
(numbers + the UTC/WIB layer), `axis.ts` (the time-axis model), `chart-types.ts`
(series/category shapes and the slot vocabulary). All four are **Angular-free by
rule**, which is both the SSR-safety guarantee and what lets their specs run in
the fast plain-Vitest runner rather than `ng test` (§11).

**Components.** `series-sparkline`, `line-chart`, `stacked-series-chart` (`[area]`
flips bar ↔ area), `horizontal-bar-chart`, `donut-chart`, plus `stat-tile`,
`chart-legend` and `chart-data-table`.

**1. The palette is the `dataviz` skill's validated eight-hue reference set,
scoped to `/admin`.** "Colors from `DESIGN.md` semantic tokens" and "follows the
`dataviz` skill … categorical palette" are in tension: the brand system has one
meaning-bearing hue (Forest) plus Clay deep and Error red, which is not a
categorical palette and cannot become one without its own CVD validation pass. So
the skill's reference palette is adopted verbatim under a `.aec-charts` scope in
`apps/web/src/styles.css`, deliberately **outside `@theme inline`** so the hues
never become Tailwind utilities and cannot reach a public surface. Forest remains
the sole brand primary. Full table, validator output and the relief rule:
`DESIGN.md` §"Data visualization — operator console only".

**2. `HorizontalBarChart` is a real `<table>`, not `<svg role="img">` + a hidden
copy.** The hidden-table rule exists because SVG hides its numbers from a screen
reader. A ranked category-to-count list is already tabular, and rendering it as a
real table is strictly better on three counts: `dimension=product` rows link to
`/products/:slug` and **links inside a `role="img"` subtree are removed from the
accessibility tree**; a visible list plus an `sr-only` copy double-announces every
row; and `<th scope>` gives the row/column context §9.9 asks for. The rule's
actual requirement — *charts are never the only representation of a number* — is
satisfied maximally, since here the numbers are the primary representation and
the bar is the decoration. The other four charts carry the hidden table as
specified, always as a **sibling** of the `role="img"` element (nested, it would
be presentational and invisible to the reader it is for).

**3. The donut ships without a consumer.** §5.3 has no part-to-whole question the
horizontal bar does not answer better, and the `dataviz` skill deprioritises the
form outright and names two anti-patterns this section would hit: a 2-slice pie
(human/bot, which the stacked bar already answers over time) and a donut for
comparing close values (countries and sources differ by a few percent). It is
built and tested so the §8 vocabulary is complete and a later section with a
genuine few-category split can adopt it.

**Also shipped:** a hover crosshair/tooltip on the time-series charts, per the
skill's default. It is `aria-hidden` (the data table carries the values) and its
one `getBoundingClientRect` is inside a pointer handler — it feeds no geometry,
so the "no DOM measurement" rule is intact: delete the handler and the chart is
unchanged.

---

## 9. Non-functional requirements

1. **Authorization.** `requireAdmin()` is the single enforcement point. The SSR gate reuses the `adminSummaryResolver` pattern: a 401/403 renders the global 404 so the surface is never revealed.
2. **Caching.** `/admin/*` must remain absent from `ROUTE_CACHE_PATTERNS`, i.e. non-cacheable, cookie-forwarding, `private, no-store`. A cached admin response would be a visitor-state leak (§9.1a of the Stage 1 spec).
3. **Audit.** Reads emit nothing — including the `?recompute=1` reads (§6, §13 D8). For the epic's cron-written tables, §26.1 applies **as scoped by ADR 0022**, not in its former absolute form: `metrics_daily` and `job_runs` are derived bookkeeping and are exempt, while the §7.4 scheduled prune emits one summary `audit_log` row per run in the same batch as its delete. Any *domain-state* write this panel might later grow still emits its `audit_log` row in the same `db.batch([...])`.
4. **i18n.** All strings `i18n` / `$localize`, admin-only or not — the CLAUDE.md rule is unconditional.
5. **Timezone.** UTC is the default and matches the digest and every cron. The WIB toggle is presentational only; the underlying window is always UTC and is always labelled.
6. **No self-pollution — SHIPPED (AECI-575, 2026-08-12).** The console does not record its own navigation into the table it reads. The prefix list is `UNTRACKED_ROUTE_PREFIXES` (`/admin`, `/account`) in `@aeci/shared`, with `isUntrackedRoute()` enforcing an exact prefix-boundary match, so nested admin routes are covered without enumeration and a look-alike public path (`/administrators`) keeps being tracked. It is enforced in **three** places, all off the one list so they cannot drift: (a) `PageViewTracker.fire()` — the browser tracker, the only writer that reaches these routes today; (b) the SSR Worker's `firePageView()` — currently unreachable for these prefixes (`/admin/*` and `/account` are non-cacheable, and that branch fires only on a resolver-attached `ctx.pageView`, which no admin/account resolver sets), guarded anyway so the invariant survives a future resolver; and (c) **on read** — see **§13 D12**. Every query this panel adds over `page_views` (§5.2, §5.3, §6) inherits (c): the exclusion is a floor applied before the user-facing filters, not one of them.
7. **Privacy.** `page_views` deliberately stores a UA **hash** and a referrer **host** (never the full URL or query). The panel renders a truncated hash as a pseudonymous visitor id and must not attempt correlation beyond that.
8. **"Visitor" is a defined term.** Absent sessions, a visitor is a distinct `(user_agent_hash, cf_asn)` pair within the selected window. This over-counts (UA changes on browser update) and under-counts (shared NAT). The definition appears in the UI next to the number, not only in this document.
9. **Accessibility.** axe-clean on every surface; tables use proper header scope; filters are keyboard-operable; `impeccable detect` reports zero P0.
10. **Anchor-site rule.** The console inherits the existing admin queues' visual language rather than picking a new Mobbin anchor — same publication, one voice (`DESIGN.md` §Named Rules).

---

## 10. Build order

Issue-sized units. Phase 1 requires **no schema change** and carries most of the value.

**Base branch for every unit: `admin-panel`** (§13 D1). Sub-issues PR into it; one squash merge `admin-panel → main` closes the epic.

| # | Issue | Unit | Depends on |
|---|---|---|---|
| — | AECI-573 | **Decision gate**: settle §13 Q1–Q7, pick timing + base branch, promote this doc to a contract | — |
| **§9.6** | AECI-575 | Exclude `/admin/*` + `/account` from `PageViewTracker` — **SHIPPED 2026-08-12** (write side + retroactive read filter, §13 D12) | — |
| **P1.1** | AECI-574 | API: `overview`, `metrics/timeseries` (live-aggregation mode), `traffic/breakdown` — **SHIPPED 2026-08-12** | AECI-573 (D10) |
| **P1.2** | AECI-576 | UI: shell nav restructure (three groups, `h1` → "Admin") + Overview — **SHIPPED 2026-08-13**; also started `admin/charts/` (§8) | P1.1, §9.6 |
| **P1.3** | AECI-577 | API + UI: `GET /api/admin/page-views` + the Activity feed — **SHIPPED 2026-08-13** | P1.1 |
| **P1.4** | AECI-578 | UI: Traffic section + the full chart-primitive library (§8) — **SHIPPED** (§8.1; coexists with the P1.2 sparkline/stacked-bar pending a unify follow-up; three §5.3 items deferred, see §5.3) | P1.1 |
| **P1.5** | AECI-579 | API + UI: Catalog coverage + promotion funnel — **SHIPPED 2026-08-13** (`GET /api/admin/catalog/coverage` + `/admin/catalog`; table-first — the §8 chart primitives from P1.4 can be layered on above the existing table as a follow-up) | — |
| **P1.6** | AECI-580 | API + UI: System status (version, DQ on demand, Algolia, table counts) — **SHIPPED 2026-08-13** | — |
| **P2.1** | AECI-581 | `metrics_daily` + snapshot cron + backfill, **plus `products.promoted_at`** (§13 D6) — **SHIPPED 2026-08-13** (§7.1; three deviations recorded there) | P1.4 |
| **P2.2** | AECI-582 | Run the page-view bot backfill on production — **SHIPPED 2026-08-13** (all four tiers; §3) | — |
| **P3.1** | AECI-583 | `job_runs` + instrument all **nine** crons + persist DQ results (§7.1's snapshot job is the ninth) — **SHIPPED 2026-08-13** | P1.6 |
| **P3.2** | AECI-584 | Retention/pruning cron (§7.4) — **deprioritized**, see below | P3.1, **P2.1** |
| **P4.1** | AECI-585 | Page-view ingest fixes (§7.3: taxonomy entity, concrete path, SPA flag, `cf_as_organization`, drop the three dead columns) — **SHIPPED 2026-08-13**; ingest only, and its migration waits for the epic merge (§7.3) | — |
| **P5.1** | AECI-586 | Audience section (mailing list + feedback) | P1.4 |
| **§12** | AECI-587 | Docs closeout: the §12 update contract + the §14.3 stale claims | all shipping units |

**§9.6 moved ahead of P1.1** (§13 D10) **and has now shipped.** `PageViewTracker` had no path predicate, so every admin SPA navigation POSTed a page view *from the operator's own ISP* — the same AS23700 that is 67 of 92 "human" views in the §14.2 census. Excluding `/admin/*` removes a large slice of internal traffic **precisely, with no false positives**, and it had to land before the console is usable or the panel starts polluting the table it reads. It is also the cheaper half of the answer to internal-traffic filtering; `ANALYTICS_INTERNAL_ASNS` is the coarse remainder and is still unbuilt, so the digest's human count remains an upper bound.

P2.2, P4.1, and the §9.6 tracker exclusion are independent of the panel and improve the daily digest on their own — they can ship first if the panel slips.

**P3.2 depends on P2.1, not only P3.1.** Pruning raw `page_views` is irreversible and the daily snapshot is the only thing that survives it, so the prune must verify a `metrics_daily` row exists for every day inside the cut window rather than assuming the snapshot cron ran.

**P3.2 is deprioritized by D5.** At a 400-day window the cron deletes nothing until ~2027-07, so it is build-the-mechanism-now, fires-later. Ship it when convenient after P2.1 and P3.1; nothing else in the epic waits on it.

---

## 11. Testing

Per `TESTING_STRATEGY.md` and `UNIT_TESTING_GUIDE.md`:

- **API handlers** — specs against the in-memory D1 harness (`test/d1.ts`), covering filters, pagination, the human/bot predicate, entity hydration, window boundaries, and a non-admin receiving 403.
- **Chart geometry** — pure-function unit tests (scales, paths, ticks, empty and single-point series) with no rendering.
- **Components** — specs mirroring `request-queue.component.spec.ts`: SSR-neutral first paint, `afterNextRender` fetch, filter round trips, error and empty states.
- **Accessibility** — axe pass per surface; chart text alternatives asserted.
- **E2E** — one smoke per section (admin can load it, non-admin gets 404). Not a full matrix.
- **Date handling** — UTC boundary tests, including the WIB presentation offset.

---

## 12. Documents to update when this ships

Staleness is the recurring review finding, so this list is part of the contract:

| Document | Change |
|---|---|
| `API_CONTRACTS.md` | New section for every §6 endpoint, including the `?recompute=1` semantics (§13 D8). **The timeseries contract's `source` enum, per-point `reconstructed`, and the `exclude_internal`→live rule landed with AECI-581** |
| `DATABASE_SCHEMA.md` | `metrics_daily`, `job_runs`, `products.promoted_at`, `page_views.cf_as_organization`, the three dropped `page_views` columns, any new index. **Also correct the "Audit log and page_views retention: indefinite for Stage 1" line** — false once §7.4 lands. **`metrics_daily` (§9.3, with the full 19-key vocabulary), `products.promoted_at` (§4.2), and the retention correction all landed with AECI-581; `job_runs` landed as §9.4 (AECI-583); the `page_views` column changes — five added, three dropped, plus the migration-`0013` table-recreate note — landed with AECI-585**, with a retention line noting 90 days is specified but unenforced until AECI-584 |
| `STAGE_1_SPEC.md` §22 | Pointer to this document as the admin-surface source of truth. **Cite-check first** — `PHASE_8_COMPLETION.md` records two stale spec-cites in that file. **Landed with AECI-576**; the two recorded stale cites are §12 and §16, neither of which §22 touches, and §22's own content (`/admin/reviews`, the pending badge) is still accurate |
| `STAGE_1_SPEC.md` §26.1, §26.6 | The audit carve-out (§13 D11) and the retention scope cross-reference (§7.4). **Landed with AECI-573, not at closeout** |
| `adr/0022-cron-bookkeeping-exempt-from-audit-invariant.md` + `adr/README.md` | The ADR behind the §26.1 carve-out, plus its index row. **Landed with AECI-573** |
| `CODE_REVIEW_EXEMPTIONS.md` | The carve-out as a standing, non-expiring exemption pointing at ADR 0022 — so a reviewer meeting an unaudited cron write finds the reasoning. **Landed with AECI-573** |
| `CICD_PLAN.md` §10 | The `admin-panel` epic integration branch as a second time-boxed exception under ADR 0019's precedent (§13 D1). **Landed with AECI-573** |
| `AUTH_AND_RLS.md` | The new `/api/admin/*` endpoints under `requireAdmin()`, and the GDPR-erasure simplification once `page_views.user_id` is dropped (§7.3). `/api/admin/system` **landed with AECI-580**; the erasure simplification **landed with AECI-585** — §8's FK trap is now six inbound FKs, not seven, and the note explains why removing one *strengthens* erasure |
| `email.md` | Record which cron digests have a screen equivalent. **AECI-580** added the row for the 04:00 data-quality digest (`/admin/system?recompute=1`); the 05:00 analytics digest's screen is P1.2 (AECI-576) — its *API* shipped with P1.1, its screen has not, and the row must not claim otherwise |
| `ANALYTICS_BASELINE.md` | Drop "write-only today (no reporting endpoint)"; record the panel as the consent-independent read path; record that no session identifier was introduced (§13 D7) and why. The `/admin` + `/account` exclusion and its retroactive effect on pre-2026-08-12 counts **landed with AECI-575**. **AECI-585 added the trustworthy-from table** for the four new ingest fields — its dates are written as "the AECI-585 production deploy" and must be replaced with the real date at the `admin-panel → main` merge |
| `POST_LAUNCH_MONITORING.md` | The §1a cron table gained the 00:15 snapshot job (nine crons, AECI-581). Replace §1 rows 6 and 8 (cron liveness, moderation queue) with the panel, and the **weekly** §2 item 4 → §3b manual `wrangler d1 execute` ASN audit with §5.3's geography view. *(The manual D1 query is in the weekly procedure, not the daily — an earlier draft of this row said "daily".)* The ASN-census query gained the §9.6 path exclusion so it matches the digest — **landed with AECI-575**. **Row 6 is now retired in the sense that matters, and the doc states the split**: since AECI-583 the panel owns the *record* (last run, outcome, duration per job) and **Datadog owns *absence*** — a cron that never starts writes no `job_runs` row either, so only a no-data monitor can catch it. What AECI-580 retired outright: the DQ digest is readable on demand (row 5a) — and AECI-583 went further, making the last stored run the default view so the morning read needs no click and no email. D1 size / per-table row counts no longer need `wrangler d1 execute`. Row 8 waits on P1.2's Overview |
| `POST_LAUNCH_HEALTH_REPORT.md` | New dated entry (see §14.3). **AECI-585** amended the 2026-08-13 entry's follow-up: `cf_as_organization` is captured, but only forward, so that snapshot's ASNs still need manual lookup |
| `OBSERVABILITY.md` | Any new metric emitted by the snapshot / retention crons. **AECI-583 added** `aeci.job_runs.write` plus a "second recording surface, not a replacement" section reconciling `job_runs` against the existing per-cron heartbeats (panel owns the record, Datadog owns absence) |
| `RUNBOOKS.md` | Runbook entries for the snapshot and retention crons, matching every other cron's. **AECI-583 added** "Cron runs missing or stuck in flight on `/admin/system`" (the Unknown / Inferred / In-flight triage) and amended the data-quality + Algolia-drift entries, whose first checks now start at the panel |
| `TESTING_STRATEGY.md` | The §11 approach — chart-geometry pure-function tests are a new category for this repo. **Landed with AECI-576** (§3.2 "Always"). **AECI-580 added §6.3's "the harness is better-sqlite3, and its limits are not D1's"**: the System screen's row-count query passed every unit test and 500'd on the first real request (`SQLITE_MAX_COMPOUND_SELECT` is 5 on D1, 500 in the harness) |
| `CACHE_STRATEGY.md` | Record `/admin/*` as deliberately uncacheable (`private, no-store`, absent from `ROUTE_CACHE_PATTERNS`) so §9.2 is enforced from the caching doc too. **Landed with AECI-574** (§4, "`/admin/*` is deliberately uncacheable"); AECI-576 added `/admin/overview` to the `server.spec.ts` assertion that backs it |
| `environments.md`, `access.md` | `ANALYTICS_INTERNAL_ASNS` per tier (§13 D10) — declared, shipped unset |
| `migrations.md` | Usually no change; confirm consciously, since this epic adds the repo's first table-recreate migration (§7.3). **AECI-585 added §3.3a** — the SQLite `DROP COLUMN` restriction, the `PRAGMA defer_foreign_keys` substitution drizzle-kit's output needs for D1, keeping the PK explicit in the copy, and verifying against non-empty data |
| `PHASE_8_COMPLETION.md` | **Append** Phase 8.3, per that file's own Note D ("intentionally re-openable") |
| `docs/README.md`, root `CLAUDE.md` | Index entries (added with this document; the draft-status qualifiers were replaced with the D1 answer by AECI-573). `CLAUDE.md`'s audit rule and `DATABASE_SCHEMA.md` §18 were also rescoped to domain state under ADR 0022 — **landed with AECI-573** |

---

## 13. Decisions and open questions

D1–D4 were settled when this document was drafted. **D5–D11 were settled by AECI-573 on 2026-08-12**, which promoted this document to v1.0. Each records the reasoning, not just the verdict, because the reasoning is what a future reader needs in order to reopen the decision responsibly.

**Settled**

- **D1 — Timing and base branch. Phase 8.3, on the `main` line, integrated via the `admin-panel` epic branch.** Phase 8 is explicitly *"an ongoing post-launch operate-and-tune period"* and *"intentionally re-openable"* (`PHASE_8_COMPLETION.md` §F4, Note D); 8.1 was AECI-279 and 8.2 is AECI-280, so this is **8.3**. It is **not** Stage 2 work by that spec's own test — *"anything that requires a vendor to authenticate and assert something about their own product is Stage 2"* (`STAGE_2_SPEC.md` §1) — and an operator console requires no vendor at all; `STAGE_2_SPEC.md` has no epic row for it and its §9 bars schema changes not reserved by its §3.

  All 15 issues base on and merge into **`admin-panel`**; one squash merge `admin-panel → main` closes the epic. That is a **second** long-lived branch alongside `stage-2`, i.e. a second time-boxed exception to `CICD_PLAN.md` §10 — recorded there rather than left implicit. Two obligations follow. **(a) Merge `main → admin-panel` regularly**, mirroring ADR 0019's `main → stage-2` discipline, and reconcile the Drizzle migration journal before the final merge-up. **(b) Staging never exercises the panel until that final merge** (staging auto-tracks `main`), so **per-PR preview Workers are the verification surface** — matching `environments.md`. The compensating benefit is that ADR 0019's forward-only-migration hazard is concentrated into one reviewable moment instead of dripping into production D1 sub-issue by sub-issue.

- **D2 — Emails stay.** Push (daily digest) and pull (panel) are complementary. No cron is retired.
- **D3 — Charts are hand-rolled SVG.** No new client dependency (§8).
- **D4 — Spec home.** This document. Anchor issues with `**Spec section:** §X (docs/ADMIN_PANEL_SPEC.md)`.

- **D5 — Retention: 400 days of raw `page_views`** (was Q1; §7.4). Storage is not the binding constraint — 180 d ≈ 125 MB and 400 d ≈ 280 MB against D1's 10 GB limit. Irreversibility is: D1 Time Travel recovers only ~30 days, so a mistaken prune beyond that is permanent. 400 days is the first window that keeps year-over-year comparison possible, with ~5 weeks of overlap. Consequence, stated rather than discovered later: at 400 days the cron **deletes nothing until ~2027-07**, which is why §10 deprioritizes P3.2. The window is a config constant so it can shorten without a migration. `metrics_daily` stays indefinite, `job_runs` 90 days.

- **D6 — Add `products.promoted_at`, set-once** (was Q2; §7.3). Adopted as future-proofing, with the §4 premise corrected: **`products.created_at` is already the first-promote timestamp**, because promote is D1's only INSERT path into `products` and sets `'promoted'` on both branches, nothing ever writes `'ready'`, and retraction hard-deletes. So the column earns its keep only against a *future* un-promote → re-promote cycle (a Tier-1 retract endpoint) — and its backfill is **exact** (`:= created_at`), not reconstructed. Because promote re-asserts `'promoted'` on update, set-once via `COALESCE("promoted_at", ?)` is mandatory or it degrades to "last promoted" and buys nothing over `updated_at`.

  Two corrections ride along. The former claim that this **"fixes `data-quality.ts` check #2"** is **withdrawn**: check #2 filters `promotion_status='ready'`, which is unreachable in D1, so that check is *structurally dead* rather than merely proxied — spun out as its own issue. And the reviewer objection to anticipate: ADR 0021 vetoed `airtable_record_id` on `products` as "no curation-tool key in the public schema". `promoted_at` is app-owned catalog state, not a foreign curation key — a different category.

- **D7 — Drop `user_id`, `session_id`, `profile_role`; introduce no session identifier** (was Q3; §7.3, §9.8). The §9.8 `(user_agent_hash, cf_asn)` visitor definition stands, with its over- and under-counting stated next to the number. `session_id` has no source — `PageViewTracker` sends `{ route }` and there is no client-side session id anywhere in `apps/web` — and inventing one would create a durable first-party identifier, which is exactly what makes the current `page_views` write defensible as **consent-independent**. `user_id` is technically reachable on the browser POST but never on the SSR arrival path, so it would be right half the time. The three columns differ in migration cost; §7.3 has the per-column table.

- **D8 — Manual job triggers: split on side effects, not on manual-ness** (was Q4; §6). This resolved a live self-contradiction — §6 deferred `POST /api/admin/jobs/:job/run` while §5.1 required a "recompute today's digest" action and §5.6 required "DQ on demand". **Recomputation is in scope as a `GET`** (`?recompute=1`): both the DQ job and the digest's metric collection are already pure reads, so they write nothing, send nothing, and carry no audit obligation — §6's "read-only" framing and §9.3 stay unconditionally true. **Running a job for real stays deferred** — anything that writes, emails, purges, or calls an external API. Owner **@chrisw**; revisit when an operator first needs to force a job outside its window during an incident.

- **D9 — PostHog reverse proxy: spun out** (was Q5). **AECI-590**, outside the AECI-572 epic, Low priority. Nothing in this epic depends on it. Scoped honestly there: `posthog-js` is not imported until consent is `granted`, so the recoverable population is only *"users who accepted the banner **and** run a blocker"* — smaller than "blocker-lost events" implies.

- **D10 — `ANALYTICS_INTERNAL_ASNS` accepted, as a query-time filter only** (was Q6; §5.2). Q6's worry is the same objection `lib/bot-classification.ts` already codifies for `DATACENTER_ASNS` — *"NO residential subscriber can sit behind it … a false positive deletes a human from the digest."* **The resolution is that the two lists are different kinds of object.** `DATACENTER_ASNS` writes `is_bot` at ingest: permanent, unreviewable, destructive of a real person's row — hence the strict doctrine. `ANALYTICS_INTERNAL_ASNS` is a `WHERE` clause evaluated at read time: nothing stored changes, it is toggleable per query, trivially reversible. The doctrine does not transfer. Three constraints make that binding: **(1) query-time only** — never touches `is_bot`, never runs at ingest, never enters `scripts/ops/backfill-page-view-bots.sql`; **(2) show both numbers, never substitute** — §1.1 forbids silently reporting the filtered figure; **(3) declare the seam, ship it unset**, mirroring `PAGE_VIEWS_MIN_BOT_SCORE`.

  It is also the *coarse remainder*, not the main instrument. Two more precise measures do most of the work: **AECI-575 moved ahead of P1.1 and shipped 2026-08-12** (excluding `/admin/*` from the tracker removes operator traffic with zero false positives — see D12 for its retroactive half), and **`cf_as_organization` is captured at ingest** (§7.3) — the fix `POST_LAUNCH_MONITORING.md` §3b already names: *"not a longer list — it is capturing Cloudflare's `asOrganization` … and matching on the holder name."*

- **D11 — No `audit_log` row for cron-internal bookkeeping; scheduled deletes are the exception** (was Q7; §7.1, §7.2, §7.4, §9.3). Recorded as **ADR 0022**, with the carve-out written into `STAGE_1_SPEC.md` §26.1 itself — Q7 was right that a carve-out documented only here would be a spec contradiction waiting to be found in review.

  The decisive finding is that **the carve-out already existed, in the wrong file**. §26.1 says, unqualified, *"every write path … no state change happens without a corresponding audit entry"* — but `API_CONTRACTS.md` §6.9 already narrowed it to state-changing **domain** writes in order to exempt `page_views`, and §6.13 extends that to `mailing_list` / `feedback` including the unsubscribe soft-delete. The word "domain" appeared nowhere in §26.1, `DATABASE_SCHEMA.md` §18, or `CLAUDE.md`. Two further facts made "no" the only coherent answer: **every** D1-writing cron today writes without an audit row (`stats_cache` from the 07:00 job, the Algolia watermark, the `*/15` reconcile sweep), and answering "yes" would force `metrics_daily` into a batch, destroying the per-key partial-failure isolation `lib/home-stats.ts` explicitly specifies and which §7.1 mirrors by design. Nothing schema-side blocked "yes" — `actor_type` already permits `'system'` and promote uses it ~10× — which is precisely why the rule had to be written down rather than left to reviewer taste.

  **Scheduled deletion is carved back in**: any scheduled `DELETE` emits exactly one *summary* row per run (`action='retention.pruned'`, `metadata={table, cutoff, rowsDeleted}`), in the same batch as the delete. Deletion is the one write whose fact cannot be recovered from the data afterwards.

- **D12 — The §9.6 exclusion is retroactive: filter on read as well, silently** (settled by AECI-575 on 2026-08-12; §5.2, §5.3, §6, §9.6). AECI-575 asked whether the panel's queries should also exclude the `/admin/*` rows already in the table. **Yes.** Stopping the writers only fixes the future; the ~26k rows in the §14.2 census already contain operator navigation, and once written those rows are *indistinguishable from real traffic* — nothing on them says "internal". Filtering only at the write side would leave a permanent seam in the data at the ship date, with every pre-fix day inflated relative to every post-fix day and no way to compare across it. The filter is a `WHERE` clause built from the same `UNTRACKED_ROUTE_PREFIXES` list the writers use, so the two halves cannot drift, and it costs nothing — `page_views_path_idx` already covers `path`.

  It landed in the **daily analytics digest** (`lib/analytics-digest.ts`, all four `page_views` reads), which is the entire live read surface today; `computeTrendingProducts` was already immune via `isNotNull(product_id)`, since an admin row carries no product. Every query P1.1+ adds inherits it as a floor beneath the user-facing filters.

  **It is deliberately silent** — no "N internal views excluded" line in the digest email, unlike the bot-exclusion line beside it. D10's constraint (2) ("show both numbers, never substitute") governs `ANALYTICS_INTERNAL_ASNS`, and does so because that filter is a *heuristic over real visitors* whose false positives must stay visible. A path exclusion is not a heuristic: `/admin/*` traffic is internal by construction, with no false-positive class to disclose. Reporting it as a subtracted quantity would frame operator clicks as visits that were removed, when they were never visits. The one honest-numbers obligation this does carry is recorded in `ANALYTICS_BASELINE.md`: digest counts for days before 2026-08-12 now read lower than the emails sent at the time, and the rows are still in D1 for any query that wants them.

**Open**

*(none — every question is settled above. Q5 was spun out as D9 rather than answered here.)*

**Found while settling these, and deliberately not absorbed** — each is real, each is outside this epic, and each has its own issue:

- **A live §26.1 gap on a domain entity** — **AECI-591**. The `*/15` reconcile sweep mutates `vendor_requests` and `workflow_instances` with no audit row and no batch (`lib/linear.ts`). That is domain state under any reading of ADR 0022's carve-out — a genuine violation, not bookkeeping, and more serious than anything this epic introduces.
- **`data-quality.ts` check #2 is unreachable**, not merely proxied (see D6) — **AECI-592**. It should be replaced by a check that asserts the invariant D6 depends on — that every `products` row reads `promotion_status='promoted'` — so the assumption cannot silently rot.

---

## 14. Appendix

### 14.1 Digest inventory

`lib/analytics-digest.ts` (05:00 UTC): traffic (human page views + day-over-day delta) · top 5 products by human views · traffic sources by `referrer_source` · new and total sign-ins · reviews awaiting moderation · bot/crawler views grouped by `bot_name` · footnotes on classification and referrer bias.

`lib/data-quality.ts` (04:00 UTC), ten checks: `products_without_vendor` · `ready_products_unpromoted` · `broken_integration_refs` · `vendors_without_products` · `reviews_missing_anonymized_at` · `stale_stats_cache` · `duplicate_vendors` · `duplicate_products` · `logo_404` · `algolia_index_drift`.

Nine crons total: 00:15 metrics snapshot · 04:00 data quality · 05:00 analytics digest · 06:00 moderation snapshot · 07:00 home stats · 08:00 Algolia sync · 09:00 index drift · `*/15` request→Linear reconciliation · hourly WAF poll.

### 14.2 Production census, 2026-08-12

```
products 171 (all promoted) · integrations 496 · vendors 126
claims 915 · attestations 915
taxonomy: 33 categories · 30 audiences · 5 phases · 34 trades · 20 data objects
product_categories 373 · product_trades 0
products with no logo: 171 · products with no description: 0
profiles 2 · reviews 0 · mailing_list 0 · feedback 0 · vendor_requests 0 · workflow_instances 0
page_views 26,126 (bots 7,845 · unclassified 17,784 · classified human 497)
audit_log: attestation.created 5,375 · claim.created 5,375 · integration.updated 2,082 ·
  integration.created 827 · vendor.updated 394 · product.updated 358 · product.created 131 ·
  vendor.created 94 · product.extension_created 20 · category.created 6 · audience.created 3 ·
  phase.created 2 · profile.created 2 · catalog.integrations_reset 1
stats_cache: 12 keys, computed_at 2026-08-12T01:27Z
D1 size: ~18.15 MB
```

Traffic sources for the 2026-08-10 digest day (87 Direct / 2 Other / 2 Google / 1 DuckDuckGo = 92 "human"): 67 of the 92 originated from the operator's own ISP (AS23700, Jakarta), and of the five referred arrivals, two were the operator (a LinkedIn Android in-app browser view and a click from `directory-concept.thewbsproject.com`). Three were genuine external arrivals — two via Google (one on a residential ISP, one behind Netskope) and one via DuckDuckGo behind Zscaler.

### 14.3 Known-stale claims found while planning

- `POST_LAUNCH_HEALTH_REPORT.md` — the "observable-vs-blocked" matrix lists PostHog and Datadog RUM as **dark, gated on secrets**. Production now injects both (`__AECI_POSTHOG__` and `__AECI_DD__` confirmed in the served HTML on 2026-08-12). Because that file is a dated log, the correct fix is a **new entry**, not an edit to the historical one.
- ~~`ANALYTICS_BASELINE.md` — "write-only today (no reporting endpoint); query D1 directly" becomes false the moment §10 P1.1 lands.~~ **Resolved 2026-08-12 by AECI-574**: the row now points at the three read endpoints, and a new "consent-independent read path" section records the three biases and the §13 D7 no-session-identifier decision. Its *other* half — the description of what `page_views` sees — went stale earlier, on 2026-08-12, when AECI-575 narrowed the table to public routes; **corrected there** (instrumentation-status row + a dated addendum).
- `data-quality.ts` check #2's inline note that there is no `promoted_at` column is accurate, but **understates the problem**: the check filters `promotion_status='ready'`, and nothing in the repo ever writes `'ready'` to D1, so it can only ever return zero rows. It is unreachable, not proxied (§13 D6). **AECI-592.**

Found while settling §13 (AECI-573):

- `DATABASE_SCHEMA.md` — *"Audit log and page_views retention: indefinite for Stage 1"* becomes false for `page_views` the moment §7.4 lands. The `audit_log` half stays true (`STAGE_1_SPEC.md` §26.6).
- `STAGE_1_SPEC.md` §26.1 and §26.6 — both still describe the **Supabase** era: §26.1 said writes call `appendAuditLog(...)` "as part of its transaction", and §26.6 says "indefinite retention in Supabase". The D1 reality (ADR 0016) is `auditInsert()` inside `db.batch([...])`. §26.1 was corrected by AECI-573 as part of the D11 carve-out; §26.6's wording was corrected alongside it.
- This document's own §12 row for `POST_LAUNCH_MONITORING.md` said the panel replaces manual D1 queries in *the daily procedure*. The manual `wrangler d1 execute` ASN audit is in the **weekly** procedure (§2 item 4 → §3b); the daily procedure is Datadog dashboards. Corrected in §12.
- This document's §4 claimed `created_at` is not a go-live date because rows sit at `promotion_status='ready'` first. That is the review app's lifecycle, not D1's. Corrected in §4 and §13 D6.
