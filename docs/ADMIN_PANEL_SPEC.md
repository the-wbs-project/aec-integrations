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
- `products` has **no `promoted_at`** column. §13 **D6** adds one — but not for the reason a first reading suggests, and the difference decides how it is implemented (see the correction below).
- `audit_log` *is* a genuine event stream (`product.created` 131, `integration.created` 827, `vendor.created` 94, since 2026-06-26), so **additions** are chartable. But **net totals are not**: 827 `integration.created` events against 496 live rows, because the 2026-07-25 `catalog.integrations_reset` removed rows without per-row audit; ~40 products predate the log entirely; and 5,375 `claim.created` events back 915 live claims because promote re-creates the claim spine.

> **Correction (AECI-573).** An earlier draft of this section claimed that "a row sits at `promotion_status='ready'` before going live, so `created_at` is not a go-live date." **That describes the review app's lifecycle, not AECi's D1.** In D1: `POST /api/promote` is the only INSERT path into `products` and it sets `promotion_status='promoted'` on both its insert and update branches; nothing in the repo ever writes `'ready'`, `'pending'`, `'retracted'`, or `'rejected'` to D1 (`'ready'` is an Airtable-side status that never crosses the promote boundary); and retraction is a **hard delete** (`lib/retract-product.ts`), not a status transition. So **`products.created_at` is already the first-promote timestamp, exactly** — Drizzle stamps it at insert and a re-promote never touches it. The census agrees: all 171 products read `promoted`.
>
> Two consequences. **(1)** `promoted_at` (§13 D6) is adopted as *future-proofing* — it becomes load-bearing only if a Tier-1 retract endpoint ever introduces a genuine un-promote → re-promote cycle — and its backfill is therefore **exact** (`promoted_at := created_at` for every row), not a reconstruction. **(2)** Because promote re-asserts `'promoted'` on the update branch too, and `product.updated` (358) outnumbers `product.created` (131) ~2.7:1, a naive `promotedAt: now` in that `.set()` would mean *last* promoted and buy nothing over `updated_at`. Set-once is mandatory — `COALESCE("promoted_at", ?)` inside the same batch.

**Conclusion:** for the **products** series, `products.created_at` (and, once D6 lands, `promoted_at`) gives an exact answer for every currently-live row. For **integrations, vendors, claims, traffic, subscribers, and queue depths** — where there is no equivalent stamp and rows can vanish without per-row audit — a **daily snapshot table is still the only honest way to get counts-over-time** (§7.1), with an approximate historical series backfilled from `audit_log` and labelled as approximate in the UI.

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

The analytics digest as a live page. Stat tiles with sparklines — human page views, unique visitors, new sign-ins, active subscribers, catalog totals — each with a day-over-day and 7-day delta matching the email's `deltaText` semantics. Below: a 30-day traffic chart (human vs bot), top traffic sources, top viewed products, and a status strip (prod SHA · stats freshness · failing DQ checks · Algolia drift · moderation depth). A **"recompute today's digest"** action so the operator is not waiting for 05:00 UTC — implemented as `GET /api/admin/overview?recompute=1`, which re-runs the digest's metric collection (already a pure read) and returns it. It does **not** send the email and writes nothing; §13 **D8** draws that line.

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

Filters: date range · traffic type (humans / bots / all, default humans) · source · country · path contains · **"filter out internal traffic"**, mirroring PostHog's toggle, backed by an `ANALYTICS_INTERNAL_ASNS` var. That last one is not cosmetic: on 2026-08-10, **67 of 92 "human" views came from the operator's own ISP** (AS23700, Jakarta). It is bound by the three constraints in §13 **D10** — query-time only (it never touches `is_bot` and never runs at ingest), both numbers always shown, and the var ships unset.

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
- **The ten data-quality checks** rendered with severity and sample rows — today visible only in an email. Available **on demand** via `GET /api/admin/system?recompute=1`: `runDataQualityJob` is already a pure read, so re-running it writes nothing and needs no `audit_log` row (§13 **D8**). Once §7.2 lands, the default view reads the last persisted `job_runs` result and the recompute is the refresh.
- Algolia sync watermark, index drift, orphan-sweep results.
- D1 size and per-table row counts.
- Link-outs to the Datadog dashboards and PostHog.

Effectively the daily procedure in `POST_LAUNCH_MONITORING.md` turned into one screen.

---

## 6. API surface

All endpoints are `GET`, admin-gated, read-only. They register on the existing `authAdmin` sub-router in `apps/api/src/index.ts` behind `requireAdmin()`, which stays the single enforcement point (`AUTH_AND_RLS.md`). Contracts live in `packages/shared/src/api/admin-panel.ts` and reuse `PageQuerySchema` (`page` / `perPage`, capped at 100) and `paginatedResponseSchema` so list shapes match `/api/admin/requests`.

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET /api/admin/overview` | The §5.1 bundle | One round trip; mirrors `collectAnalyticsMetrics`. `?recompute=1` re-runs the collection live (pure read; sends no email) |
| `GET /api/admin/page-views` | §5.2 feed | Paginated + filtered; entity-hydrated `LinkRef` |
| `GET /api/admin/metrics/timeseries` | `?metric=&from=&to=&interval=day` | Serves `metrics_daily` (§7.1); falls back to live aggregation pre-snapshot |
| `GET /api/admin/traffic/breakdown` | `?dimension=source\|country\|path\|product\|bot` | Grouped counts over a window |
| `GET /api/admin/catalog/coverage` | §5.5 gap lists + funnel | Capped sample rows, exact counts |
| `GET /api/admin/audience` | §5.4 aggregates | Subscribers, churn, UTM, geo |
| `GET /api/admin/feedback` | Paginated feedback list | First read surface for the table |
| `GET /api/admin/system` | §5.6 bundle | Version, cron runs, latest DQ, Algolia, table counts. `?recompute=1` re-runs the ten DQ checks live (pure read) |

**Conventions.** No `audit_log` rows (reads only — §26.1 governs writes). No `Cache-Tag`, no edge caching; `/admin/*` is absent from `ROUTE_CACHE_PATTERNS` in `server-runtime.ts` and therefore takes the non-cacheable branch with `private, no-store`. That must stay true (§9.2). Response validation in dev via `validateResponseInDev`, as with the other admin routes.

**Manual job triggers — the line is side effects, not manual-ness (§13 D8).** *Recomputation* is in scope and is a `GET`: both `runDataQualityJob` and the digest's metric collection are already pure reads, so `?recompute=1` on the two endpoints above writes nothing, sends nothing, and carries no `audit_log` obligation. *Running a job for real* — sending the digest, `algolia-sync`, the retention prune, the reconcile sweep, anything that writes, emails, purges, or calls an external API — stays **deferred**, and `POST /api/admin/jobs/:job/run` is not built. Owner: **@chrisw**. Revisit when an operator first needs to force a job outside its window during an incident; at that point it is a state-changing write and needs its `audit_log` row in the same batch.

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

**No `audit_log` row** — this is derived bookkeeping and is exempt from the §26.1 audit-in-batch invariant under the carve-out settled in §13 **D11** / **ADR 0022**. Follow `stats_cache`'s precedent exactly (`lib/home-stats.ts`): write **per key, outside any batch**, each inside its own try/catch, so partial failure of one metric never aborts the others. Observability is Datadog plus the `job_runs` row from §7.2, not the audit log.

**Backfill:** derive the historical series from `audit_log` `*.created` events plus `page_views`, insert with a `computed_at` that marks it as reconstructed, and label the pre-snapshot segment in the UI. Do not present it as exact — §4 explains why it cannot be. **The one exception is the products series**, which is exactly recoverable from `products.created_at` (§4's correction); backfill it from that column and mark it measured, not reconstructed.

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

Each of the eight cron handlers in `scheduled.ts` writes one row. The data-quality run stores its full result set in `detail`, which is what §5.6 renders. Retention: 90 days (§7.4).

**No `audit_log` row**, for the same reason as §7.1 — cron-internal bookkeeping, exempt under §13 **D11** / **ADR 0022**. `job_runs` *is* the observability record; auditing it would be auditing the audit.

### 7.3 Backfills and ingest fixes

| Item | Why |
|---|---|
| Run `scripts/ops/backfill-page-view-bots.sql` on production | 17,784 rows currently read as human; every historical traffic chart is wrong until this runs |
| Capture taxonomy entities on page views | `resolveEntity` maps only `product`/`vendor`; category/audience/phase/trade ids are dropped, so ~600 rows cannot say *which* term was viewed |
| Store the concrete path alongside the route pattern | Detail-page rows store `/products/:slug`; product/vendor rows recover the name via FK, taxonomy rows cannot |
| Add a `navigation: 'spa' \| 'arrival'` flag to the page-view payload | `PageViewTracker` POSTs on every SPA navigation and the same-origin `Referer` classifies as `Direct`, so in-app navigation and true direct arrivals are indistinguishable — `Direct` is a mixed bucket |
| Capture `cf_as_organization` at ingest (§13 **D10**) | The ASN *number* alone cannot label itself. `mailing_list` already stores `as_organization` (`schema.ts`) from `LANDING_CF_HEADERS`, and `POST_LAUNCH_MONITORING.md` §3b already names holder-name matching as the durable fix — "not a longer list". Makes both the bot classifier's weekly audit and §5.2's internal-traffic filter self-labelling |
| **Drop** the dead columns — `user_id`, `session_id`, `profile_role` (§13 **D7**) | Settled: drop, do not fill. Per-column cost below |
| **Add `products.promoted_at`** (§13 **D6**) | Future-proofs the §4 catalog series against a future un-promote → re-promote cycle. **Set-once** — `COALESCE("promoted_at", ?)` in promote's update branch, else it degrades to "last promoted". Backfill `:= created_at` (exact — see §4's correction) |

**Dropping the dead columns is not symmetric, and the migration plan must say so** (AECI-585):

| Column | App-code references | Migration |
|---|---|---|
| `session_id` | none | plain `ALTER TABLE … DROP COLUMN` |
| `profile_role` | none | plain `ALTER TABLE … DROP COLUMN` |
| `user_id` | one — the GDPR erasure batch | **table recreate**: SQLite refuses `DROP COLUMN` on a column carrying an index or a `FOREIGN KEY` clause, and this has both (`page_views_user_idx` + the FK in `migrations/0000_init.sql`). Copies ~26k rows and is the repo's **first** table-recreate migration — every `ALTER` to date is an `ADD` |

The one code change riding along: `apps/api/src/routes/account.ts`'s `db.update(pageViews).set({ userId: null })` inside the erasure batch is a permanent no-op today and is deleted with the column. That **strengthens** the GDPR story — `page_views` can no longer hold any user linkage at all — so `AUTH_AND_RLS.md` gets a line (§12).

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
3. **Audit.** Reads emit nothing — including the `?recompute=1` reads (§6, §13 D8). For the epic's cron-written tables, §26.1 applies **as scoped by ADR 0022**, not in its former absolute form: `metrics_daily` and `job_runs` are derived bookkeeping and are exempt, while the §7.4 scheduled prune emits one summary `audit_log` row per run in the same batch as its delete. Any *domain-state* write this panel might later grow still emits its `audit_log` row in the same `db.batch([...])`.
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

**Base branch for every unit: `admin-panel`** (§13 D1). Sub-issues PR into it; one squash merge `admin-panel → main` closes the epic.

| # | Issue | Unit | Depends on |
|---|---|---|---|
| — | AECI-573 | **Decision gate**: settle §13 Q1–Q7, pick timing + base branch, promote this doc to a contract | — |
| **§9.6** | AECI-575 | Exclude `/admin/*` + `/account` from `PageViewTracker` | — |
| **P1.1** | AECI-574 | API: `overview`, `metrics/timeseries` (live-aggregation mode), `traffic/breakdown` | AECI-573 (D10) |
| **P1.2** | AECI-576 | UI: shell nav restructure (three groups, `h1` → "Admin") + Overview | P1.1, §9.6 |
| **P1.3** | AECI-577 | API + UI: `GET /api/admin/page-views` + the Activity feed | P1.1 |
| **P1.4** | AECI-578 | UI: Traffic section + the chart primitives (§8) | P1.1 |
| **P1.5** | AECI-579 | API + UI: Catalog coverage + promotion funnel | — |
| **P1.6** | AECI-580 | API + UI: System status (version, DQ on demand, Algolia, table counts) | — |
| **P2.1** | AECI-581 | `metrics_daily` + snapshot cron + backfill, **plus `products.promoted_at`** (§13 D6) | P1.4 |
| **P2.2** | AECI-582 | Run the page-view bot backfill on production | — |
| **P3.1** | AECI-583 | `job_runs` + instrument all eight crons + persist DQ results | P1.6 |
| **P3.2** | AECI-584 | Retention/pruning cron (§7.4) — **deprioritized**, see below | P3.1, **P2.1** |
| **P4.1** | AECI-585 | Page-view ingest fixes (§7.3: taxonomy entity, concrete path, SPA flag, `cf_as_organization`, drop the three dead columns) | — |
| **P5.1** | AECI-586 | Audience section (mailing list + feedback) | P1.4 |
| **§12** | AECI-587 | Docs closeout: the §12 update contract + the §14.3 stale claims | all shipping units |

**§9.6 moved ahead of P1.1** (§13 D10). `PageViewTracker` has no path predicate, so every admin SPA navigation POSTs a page view *from the operator's own ISP* — the same AS23700 that is 67 of 92 "human" views in the §14.2 census. Excluding `/admin/*` removes a large slice of internal traffic **precisely, with no false positives**, and it must land before the console is usable or the panel starts polluting the table it reads. It is also the cheaper half of the answer to internal-traffic filtering; `ANALYTICS_INTERNAL_ASNS` is the coarse remainder.

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
| `API_CONTRACTS.md` | New section for every §6 endpoint, including the `?recompute=1` semantics (§13 D8) |
| `DATABASE_SCHEMA.md` | `metrics_daily`, `job_runs`, `products.promoted_at`, `page_views.cf_as_organization`, the three dropped `page_views` columns, any new index. **Also correct the "Audit log and page_views retention: indefinite for Stage 1" line** — false once §7.4 lands |
| `STAGE_1_SPEC.md` §22 | Pointer to this document as the admin-surface source of truth. **Cite-check first** — `PHASE_8_COMPLETION.md` records two stale spec-cites in that file |
| `STAGE_1_SPEC.md` §26.1, §26.6 | The audit carve-out (§13 D11) and the retention scope cross-reference (§7.4). **Landed with AECI-573, not at closeout** |
| `adr/0022-cron-bookkeeping-exempt-from-audit-invariant.md` + `adr/README.md` | The ADR behind the §26.1 carve-out, plus its index row. **Landed with AECI-573** |
| `CODE_REVIEW_EXEMPTIONS.md` | The carve-out as a standing, non-expiring exemption pointing at ADR 0022 — so a reviewer meeting an unaudited cron write finds the reasoning. **Landed with AECI-573** |
| `CICD_PLAN.md` §10 | The `admin-panel` epic integration branch as a second time-boxed exception under ADR 0019's precedent (§13 D1). **Landed with AECI-573** |
| `AUTH_AND_RLS.md` | The new `/api/admin/*` endpoints under `requireAdmin()`, and the GDPR-erasure simplification once `page_views.user_id` is dropped (§7.3) |
| `ANALYTICS_BASELINE.md` | Drop "write-only today (no reporting endpoint)"; record the panel as the consent-independent read path; record that no session identifier was introduced (§13 D7) and why |
| `POST_LAUNCH_MONITORING.md` | Replace §1 rows 6 and 8 (cron liveness, moderation queue) with the panel, and the **weekly** §2 item 4 → §3b manual `wrangler d1 execute` ASN audit with §5.3's geography view. *(The manual D1 query is in the weekly procedure, not the daily — an earlier draft of this row said "daily".)* |
| `POST_LAUNCH_HEALTH_REPORT.md` | New dated entry (see §14.3) |
| `OBSERVABILITY.md` | Any new metric emitted by the snapshot / retention crons |
| `RUNBOOKS.md` | Runbook entries for the snapshot and retention crons, matching every other cron's |
| `TESTING_STRATEGY.md` | The §11 approach — chart-geometry pure-function tests are a new category for this repo |
| `CACHE_STRATEGY.md` | Record `/admin/*` as deliberately uncacheable (`private, no-store`, absent from `ROUTE_CACHE_PATTERNS`) so §9.2 is enforced from the caching doc too |
| `environments.md`, `access.md` | `ANALYTICS_INTERNAL_ASNS` per tier (§13 D10) — declared, shipped unset |
| `migrations.md` | Usually no change; confirm consciously, since this epic adds the repo's first table-recreate migration (§7.3) |
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

  It is also the *coarse remainder*, not the main instrument. Two more precise measures do most of the work: **AECI-575 moves ahead of P1.1** (excluding `/admin/*` from the tracker removes operator traffic with zero false positives), and **`cf_as_organization` is captured at ingest** (§7.3) — the fix `POST_LAUNCH_MONITORING.md` §3b already names: *"not a longer list — it is capturing Cloudflare's `asOrganization` … and matching on the holder name."*

- **D11 — No `audit_log` row for cron-internal bookkeeping; scheduled deletes are the exception** (was Q7; §7.1, §7.2, §7.4, §9.3). Recorded as **ADR 0022**, with the carve-out written into `STAGE_1_SPEC.md` §26.1 itself — Q7 was right that a carve-out documented only here would be a spec contradiction waiting to be found in review.

  The decisive finding is that **the carve-out already existed, in the wrong file**. §26.1 says, unqualified, *"every write path … no state change happens without a corresponding audit entry"* — but `API_CONTRACTS.md` §6.9 already narrowed it to state-changing **domain** writes in order to exempt `page_views`, and §6.13 extends that to `mailing_list` / `feedback` including the unsubscribe soft-delete. The word "domain" appeared nowhere in §26.1, `DATABASE_SCHEMA.md` §18, or `CLAUDE.md`. Two further facts made "no" the only coherent answer: **every** D1-writing cron today writes without an audit row (`stats_cache` from the 07:00 job, the Algolia watermark, the `*/15` reconcile sweep), and answering "yes" would force `metrics_daily` into a batch, destroying the per-key partial-failure isolation `lib/home-stats.ts` explicitly specifies and which §7.1 mirrors by design. Nothing schema-side blocked "yes" — `actor_type` already permits `'system'` and promote uses it ~10× — which is precisely why the rule had to be written down rather than left to reviewer taste.

  **Scheduled deletion is carved back in**: any scheduled `DELETE` emits exactly one *summary* row per run (`action='retention.pruned'`, `metadata={table, cutoff, rowsDeleted}`), in the same batch as the delete. Deletion is the one write whose fact cannot be recovered from the data afterwards.

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
- `data-quality.ts` check #2's inline note that there is no `promoted_at` column is accurate, but **understates the problem**: the check filters `promotion_status='ready'`, and nothing in the repo ever writes `'ready'` to D1, so it can only ever return zero rows. It is unreachable, not proxied (§13 D6). **AECI-592.**

Found while settling §13 (AECI-573):

- `DATABASE_SCHEMA.md` — *"Audit log and page_views retention: indefinite for Stage 1"* becomes false for `page_views` the moment §7.4 lands. The `audit_log` half stays true (`STAGE_1_SPEC.md` §26.6).
- `STAGE_1_SPEC.md` §26.1 and §26.6 — both still describe the **Supabase** era: §26.1 said writes call `appendAuditLog(...)` "as part of its transaction", and §26.6 says "indefinite retention in Supabase". The D1 reality (ADR 0016) is `auditInsert()` inside `db.batch([...])`. §26.1 was corrected by AECI-573 as part of the D11 carve-out; §26.6's wording was corrected alongside it.
- This document's own §12 row for `POST_LAUNCH_MONITORING.md` said the panel replaces manual D1 queries in *the daily procedure*. The manual `wrangler d1 execute` ASN audit is in the **weekly** procedure (§2 item 4 → §3b); the daily procedure is Datadog dashboards. Corrected in §12.
- This document's §4 claimed `created_at` is not a go-live date because rows sit at `promotion_status='ready'` first. That is the review app's lifecycle, not D1's. Corrected in §4 and §13 D6.
