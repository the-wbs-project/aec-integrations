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
| 11 scheduled crons (health/liveness) | ✅ live | per-cron heartbeat + no-data monitors (**absence**); `job_runs` + `/admin/system` (**the record**). The eleventh (`asn-registry`, AECI-624) is **weekly**, so a no-data monitor on it needs a ≥2-week window |
| Moderation queue depth / age | ✅ live | `aeci.moderation.queue_*`, `/api/admin/*` |
| Request → Linear pipeline | ✅ live | `aeci.linear.*`, `aeci.webhooks.linear.*` |
| Authoritative signups | ✅ live | `mailing_list` D1 + `aeci.email.send{template:landing-signup}`; `/admin/audience` |
| Server pageviews / entry pages | ✅ live | `page_views` D1 via the admin panel's read endpoints (`API_CONTRACTS.md` §6.10) |
| Whether a "human" page view really is one | ⚠️ **partial, and now says so out loud** | `is_bot` is a hand-maintained ASN list written once at ingest. Since AECI-624 the panel annotates each row with what the network is *registered as* (`ADMIN_PANEL_SPEC.md` §7.6) without altering `is_bot` — but PeeringDB has no usable signal for ~25% of our traffic. Since **AECI-683** the digest and `/admin/overview` print a **corroborated floor** (named external referrer) beside the upper and lower bounds, and report what the operator-pair retro-join removed. On the one day decomposed so far, the honest figure was **8 views / 7 visitors against a headline of 102** — so this row is closer to answered than it has ever been, and the answer is that the headline is roughly an order of magnitude high |
| Algolia query latency / error rate | ⚠️ live but low-sample | browser RUM `aeci.search.query` |
| **PostHog** pageviews + signup funnel | ✅ live | `__AECI_POSTHOG__` injected in prod HTML since 2026-08-12 |
| **RUM Core Web Vitals** (field LCP/CLS/INP) | ✅ live | `__AECI_DD__` injected in prod HTML since 2026-08-12 |

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
**Scheduled crons:** <all 10 green on `/admin/system`? any missed heartbeat / failure in Datadog>
**Request→Linear + moderation:** <pipeline failure rate; stuck; HMAC; queue depth + oldest age>
**Core Web Vitals (field):** <p75 LCP / CLS / INP per page type vs §12 — or "blocked, RUM dark">
**Traffic / signups:** <weekly visitors (PostHog); mailing_list count; top entry pages>

**Regressions / tickets filed:** <Linear issue links, or "none">
**Threshold tuning:** <any monitor threshold changed + why, or "none">
**Actions / follow-ups:** <next steps>
```

---

## Entries

## 2026-08-27 — AECI-683: decomposing one digest day, and what it cost the numbers

Scope: a **single-day forensic**, not a weekly sweep. UTC day **2026-08-26** — the first day the
AECI-658/660 instrumentation was live end to end, and therefore the first day the digest could be
checked against itself.

**What the email said:** "up to **102** human views", an Automation-signal line flagging 26, and a
PostHog floor of "**47** page views from **1 person**". Read casually, a 102/47 bracket looks like
the two bounds working.

**What the day actually was**, decomposed against prod D1 + prod PostHog:

| Bucket | Views | How it was identified |
|---|---|---|
| Operator self-traffic that leaked | ~26 | UA hash `d37ac4d2…` on AS23700 was `is_operator=1` at 02:48–04:42 and again from 07:33; the 05:46–07:32 burst (**22 views**, ending on `/auth/login`) was unflagged because the admin session had lapsed. Four more AS23700 one-offs on other hashes. |
| Flagged swarm (reported correctly) | 26 | 5 UA hashes at ≥4 views, ASN-ratio ≥0.8. |
| Automation under the thresholds | ~35–40 | AS47544 (PL) took 5 product pages under 4 UA hashes; two more hashes at 3 views with ASN-ratio 1.0; ~13 one-hit `/` knocks from singleton hashes across 8 countries. |
| **Plausible real visitors** | **8 views / 7 visitors** | Every one a US-residential arrival with a named external referrer (Google → leap-crm, clearsync-ap, raken ×2, /vendors/illoca, jobtread; Bing → 2 integration pages). |

**The finding that matters most: the PostHog floor was the operator.** Person `174286d5…`, South
Tangerang ID, active 02:44–23:25 — matching the `is_operator` windows in D1 exactly. The client
tracker has no operator suppression, so on a low-traffic day the "lower bound" measures the operator
and not a visitor. **A bracket whose ends are both the same person is not a bracket.**

**Threshold tuning:** three new constants, all documented in `POST_LAUNCH_MONITORING.md` §3b —
`ASN_ROTATOR_MIN_VIEWS` 4, `ASN_ROTATOR_MIN_UA_RATIO` 0.8, `OPERATOR_PAIR_LOOKBACK_DAYS` 30. The UA
ratio is **validated at exactly 0.8**: the AS47544 shape is 4 hashes over 5 views = 0.80, so 0.85
would have missed the very case it was built for. No existing threshold changed.

**Measured effect on the numbers.** The retro-join removes **22** of the day's 102 (102 → 80). It
deliberately does not reach the other four leaked views — they sit on UA hashes that never carried
an `is_operator = 1` row, so no pair proves them, and reaching them would mean widening to the ASN,
the rule measured wrong in both directions in 2026-08-19's entry. Across the 30 days to 2026-08-27
the ASN-rotator detector fires **once** (AS47544) and flags no other network.

**The caveat on that clean false-positive record, stated because it is easy to over-read.**
`client_verdict` did not exist before 2026-08-26 — 0 of 1,026 rows carry one on 08-25, 877 of 918 on
08-26 — and the detector's hard gate treats a NULL verdict as *no evidence*. So the 30-day sweep is
**two days of evidence**. Re-run it after a month of verdict coverage before calling the thresholds
settled.

**Traffic / signups:** the honest read for 2026-08-26 is **8 corroborated views from 7 visitors**,
against a headline of 102. Every prior day in this log that quotes a digest "human" figure is high
by the operator-leak component, which recurs whenever the session cookie expires mid-browse. The
2026-08-13 entry's ~2,100-page-view baseline for the site's first seven weeks is *further* an
over-count for the same reason, by an amount nobody has measured.

**Actions / follow-ups:** `metrics_daily` rows written before today keep the old definition and
`/api/admin/metrics/timeseries` serves snapshot-first, so a chart steps at the boundary until
`ops:backfill-metrics-daily` is re-run — filed, not done. Two more spun out and deferred: reporting
singleton `/`-only Direct hits as "door-knocks", and fixing the lapse at its source (the SSR
passthrough forwards an expired access token rather than refreshing it, so this change corrects the
rows on read but does not stop them being written).

---

## 2026-08-14 — Phase 8.3 admin-panel epic (AECI-572) closeout

Scope: the **instrumentation snapshot at the close of the admin-panel epic**, not a weekly traffic
sweep. This entry exists because the epic changes what is observable at all — three of the ten rows
in the matrix above moved, and two of them had been `❌ dark` since this log's first entry
(2026-07-11). Written at AECI-587 (the §12 docs closeout), against `admin-panel` **before** its
squash merge to `main`.

**Prod SHA / deploy:** `c461a883…` · `2026-08-13T07:53:37Z` (`/api/version` = `/_version`, no stale
SSR). That is a **`main`** commit — AECI-571's `promote_jobs` ledger. **None of the epic's 15
commits is deployed anywhere**: per §13 D1 the epic integrates on `admin-panel` and reaches `main`
as one squash merge, so staging never exercised the panel and per-PR preview Workers were the
verification surface. Read every "now live" below as *true in the repo, not yet true in production*.

**Analytics injection (§0 gate):** `curl -s https://www.aecintegrations.com/ | grep -oE
'__AECI_(POSTHOG|DD)__'` returns **both** (verified 2026-08-14). This is the AECI-279 **§F1
blocker clearing** — `PHASE_8_COMPLETION.md` recorded AC3 as blocked because the secret *values*
were unset and there was zero field CWV data. They are set. The first field CWV read against the
`STAGE_1_PHASE_2_SPEC.md` §12 budgets is now possible and is the next thing this log owes.

**Errors / APM:** unchanged — the epic adds no public request path. Its eight endpoints are all
`GET`, admin-gated, read-only, and reachable only over the SSR→API service binding.
**Edge cache hit rate:** unchanged. `/admin/*` is deliberately absent from `ROUTE_CACHE_PATTERNS`
(`CACHE_STRATEGY.md` §4) and every panel response is `private, no-store`.
**Algolia:** unchanged; the panel reads the sync watermark and drift result rather than writing.

**Scheduled crons: 7 → 10.** The 00:15 UTC `metrics-snapshot` (AECI-581) and the 03:00 UTC
`retention-prune` (AECI-584) join the eight already running. More consequential than the count:
since AECI-583 every cron writes a `job_runs` row on entry and completes it on exit, so **a cron's
outcome is now a record rather than only a metric**. The split that matters operationally — *the
panel owns the record, Datadog owns absence*. A cron that never starts writes no `job_runs` row
either, so only a no-data monitor can catch it.

**Known gap:** `metrics-snapshot` has **no dedicated Datadog monitor**. It is queue-less, so a
failed run is not retried, and the *stock* metrics of a missed day are unrecoverable — the one cron
where absence is permanently lossy is the one without an absence monitor. Runbook added at
`RUNBOOKS.md` → "Metrics snapshot missing or incomplete"; the monitor is a punt
(`PHASE_8_COMPLETION.md` §F5).

**`page_views` has a read surface.** This log previously described it as "write-only; query
directly" — the matrix row above is corrected. The consent-independent read path is the panel's
endpoints behind `requireAdmin()` (`ADMIN_PANEL_SPEC.md` §6, `API_CONTRACTS.md` §6.10). Two honesty
properties carried over from the epic and worth restating here, because they bound every number
this log will quote from the panel:

- **The human count is an upper bound.** `is_bot = 0` means "not known to be a bot".
  `ANALYTICS_INTERNAL_ASNS` is built but **ships unset on every tier** (§13 D10 constraint 3), so
  no internal-traffic figure is available and every number is unfiltered.
- **Pre-2026-08-12 counts read lower than the emails sent at the time**, silently — AECI-575's
  `/admin` + `/account` exclusion filters on read as well as write (§13 D12).

**Retention is now enforced** (§7.4 / AECI-584): `page_views` 400 days, `job_runs` 90,
`metrics_daily` indefinite. Nothing is deleted yet — the first run that removes anything is
`job_runs` around **2026-11-11**, and `page_views` not until **~2027-07**. The prune refuses its
whole run if any day inside the cut window lacks a `metrics_daily` row, which is why the snapshot
gap above is a retention concern and not only an analytics one.

**Traffic / signups:** not re-read here; the authoritative correction is the 2026-08-13 entry below
(~2,100 real human page views across the site's first seven weeks). `mailing_list` and `feedback`
were both **0 rows** at the 2026-08-12 census and now have a screen (`/admin/audience`) rather than
an operator email as their only record.

**Regressions / tickets filed:** none from this closeout. Three issues spun out of the decision gate
remain **consciously open**, none blocking: [AECI-590](https://linear.app/aec-integrations/issue/AECI-590)
(reverse-proxy PostHog, Low) · [AECI-591](https://linear.app/aec-integrations/issue/AECI-591) (the
`*/15` reconcile sweep's real §26.1 violation, Medium) · [AECI-592](https://linear.app/aec-integrations/issue/AECI-592)
(data-quality check #2 is unreachable, Medium).

**Threshold tuning:** none.

**Actions / follow-ups:**
1. **First field CWV read** — §F1's remaining half, now unblocked. Datadog RUM → Optimize Vitals,
   `aeci` app, `env:production`, p75 LCP/CLS/INP vs `STAGE_1_PHASE_2_SPEC.md` §12. Closes AC3.
2. **Add a `metrics-snapshot` no-data monitor** (§F5).
3. **At the `admin-panel → main` merge**, discharge `ADMIN_PANEL_SPEC.md` §12a
   ([AECI-596](https://linear.app/aec-integrations/issue/AECI-596)) — the placeholder dates in
   `ANALYTICS_BASELINE.md`, the migration-deploy note in §7.3, migrations `0010`–`0014` per tier,
   and retiring the branch. **Re-read this entry's "now live" claims after that merge**: they are
   true in the repo and become true in production only then.

## 2026-08-13 — AECI-582 page-view bot backfill (historical rewrite)

Scope: a **one-time reclassification of `page_views.is_bot`**, run on all four tiers, not a weekly
monitoring sweep. This entry exists because the run **rewrites the past**: every "human page views"
number this log, the 05:00 digest, and the admin panel reported for June and July was wrong, and is
now different. Anyone asking later why July traffic collapsed should land here.

**Prod SHA / deploy:** unchanged; this is a data operation, no deploy.
**Ran via:** `scripts/ops/2026-08-page-view-bot-backfill/run.sh --env production --apply --allow-production`
(dry-run → `page_views` export + Time Travel bookmark → apply → verify).

**The defect.** Rows captured before the traffic classifier shipped carry `is_bot IS NULL`, and every
read predicate in the app is the NULL-safe `is_bot IS NOT 1` (`HUMAN`, `analytics-digest.ts`). An
unclassified row therefore *counted as a human*. **17,784 of 26,671 prod rows were unclassified.**

**Before → after (production, whole table):**

| Month | Rows | Unclassified before | Read as human before | Human after | Bot after |
|---|---|---|---|---|---|
| 2026-06 | 750 | 750 (100%) | 750 | **45** | 705 |
| 2026-07 | 15,748 | 15,748 (100%) | 15,748 | **1,144** | 14,604 |
| 2026-08 | 10,173 | 1,286 (13%) | 1,824 | **907** | 9,266 |
| **Total** | **26,671** | **17,784** | **18,322** | **2,096** | **24,575** |

In the digest population (excluding `/admin` + `/account`) the headline is **18,318 → 2,095 human
page views. About 89% of all traffic ever recorded as human was bots.** June and July were ~94% and
~93% bot respectively. The real human baseline for the site's first seven weeks is roughly **2,100
page views**, not eighteen thousand.

**How the 17,784 resolved:** 4,941 by User-Agent hash to a true crawler name · 441 to one identified
crawler cohort · 10,844 by datacenter ASN · 1,558 swept to human.

**Recovering real crawler names (the part that was thought impossible).** The raw UA is discarded at
capture, so the standing assumption was that old rows can only be classified by ASN. But
`classifyTraffic()` tests the UA *before* the ASN, so any row the live classifier named from its UA
was decided by the UA alone — and the SHA-256 UA hash *does* persist. Joining old rows to that hash
transfers the verdict exactly, whatever ASN they came from. That recovered **4,941 rows** with real
names (`Bingbot` 2,519, `Applebot` 885, `OpenAI` 275, `Googlebot` 123, …) that the ASN rule would
have stamped with a hosting-provider label, and it reached rows on ASNs the ASN rule deliberately
does not list. Top crawlers now: Bingbot 3,401 · Other bot 3,244 · Datacenter (Tencent) 2,262 ·
Datacenter (AWS) 2,073 · SemrushBot 1,750 · Applebot 1,089.

**A false trail worth recording.** The 885 `Applebot` rows sit on **AS714 (Apple)**, and the obvious
fix was to add AS714 to `DATACENTER_ASNS`. That would have been a mistake: `DATACENTER_ASNS` drives
the **live** classifier too, and Apple's network carries iCloud Private Relay, so production would
have begun marking real Apple visitors as bots — the same error as the one being fixed, pointed the
other way. Same for AS9808/AS56045 (China Mobile's consumer network). **`DATACENTER_ASNS` was not
touched**; the UA-hash rule reached those rows without it.

**Bot classification is trustworthy from 2026-08-03**, measured — not the ~2026-08-05 the admin-panel
spec estimated. The first live-classified rows land on 08-03 (0 classified on 08-02, 838 on 08-03),
and every day from 08-04 on was already fully classified.

**No digest discontinuity.** Because nothing after 08-03 was unclassified, the backfill moves **zero**
rows in the digest's reported day or its prior-day comparison. The 2026-08-14 email should read the
same as it would have; the correction is entirely historical.

**Regressions / tickets filed:** none. Two adjacent defects fixed in the same PR: `home.trending_products`
counted bot views (1,121 product views in the trailing 7 days were only **74** human, so the public
card ranked products by how hard they were being scraped — it now uses the digest's `HUMAN`
predicate), and the admin Traffic page rendered two honesty notes with a blank number
(`admin-note-list.ts` read `params.count`; the API sends `rows`).

**Threshold tuning:** none, but `TRENDING_MIN_VIEWS = 3` **stops being inert** now that trending
counts humans only — 9 products clear it on human views (8, 8, 5, 4, 4, 3, 3, 3, 3), still enough to
fill the top-5, but the margin is thin and a quiet week will now fall back to recently-added.

**Actions / follow-ups:** the human count remains an **upper bound** — `ANALYTICS_INTERNAL_ASNS` is
still unset, and the ASN list is hand-maintained, so `is_bot = 0` means "not known to be a bot".
Rule C also hard-set every remaining row to `is_bot = 0`, so the "never classified" signal is gone
and a future `DATACENTER_ASNS` widening must reach those rows by ASN, not by null. Capturing
`cf_as_organization` at ingest (§7.3 / AECI-585) is the durable fix — **shipped 2026-08-13**,
though it only labels rows written from its production deploy onward and is not backfillable, so
the ASNs in this snapshot still have to be looked up by hand.

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
