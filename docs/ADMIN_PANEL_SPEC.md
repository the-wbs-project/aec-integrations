# AEC Integrations — Admin Panel Specification (Operator Console)

**Version:** 0.1 — **plan and scope, not yet a build contract**
**Date:** August 2026
**Status:** Draft. Scope, data inventory, and build order are settled; **timing is deliberately undecided** (the phase/branch this lands on is a later call). Sections are numbered so a Linear issue can anchor to one via `**Spec section:** §X (docs/ADMIN_PANEL_SPEC.md)` per the `spec-anchor` skill.
**Inherits from:** Stage 1 (`STAGE_1_SPEC.md`, §22 admin surfaces + §26 audit), Phase 5.12–5.14 (the `/admin` shell + gate), Phase 6.9–6.11 (the requests + reviewer queues)
**Tracker:** epic **AECI-572**, sub-issues **AECI-573 … AECI-587** (mapped to the §10 build order). The first sub-issue (AECI-573) is the decision gate that answers §13's open questions and promotes this document from draft to build contract.
**Companion docs:** `API_CONTRACTS.md` (endpoint shapes), `DATABASE_SCHEMA.md` (tables/indexes), `OBSERVABILITY.md` (Datadog metric catalog), `POST_LAUNCH_MONITORING.md` (the runbook this panel operationalizes), `ANALYTICS_BASELINE.md` (what PostHog does and does not see), `email.md` (the two cron digests), `AUTH_AND_RLS.md` (`requireAdmin()`)

> **Data-layer note (ADR 0016).** The application database is **Cloudflare D1 + Drizzle**; Supabase is auth-only. Every read in this document goes through `getDb(env)`. The panel is **read-only** — no `audit_log` rows, no cache work, no purges. If a future iteration adds a write (a manual job trigger), that write must carry its `audit_log` row in the same `db.batch([...])` per the §26.1 invariant.

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
- Persisting cron and data-quality results so "current status" is inspectable (§7.2).
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
- **`page_views` bot classification is only trustworthy from ~2026-08-05.** 17,784 of 26,126 rows have `is_bot IS NULL` and therefore read as *human* under the digest's `is_bot IS NOT 1` predicate. The one-time `scripts/ops/backfill-page-view-bots.sql` has **never been run on production**. Monthly split: Jun 750 (100% unclassified), Jul 15,748 (100%), Aug 9,628 (13%).
- **`referrer_source` is null on every row before August** and is not backfillable — the header was never stored.
- **`page_views.user_id`, `.session_id`, `.profile_role` are dead columns.** The ingest handler (`routes/page-views.ts`) never writes them, so page views cannot be tied to a signed-in user and there is no session concept.

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
- `products` has **no `promoted_at`** — a row sits at `promotion_status='ready'` before going live, and `updated_at` resets on any edit (the same limitation `data-quality.ts` check #2 documents). `created_at` is therefore not a go-live date.
- `audit_log` *is* a genuine event stream (`product.created` 131, `integration.created` 827, `vendor.created` 94, since 2026-06-26), so **additions** are chartable. But **net totals are not**: 827 `integration.created` events against 496 live rows, because the 2026-07-25 `catalog.integrations_reset` removed rows without per-row audit; ~40 products predate the log entirely; and 5,375 `claim.created` events back 915 live claims because promote re-creates the claim spine.

**Conclusion:** a **daily snapshot table is the only honest way to get counts-over-time** (§7.1), with an approximate historical series backfilled from `audit_log` and labelled as approximate in the UI.

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

### 5.1 Overview

The analytics digest as a live page. Stat tiles with sparklines — human page views, unique visitors, new sign-ins, active subscribers, catalog totals — each with a day-over-day and 7-day delta matching the email's `deltaText` semantics. Below: a 30-day traffic chart (human vs bot), top traffic sources, top viewed products, and a status strip (prod SHA · stats freshness · failing DQ checks · Algolia drift · moderation depth). A **"recompute today's digest"** action so the operator is not waiting for 05:00 UTC.

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

Filters: date range · traffic type (humans / bots / all, default humans) · source · country · path contains · **"filter out internal traffic"**, mirroring PostHog's toggle, backed by an `ANALYTICS_INTERNAL_ASNS` var. That last one is not cosmetic: on 2026-08-10, **67 of 92 "human" views came from the operator's own ISP** (AS23700, Jakarta).

Entity hydration follows the `target` `LinkRef` pattern already used by `GET /api/admin/requests`, so `/products/:slug` renders as a linked product name.

### 5.3 Traffic

Time series over `page_views`: views/day split human vs bot · unique visitors/day (§9.8) · sources over time · top pages · top products · geography (country + colo) · crawler activity per bot over time. A UTC ↔ WIB toggle (§9.5), since the digest and every cron are UTC-only and the operator is at UTC+7.

### 5.4 Audience

Subscribers cumulative and net-new · unsubscribes and churn rate (`unsubscribed_at` is a soft delete, so churn is exactly computable) · UTM source/medium/campaign breakdown · signup geography · and the **feedback inbox** as a readable list. `feedback` is written by `POST /api/feedback` and has **no read surface anywhere in the product today**.

Renders empty states until signups begin (§3). Cheap to build alongside §5.3 and needed the day the first subscriber arrives.

### 5.5 Catalog

- **Counts over time** — products / integrations / vendors / claims (§7.1), with the pre-snapshot segment visually marked as an audit-log approximation.
- **Additions per day** from `audit_log` `*.created` events.
- **Promotion funnel** — `pending → ready → promoted → retracted / rejected` from `products.promotion_status`.
- **Coverage gaps as actionable lists** — products without a vendor, without a logo (171 today), without a description, untagged per facet (`product_trades` is 0), missing API docs, `research_status` distribution.
- **Taxonomy usage** per facet, plus the trades publication gate (`TRADES_VOCABULARY.md`).
- **Claims / attestations** counts and coverage per integration (Stage 1.5 spine).

This is the section that steers daily catalog work, and the one whose underlying data is richest today.

### 5.6 System

- SSR + API `sha` / `deployedAt` / `environment` from the two existing endpoints (`/api/version` and the SSR Worker's own `/_version` — they differ precisely so a stale SSR deploy is detectable).
- **Cron liveness** — last run, duration, outcome per job, for all eight crons (§7.2).
- **The ten data-quality checks** rendered with severity and sample rows — today visible only in an email.
- Algolia sync watermark, index drift, orphan-sweep results.
- D1 size and per-table row counts.
- Link-outs to the Datadog dashboards and PostHog.

Effectively the daily procedure in `POST_LAUNCH_MONITORING.md` turned into one screen.

---

## 6. API surface

All endpoints are `GET`, admin-gated, read-only. They register on the existing `authAdmin` sub-router in `apps/api/src/index.ts` behind `requireAdmin()`, which stays the single enforcement point (`AUTH_AND_RLS.md`). Contracts live in `packages/shared/src/api/admin-panel.ts` and reuse `PageQuerySchema` (`page` / `perPage`, capped at 100) and `paginatedResponseSchema` so list shapes match `/api/admin/requests`.

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET /api/admin/overview` | The §5.1 bundle | One round trip; mirrors `collectAnalyticsMetrics` |
| `GET /api/admin/page-views` | §5.2 feed | Paginated + filtered; entity-hydrated `LinkRef` |
| `GET /api/admin/metrics/timeseries` | `?metric=&from=&to=&interval=day` | Serves `metrics_daily` (§7.1); falls back to live aggregation pre-snapshot |
| `GET /api/admin/traffic/breakdown` | `?dimension=source\|country\|path\|product\|bot` | Grouped counts over a window |
| `GET /api/admin/catalog/coverage` | §5.5 gap lists + funnel | Capped sample rows, exact counts |
| `GET /api/admin/audience` | §5.4 aggregates | Subscribers, churn, UTM, geo |
| `GET /api/admin/feedback` | Paginated feedback list | First read surface for the table |
| `GET /api/admin/system` | §5.6 bundle | Version, cron runs, latest DQ, Algolia, table counts |

**Conventions.** No `audit_log` rows (reads only — §26.1 governs writes). No `Cache-Tag`, no edge caching; `/admin/*` is absent from `ROUTE_CACHE_PATTERNS` in `server-runtime.ts` and therefore takes the non-cacheable branch with `private, no-store`. That must stay true (§9.2). Response validation in dev via `validateResponseInDev`, as with the other admin routes.

A `POST /api/admin/jobs/:job/run` manual trigger is **deferred** (§13, Q4); it is a state-changing write and would need its `audit_log` row in the same batch.

---

## 7. Data-layer changes

None of these are needed for Phase 1 (§10). They are what makes Phases 2–4 possible.

### 7.1 `metrics_daily` — the snapshot table

The fix for §4's hard problem. A narrow key-value shape rather than one column per metric, so adding a metric never needs a migration — mirroring the `stats_cache` key convention (`home.total_products`, …):

```
metrics_daily
  day         TEXT NOT NULL   -- 'YYYY-MM-DD', UTC
  metric      TEXT NOT NULL   -- 'catalog.products_promoted', 'traffic.page_views_human', …
  value       REAL NOT NULL
  computed_at TEXT NOT NULL
  PRIMARY KEY (day, metric)
```

Written by a daily cron (co-locate with the 07:00 stats job or add a slot after it), idempotent per `(day, metric)` so a re-run corrects rather than duplicates. Metric vocabulary documented here and in `DATABASE_SCHEMA.md`; it covers catalog totals, traffic counts, subscriber counts, and queue depths.

**Backfill:** derive an approximate historical series from `audit_log` `*.created` events plus `page_views`, insert with a `computed_at` that marks it as reconstructed, and label the pre-snapshot segment in the UI. Do not present it as exact — §4 explains why it cannot be.

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

Each of the eight cron handlers in `scheduled.ts` writes one row. The data-quality run stores its full result set in `detail`, which is what §5.6 renders. Retention: 90 days.

### 7.3 Backfills and ingest fixes

| Item | Why |
|---|---|
| Run `scripts/ops/backfill-page-view-bots.sql` on production | 17,784 rows currently read as human; every historical traffic chart is wrong until this runs |
| Capture taxonomy entities on page views | `resolveEntity` maps only `product`/`vendor`; category/audience/phase/trade ids are dropped, so ~600 rows cannot say *which* term was viewed |
| Store the concrete path alongside the route pattern | Detail-page rows store `/products/:slug`; product/vendor rows recover the name via FK, taxonomy rows cannot |
| Add a `navigation: 'spa' \| 'arrival'` flag to the page-view payload | `PageViewTracker` POSTs on every SPA navigation and the same-origin `Referer` classifies as `Direct`, so in-app navigation and true direct arrivals are indistinguishable — `Direct` is a mixed bucket |
| Resolve the dead columns | Either write `session_id` at ingest or formally drop `user_id` / `session_id` / `profile_role` and define "visitor" per §9.8 |
| Consider `products.promoted_at` | Removes the §4 ambiguity at the source; also fixes data-quality check #2's documented proxy |

### 7.4 Retention

`page_views` grows ~1,000 rows/day (18.15 MB total today). Proposal: raw rows kept **180 days**, `metrics_daily` kept indefinitely, `job_runs` kept **90 days**. Enforced by a pruning cron added with §7.2.

---

## 8. Charting

**Hand-rolled SVG. No charting dependency.** `apps/web` currently has no chart library and the chart vocabulary here is small: sparkline, line, stacked bar/area, horizontal bar, donut. Components live in `apps/web/src/app/admin/charts/`.

Rules:

- **SSR-safe.** Geometry is computed from data in pure functions — no DOM measurement, no `window`, no post-hydration layout pass.
- **Accessible.** Each chart is `role="img"` with a descriptive `aria-label`, plus a visually-hidden `<table>` carrying the same series. Charts are never the only representation of a number.
- **Tokenized.** Colors from `DESIGN.md` semantic tokens; light theme only (the Stage 1 constraint holds — no `dark:` variants).
- **Follows the `dataviz` skill** for form selection, categorical palette, and stat-tile composition.
- **Responsive** via `viewBox` + `preserveAspectRatio`, not JS resize handlers.
- Geometry functions are pure and unit-tested independently of rendering (§11).

---

## 9. Non-functional requirements

1. **Authorization.** `requireAdmin()` is the single enforcement point. The SSR gate reuses the `adminSummaryResolver` pattern: a 401/403 renders the global 404 so the surface is never revealed.
2. **Caching.** `/admin/*` must remain absent from `ROUTE_CACHE_PATTERNS`, i.e. non-cacheable, cookie-forwarding, `private, no-store`. A cached admin response would be a visitor-state leak (§9.1a of the Stage 1 spec).
3. **Audit.** Reads emit nothing. Any future write emits its `audit_log` row in the same `db.batch([...])`.
4. **i18n.** All strings `i18n` / `$localize`, admin-only or not — the CLAUDE.md rule is unconditional.
5. **Timezone.** UTC is the default and matches the digest and every cron. The WIB toggle is presentational only; the underlying window is always UTC and is always labelled.
6. **No self-pollution.** `PageViewTracker` must skip `/admin/*` (and `/account`) so the console does not record its own navigation into the table it reads.
7. **Privacy.** `page_views` deliberately stores a UA **hash** and a referrer **host** (never the full URL or query). The panel renders a truncated hash as a pseudonymous visitor id and must not attempt correlation beyond that.
8. **"Visitor" is a defined term.** Absent sessions, a visitor is a distinct `(user_agent_hash, cf_asn)` pair within the selected window. This over-counts (UA changes on browser update) and under-counts (shared NAT). The definition appears in the UI next to the number, not only in this document.
9. **Accessibility.** axe-clean on every surface; tables use proper header scope; filters are keyboard-operable; `impeccable detect` reports zero P0.
10. **Anchor-site rule.** The console inherits the existing admin queues' visual language rather than picking a new Mobbin anchor — same publication, one voice (`DESIGN.md` §Named Rules).

---

## 10. Build order

Issue-sized units. Phase 1 requires **no schema change** and carries most of the value.

| # | Issue | Unit | Depends on |
|---|---|---|---|
| — | AECI-573 | **Decision gate**: settle §13 Q1–Q7, pick timing + base branch, promote this doc to a contract | — |
| **P1.1** | AECI-574 | API: `overview`, `metrics/timeseries` (live-aggregation mode), `traffic/breakdown` | AECI-573 (Q6) |
| **§9.6** | AECI-575 | Exclude `/admin/*` + `/account` from `PageViewTracker` | — |
| **P1.2** | AECI-576 | UI: shell nav restructure (three groups, `h1` → "Admin") + Overview | P1.1, §9.6 |
| **P1.3** | AECI-577 | API + UI: `GET /api/admin/page-views` + the Activity feed | P1.1 |
| **P1.4** | AECI-578 | UI: Traffic section + the chart primitives (§8) | P1.1 |
| **P1.5** | AECI-579 | API + UI: Catalog coverage + promotion funnel | — |
| **P1.6** | AECI-580 | API + UI: System status (version, DQ on demand, Algolia, table counts) | — |
| **P2.1** | AECI-581 | `metrics_daily` + snapshot cron + `audit_log` backfill | P1.4 |
| **P2.2** | AECI-582 | Run the page-view bot backfill on production | — |
| **P3.1** | AECI-583 | `job_runs` + instrument all eight crons + persist DQ results | P1.6 |
| **P3.2** | AECI-584 | Retention/pruning cron (§7.4) | P3.1, **P2.1** |
| **P4.1** | AECI-585 | Page-view ingest fixes (§7.3: taxonomy entity, concrete path, SPA flag, dead columns) | — |
| **P5.1** | AECI-586 | Audience section (mailing list + feedback) | P1.4 |
| **§12** | AECI-587 | Docs closeout: the §12 update contract + the §14.3 stale claims | all shipping units |

P2.2, P4.1, and the §9.6 tracker exclusion are independent of the panel and improve the daily digest on their own — they can ship first if the panel slips.

**P3.2 depends on P2.1, not only P3.1.** Pruning raw `page_views` is irreversible and the daily snapshot is the only thing that survives it, so the prune must verify a `metrics_daily` row exists for every day inside the cut window rather than assuming the snapshot cron ran.

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
| `API_CONTRACTS.md` | New section for every §6 endpoint |
| `DATABASE_SCHEMA.md` | `metrics_daily`, `job_runs`, new `page_views` index, any ingest columns |
| `STAGE_1_SPEC.md` §22 | Pointer to this document as the admin-surface source of truth |
| `ANALYTICS_BASELINE.md` | Drop "write-only today (no reporting endpoint)"; record the panel as the consent-independent read path |
| `POST_LAUNCH_MONITORING.md` | Replace manual D1 queries in the daily procedure with the panel |
| `POST_LAUNCH_HEALTH_REPORT.md` | New dated entry (see §14.3) |
| `OBSERVABILITY.md` | Any new metric emitted by the snapshot / retention crons |
| `email.md` | Note that both digests now have a screen equivalent |
| `docs/README.md`, root `CLAUDE.md` | Index entries (added with this document) |

---

## 13. Decisions and open questions

**Settled**

- **D1 — Timing.** Deferred. The phase and base branch this lands on are a later call; nothing here assumes one.
- **D2 — Emails stay.** Push (daily digest) and pull (panel) are complementary. No cron is retired.
- **D3 — Charts are hand-rolled SVG.** No new client dependency (§8).
- **D4 — Spec home.** This document. Anchor issues with `**Spec section:** §X (docs/ADMIN_PANEL_SPEC.md)`.

**Open**

- **Q1** — Retention window: is 180 days of raw `page_views` right (§7.4)?
- **Q2** — Add `products.promoted_at`, or keep `audit_log` as the promotion-event source (§7.3)?
- **Q3** — Write `session_id` at ingest, or formally drop the three dead columns and keep the §9.8 definition?
- **Q4** — Are manual job triggers (`POST /api/admin/jobs/:job/run`) in scope, given they require audit rows?
- **Q5** — Should PostHog be reverse-proxied through our own domain to recover blocker-lost events? Separate issue; it changes what the PostHog half of the picture is worth.
- **Q6** — `ANALYTICS_INTERNAL_ASNS` is a coarse instrument (it would exclude any real visitor on the same ISP). Acceptable, or should internal traffic be identified another way?
- **Q7** — Does a cron-written `metrics_daily` (§7.1) or `job_runs` (§7.2) row require an `audit_log` row in the same `db.batch([...])`? §26.1 of the Stage 1 spec says *every* state-changing write, and §9.3 above repeats it — so read literally, daily bookkeeping inserts emit audit rows forever for records no user initiated. If the answer is "no", the carve-out for cron-internal bookkeeping belongs in `STAGE_1_SPEC.md` §26.1 itself; a carve-out documented only here is a spec contradiction. The §7.4 pruning cron is the sharper case: deletion is the write most deserving of an audit row regardless of how the general question lands. *(Raised 2026-08-12 while breaking this document into AECI-572.)*

---

## 14. Appendix

### 14.1 Digest inventory

`lib/analytics-digest.ts` (05:00 UTC): traffic (human page views + day-over-day delta) · top 5 products by human views · traffic sources by `referrer_source` · new and total sign-ins · reviews awaiting moderation · bot/crawler views grouped by `bot_name` · footnotes on classification and referrer bias.

`lib/data-quality.ts` (04:00 UTC), ten checks: `products_without_vendor` · `ready_products_unpromoted` · `broken_integration_refs` · `vendors_without_products` · `reviews_missing_anonymized_at` · `stale_stats_cache` · `duplicate_vendors` · `duplicate_products` · `logo_404` · `algolia_index_drift`.

Eight crons total: 04:00 data quality · 05:00 analytics digest · 06:00 moderation snapshot · 07:00 home stats · 08:00 Algolia sync · 09:00 index drift · `*/15` request→Linear reconciliation · hourly WAF poll.

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
- `ANALYTICS_BASELINE.md` — "write-only today (no reporting endpoint); query D1 directly" becomes false the moment §10 P1.1 lands.
- `data-quality.ts` check #2's inline note that there is no `promoted_at` column remains accurate and is the basis of Q2.
