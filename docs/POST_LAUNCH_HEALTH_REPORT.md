# Post-launch Health Report

**Version:** 1.0 · **Date:** 2026-07-11 · **Owner:** Chris · **Issue:** AECI-279 (Phase 8.1)

The dated **health-report log** for the first weeks of production traffic — the AECI-279 AC "capture a
first week / first month health report." Each entry is a point-in-time snapshot produced by running the
[`POST_LAUNCH_MONITORING.md`](./POST_LAUNCH_MONITORING.md) daily + weekly checks. Companion to
[`ANALYTICS_BASELINE.md`](./ANALYTICS_BASELINE.md) (the pre-marketing baseline / numbers procedure) and
[`OBSERVABILITY.md`](./OBSERVABILITY.md) (the metric catalog).

Like the analytics baseline, the early entries are **about instrumentation, not numbers** — AECi is
pre-marketing and (as of the first entry) client analytics is still dark, so traffic and field CWV read
nil-to-negligible. The value is a known zero to accrue against.

**Cadence:** append an entry weekly through the first month, then at the one-month mark. Newest entry first.

---

## Observable-vs-blocked matrix (as of the latest entry)

| Signal | Status | Source |
|---|---|---|
| Worker error rate / APM | ✅ live | `aeci.api.query.duration_ms`, SSR error logs |
| Edge cache hit rate + render latency | ✅ live | `aeci.page.render.duration_ms{cache_status}` |
| 7 scheduled crons (health/liveness) | ✅ live | per-cron heartbeat + no-data monitors |
| Moderation queue depth / age | ✅ live | `aeci.moderation.queue_*`, `/api/admin/*` |
| Request → Linear pipeline | ✅ live | `aeci.linear.*`, `aeci.webhooks.linear.*` |
| Authoritative signups | ✅ live | `mailing_list` D1 + `aeci.email.send{template:landing-signup}` |
| Server pageviews / entry pages | ✅ live | `page_views` D1 (write-only; query directly) |
| Algolia query latency / error rate | ⚠️ live but low-sample | browser RUM `aeci.search.query` |
| **PostHog** pageviews + signup funnel | ❌ **dark** | gated on `POSTHOG_KEY` value |
| **RUM Core Web Vitals** (field LCP/CLS/INP) | ❌ **dark** | gated on `DD_APPLICATION_ID` + `DD_CLIENT_TOKEN` values |

---

## Entry template (copy for each new snapshot)

```markdown
## <YYYY-MM-DD> — <week N / first month>

**Prod SHA / deploy:** <sha> · <deployedAt>
**Analytics injection (§0 gate):** <output of `curl … | grep __AECI_(POSTHOG|DD)__`>

**Errors / APM:** <5xx rate; any spikes>
**Edge cache hit rate:** <%; per route_class notes>
**Render latency:** <p95 detail MISS>
**Algolia:** <query p95 + error rate; sync outcome; drift>
**Scheduled crons:** <all 7 green? any missed heartbeat / failure>
**Request→Linear + moderation:** <pipeline failure rate; stuck; HMAC; queue depth + oldest age>
**Core Web Vitals (field):** <p75 LCP / CLS / INP per page type vs §12 — or "blocked, RUM dark">
**Traffic / signups:** <weekly visitors (PostHog); mailing_list count; top entry pages>

**Regressions / tickets filed:** <Linear issue links, or "none">
**Threshold tuning:** <any monitor threshold changed + why, or "none">
**Actions / follow-ups:** <next steps>
```

---

## Entries

## 2026-07-12 — AECI-280 trending data pull (week 1, stats-pipeline slice)

Scope: a **targeted read of the `stats_cache` + `page_views` pipeline** for AECI-280 (Phase 8.2 — tune
the home trending card on real traffic), not a full weekly monitoring sweep. Read-only prod-D1 SELECTs
(`wrangler d1 execute aeci-app-production --env production --remote`).

**Prod SHA / deploy:** unchanged from the launch cutover (`8348297…`, 2026-07-05); measurement only.

**Traffic / signups (server `page_views`, consent-independent):**
- **4,917** total rows since 2026-06-23; **3,237** in the last 7 days; **646** product-page views in 7d.
- **124** distinct products viewed in 7d — essentially the whole catalog (`total_products` = 124).
- ⚠️ **`cf_bot_score` is null on 100% of rows** — Cloudflare **Pro** provides no bot score, so
  `PAGE_VIEWS_MIN_BOT_SCORE` is inert and the volume is **unclassified** (bot / crawler / synthetic vs
  human). Treat these as *pipeline-health* numbers, not human-demand numbers; PostHog (dark) is still the
  human-traffic signal. See `ANALYTICS_BASELINE.md` (AECI-280 addendum).

**`stats_cache` freshness / values** (computed `2026-07-12T07:00:52Z` — today's `0 7 * * *` cron, fresh):
- `total_integrations` **385** · `integrations_added_30d` **296** · `total_products` **124**
- `most_integrated_product` **Procore Project Management** · `most_active_category` **Construction Management**
- `trending_products` populated (top: **ServiceTitan**, 17 views) · `recently_added_products` populated.
  Pipeline healthy end-to-end (cron → `stats_cache` → `/api/stats/home`).

**Trending validation (AECI-280 AC):**
- 7-day per-product distribution: top-5 = **17 / 17 / 17 / 12 / 12** views (clear, well-separated).
- ≥2 views: 115 of 124 products · ≥3: 92 · ≥5: 66 · exactly 1 view: only 9.
- **Window (7d) and top-N (5) are validated — left unchanged.** Added a `TRENDING_MIN_VIEWS = 3`
  honesty floor (the only bot guard, given no CF bot score). **Inert at current traffic** (top-5 clear it
  4–5×); it exists to keep "trending" honest in low-traffic windows / after a page-views regression, where
  trending falls back to recently-added.

**Regressions / tickets filed:** none. Follow-up proposed (not filed): ~30d re-evaluation of window/top-N +
PostHog-join weighting + card-resonance review.

**Threshold tuning:** documented the three trending constants as launch tunables in
`POST_LAUNCH_MONITORING.md` §3 (new "Home stats-card content tunables" table).

**Actions / follow-ups:** set `POSTHOG_KEY_PRODUCTION` (still the blocker for human analytics **and** the
deferred trending PostHog join); re-read this pull at the ~30-day mark.

## 2026-07-11 — pre-launch baseline (week 0)

**Prod SHA / deploy:** `8348297d1b549393bd8f75d85974b2c23ab01003` · `2026-07-05T18:10:27Z` (the apex/www
launch cutover; `/api/version` and `/_version` agree — no stale SSR).

**Analytics injection (§0 gate):** `curl -s https://www.aecintegrations.com/ | grep -oE '__AECI_(POSTHOG|DD)__'`
returned **nothing** — the served HTML injects only `__AECI_ALGOLIA__` + `__AECI_SUPABASE__`. **PostHog and
Datadog RUM are dark in production** (secret *values* unset; AECI-326 wired the CI push but not the values).

**Errors / APM:** no reading captured in this structural entry — server metrics are live but pre-marketing
volume is negligible, so rates are dominated by synthetic/monitoring traffic. Baseline to be read weekly.

**Edge cache hit rate / render latency:** live; not meaningfully sampled yet. Note the home `/` responds
`cache-control: private, no-store`, so cache-hit rate reflects the cacheable route classes
(detail / browse / taxonomy / static), not the home.

**Algolia:** search UI live; `aeci.search.query` RUM emitting on a thin sample. Daily sync + drift crons
healthy by design.

**Scheduled crons:** all 7 defined on staging/demo/prod (`apps/api/wrangler.jsonc`); liveness is now fully
covered after AECI-279 added the WAF-poll no-data monitor. Confirm each heartbeat weekly.

**Request→Linear + moderation:** pipeline live; queue effectively empty pre-launch. `GET /api/admin/summary`
`pending_reviews` and the moderation-queue gauges are the daily read.

**Core Web Vitals (field):** ❌ **Blocked** — no field data (RUM dark). **Not read this pass** (per AECI-279
scope decision). Interim lab reference only: [`PERFORMANCE_AUDIT.md`](./PERFORMANCE_AUDIT.md) (AECI-245) —
lab perf 0.79–0.89, LCP ~3.5–3.9s under throttle, **CLS 0.145–0.326 on detail/browse/taxonomy**, detail JS
~227 KB; its thin field snapshot (p75 LCP 0.25–0.49s, CLS ~0.023, INP 32–40ms) was **not** prod. The
CWV/perf budgets are warn-only in CI and the fixes are owned by **AECI-221**; AECI-279 will validate them
against real field data once RUM is un-darkened.

**Traffic / signups:** pre-launch / pre-marketing. Weekly visitors nil-to-negligible; home `/` is the sole
broadly-shared entry point; authoritative signup count (`mailing_list` D1) ≈ 1 (per `ANALYTICS_BASELINE.md`).

**Regressions / tickets filed:** none.

**Threshold tuning:** none — the split of the data-quality monitor into error (paging) + warn
(non-paging) and the new WAF-poll liveness monitor shipped in AECI-279; all other thresholds remain their
launch placeholders (`POST_LAUNCH_MONITORING.md` §3), to be tuned once real traffic sets a baseline.

**Actions / follow-ups:** **#1 blocker — provision the analytics secrets** (`DD_APPLICATION_ID`,
`DD_CLIENT_TOKEN`, `POSTHOG_KEY` values) so PostHog + RUM start capturing; then re-read this entry ~1 week
later for the first real numbers and the first field CWV read. Apply the three AECI-279 monitor changes
(`POST_LAUNCH_MONITORING.md` §5).
