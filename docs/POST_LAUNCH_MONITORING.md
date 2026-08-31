# Post-launch Monitoring Runbook

**Version:** 1.0 · **Date:** 2026-07-11 · **Owner:** Chris · **Issue:** AECI-279 (Phase 8.1)

The repeatable **daily / weekly** procedure for watching the first weeks of real production
traffic and stabilizing. This is the *operate* companion to the three record docs:

- [`OBSERVABILITY.md`](./OBSERVABILITY.md) — the metric **catalog**, dashboards, and monitors (what each signal is).
- [`RUNBOOKS.md`](./RUNBOOKS.md) — the **incident** response guides (what to do when a monitor fires).
- [`launch-cutover-runbook.md`](./launch-cutover-runbook.md) §5 — the **post-cutover verification** signals this pass re-observes.
- [`ANALYTICS_BASELINE.md`](./ANALYTICS_BASELINE.md) — the traffic/signup/CWV **numbers** procedure (PostHog + RUM).
- [`POST_LAUNCH_HEALTH_REPORT.md`](./POST_LAUNCH_HEALTH_REPORT.md) — the dated **health-report log** this procedure feeds.

Everything below reads from the Datadog org **us5**, app tag `app:aeci`, filtered `env:production`.
The notification handle behind every monitor is `@chrisw@thewbsproject.com` (Datadog email).

---

## 0. Precondition — is analytics actually flowing?

**Check this first every morning until it passes.** Client analytics (PostHog) and field Core Web
Vitals (Datadog RUM) inject only when their Worker secrets exist. As of 2026-07-11 they are **dark**
in production (secret *values* unset — AECI-326 wired the CI push but not the values):

```bash
curl -s https://www.aecintegrations.com/ | grep -oE '__AECI_(POSTHOG|DD)__'
```

- **Nothing printed** → PostHog + RUM are **not capturing**. Skip the RUM-CWV and PostHog-funnel rows
  below; they have no data. Server-side signals (Worker metrics, `page_views` / `mailing_list` D1) are
  unaffected and still valid — and since **AECI-586** the `mailing_list` half has a screen,
  `/admin/audience`, so signup volume, churn and campaign attribution stay readable with the
  consent-gated tools dark. Un-dark by setting `DD_APPLICATION_ID`, `DD_CLIENT_TOKEN`, and
  `POSTHOG_KEY` (see [`OBSERVABILITY.md` → Credentials](./OBSERVABILITY.md#credentials)); this is an
  ops action, not code.
- **`__AECI_POSTHOG__` + `__AECI_DD__` both printed** → analytics is live; the RUM-CWV and PostHog rows
  are meaningful. Record the flip date in [`POST_LAUNCH_HEALTH_REPORT.md`](./POST_LAUNCH_HEALTH_REPORT.md).

---

## 1. Daily monitoring checklist

A ~5-minute glance across the shipped dashboards + monitors. Nothing here should require action on a
healthy day — the point is to catch a regression before a monitor's sustained-window threshold does.

| # | Signal | Where to look | Healthy | Fires as |
|---|---|---|---|---|
| 1 | **Errors / APM** | Phase 2 — Traffic dashboard (4xx/5xx widget); `aeci.api.query.duration_ms` by `endpoint`/`status_class`; SSR logs `service:aeci-web status:error` | 5xx rate < 1% | `AECi — Worker error rate high` (>1%/5m) |
| 2 | **Edge cache hit rate** | Phase 2 — Traffic (cache-hit per `route_class`); `aeci.page.render.duration_ms{cache_status}` | HIT majority on cacheable route classes (detail/browse/taxonomy/static) | `AECi — Cache hit rate low` (<70%/15m) |
| 3 | **Render latency** | Phase 2 — Traffic (p95 render per `route_class`) | p95 detail (MISS) < 1.5s | `AECi — Detail render slow` (>1.5s/10m, `cache_status:miss`) |
| 4 | **Algolia query latency / errors** | Phase 3 — Search (browser RUM `aeci.search.query`: latency p50/p95/p99, error rate) | error rate ~0; p95 within norm | *(no monitor — dashboard-only; add if noisy)* |
| 5 | **Algolia sync + drift** | Phase 3 — Search; `aeci.algolia.sync`, `aeci.algolia.index_drift`. Also **`/admin/system`** — the sync watermark (per entity + last advance), and drift on demand via "Run data-quality checks" | drift 0; daily sync `outcome:ok` | drift/sync-failed/sync-not-running/orphan-cap monitors |
| 5a | **Data quality (10 §23.1 checks)** | **`/admin/system`** — the page now opens on the **last stored 04:00 result** (AECI-583), labelled with the run's own timestamp, so the morning read needs no click and no email. "Run data-quality checks" re-runs the suite live to confirm a fix made since. Both are pure reads — nothing written, nothing sent | every check *Passing*; `algolia_index_drift` *Skipped* is normal off production (no credentials) | check-error / check-warn monitors (unchanged — the screen is a read surface, not an alerting one) |
| 6 | **Scheduled-job health (10 crons)** | **`/admin/system`** for the record — real last run, outcome and duration per job (AECI-583). **Datadog for absence** — a job that never starts leaves no row, so the no-data monitors remain the only signal for "it stopped firing" (see §1a) | every cron shows a recent recorded run, and emitted its heartbeat in window | the per-cron `… not running` / `… failed` monitors |
| 7 | **Request → Linear pipeline** | Phase 6 — Requests / Moderation; `aeci.linear.issue`/`.sync`/`.reconcile.*`, `aeci.webhooks.linear.hmac_failure` | failure rate < 50%; no persistent stuck; no HMAC burst | pipeline-failure / reconcile-stuck / reconcile-no-data / hmac monitors |
| 8 | **Moderation queue** | Phase 5 & 6 dashboards; `aeci.moderation.queue_depth` / `queue_oldest_age_hours`; `GET /api/admin/summary` (`pending_reviews`), `GET /api/admin/requests` | oldest pending < 48h (target 24h, §17) | `AECi — Moderation queue backlog` (>48h) |
| 9 | **RUM Core Web Vitals** *(gated on §0)* | Datadog **RUM → Optimize Vitals**, `aeci` app, `env:production` (p75 LCP / CLS / INP) | LCP ≤ 2.5s · CLS ≤ 0.1 · INP ≤ 200ms (`STAGE_1_PHASE_2_SPEC.md` §12) | *(no monitor — read manually; see §2)* |

> **Datadog UI gotcha:** the org has three RUM apps (`aeci`, `pm-empower`, `earned-value`) and the UI
> defaults to the wrong one — select **`aeci`** (us5). CWV live under RUM → Optimize Vitals, not the
> Phase-2 dashboard (that tracks SSR `aeci.page.render.duration_ms`, not field CWV).

### 1a. The 11 scheduled crons (row 6 detail)

Each cron emits an always-on heartbeat; the "not running" monitor's no-data is the liveness signal.
A green board here means all eleven fired on schedule (ten daily/sub-daily, plus the weekly ASN-registry refresh — see its row). Since AECI-583 each run **also** writes a
`job_runs` row that `/admin/system` renders (see the split below).

> **Read the record off `/admin/system`; read absence off Datadog.** AECI-583 landed the `job_runs`
> table, so the screen now shows each job's real last run, outcome and duration — including the
> data-quality run's full ten-check result set, which used to exist only in the 04:00 email. Start
> the daily pass there.
>
> **But Datadog stays the authority for "a job stopped firing."** A cron that never starts writes no
> `job_runs` row either, so its absence is invisible in D1 by construction — only a no-data monitor
> can catch it. The screen is still built so it cannot render a green tick it hasn't earned: a job
> with no row reads *Unknown*, a run with no finish stamp reads *In flight* (never *ok*), and the two
> jobs that leave a `stats_cache` side effect can still show an *Inferred* timestamp, which proves the
> job **ran**, not that it **succeeded**. Full reconciliation in `OBSERVABILITY.md`.

| Cron (UTC) | Job | `job_runs.job` | Liveness / failure monitors |
|---|---|---|---|
| `15 0 * * *` | `metrics_daily` snapshot of the prior complete UTC day (AECI-581 / `ADMIN_PANEL_SPEC.md` §7.1) — 19 metrics, the admin panel's long memory | `metrics-snapshot` | `aeci.metrics_snapshot.run` heartbeat (no dedicated monitor yet — **worth one**: it is queue-less, so a failed run is not retried, and the *stock* metrics of a missed day are unrecoverable. Flow metrics recover via `pnpm --filter @aeci/api ops:backfill-metrics-daily`) |
| `0 3 * * *` | §7.4 retention prune (AECI-584 / `ADMIN_PANEL_SPEC.md` §7.4) — the system's only scheduled `DELETE`: `page_views` past 400 days, `job_runs` past 90, in bounded chunks, with one `retention.pruned` audit row per run. **Deletes nothing until ~2026-11 (`job_runs`) / ~2027-07 (`page_views`)**, so for now a healthy run is a zero-row run | `retention-prune` | prune-skipped / prune-runaway / prune-failed / prune-not-running (AECI-584) |
| `0 4 * * *` | Data-quality suite (10 §23.1 checks) + email digest | `data-quality` | check-error / check-warn / failed / not-running |
| `0 5 * * *` | Operator analytics digest (AECI-526) — **human page views after automation** (AECI-741 headline) over the raw server-side count (an upper bound), plus a PostHog lower bound + an AECI-683 corroborated floor, top products, sign-ins, moderation depth, and a Crawler-activity breakdown (human/bot split classified at ingest by UA + ASN) | `analytics-digest` | `aeci.analytics_digest.email` heartbeat (no dedicated monitor yet) |
| `0 6 * * *` | Moderation queue snapshot | `moderation-snapshot` | moderation-queue-age (threshold + no-data) |
| `0 7 * * *` | Home-stats compute | `home-stats` | stats-compute-failed / stats-not-running |
| `0 8 * * *` | Algolia incremental sync | `algolia-sync` | sync-failed / sync-not-running |
| `0 2 * * 2` | **WEEKLY** (Mondays — Cloudflare's day-of-week is 1=Sunday, so Monday is `2`; this read `0 2 * * 1` and therefore fired on SUNDAY until AECI-661) — `asn_registry` refresh from PeeringDB (AECI-624 / `ADMIN_PANEL_SPEC.md` §7.6): the read-time network annotation behind the Activity feed | `asn-registry` | `aeci.asn_registry.refresh` heartbeat + `aeci.asn_registry.coverage` gauge. **A no-data monitor here needs a ≥2-week window** or it alerts every Tuesday. A `failed` run is not urgent — nothing is ever deleted, so the panel keeps annotating from the last good rows and `/admin/system` marks the registry stale after two missed Mondays. Watch **coverage**, not freshness: it decays silently as new networks arrive and freshness cannot see that |
| `0 9 * * *` | Algolia drift + orphan sweep | `algolia-drift` | index-drift / orphan-sweep-capped |
| `*/15 * * * *` | Request→Linear reconciliation sweep | `request-reconcile` | reconcile-stuck / reconcile-no-data |
| `0 * * * *` | WAF firewall-event poll | `waf-poll` | waf-ratelimit-spike / **waf-poll-not-running** (AECI-279) |

---

## 2. Weekly checklist

1. **Re-verify the launch-cutover §5 signals** ([`launch-cutover-runbook.md`](./launch-cutover-runbook.md)):
   dual `/api/version` + `/_version` SHA match; `www.` canonical + apex→www 301; indexable headers +
   sitemap/robots; IndexNow firing; a test transactional email; the welcome banner on a `?ref=waitlist`
   link. *(The SHA-match half is now also on **`/admin/system`** — AECI-580 renders both Workers'
   builds side by side and flags a mismatch, so the two `curl`s are a cross-check rather than the
   only way to see it.)*
2. **Review the launch-tunable thresholds** (§3) against the week's data — tighten any that missed a real
   issue, relax any that proved noisy. **Only the enforcement/threshold changes** — never relax a budget
   to make a signal pass (`TESTING_STRATEGY.md` §10.4).
3. **Core Web Vitals read** *(once §0 passes)*: Datadog RUM → Optimize Vitals for the `aeci` app,
   `env:production`, p75 LCP / CLS / INP per page type, against the §12 budgets. The pre-launch lab audit
   ([`PERFORMANCE_AUDIT.md`](./PERFORMANCE_AUDIT.md)) flagged **CLS on detail/browse/taxonomy (0.145–0.326)**
   and **detail-page JS ~227 KB** as the likely field offenders — confirm whether the lab headroom (owned
   by **AECI-221**) actually surfaces in the field before acting.
4. **Audit the digest's human/bot split** (§3b) — the "Traffic (humans)" number is only as good as the
   ASN table behind it. One query, and widen the list when it turns up hosting networks reading as human.
5. **Glance at the D1 footprint** on **`/admin/system`** — total size and per-table row counts, which
   used to mean a `wrangler d1 execute` per table. Watch `page_views` in particular: it grows ~1,000
   rows/day and `ADMIN_PANEL_SPEC.md` §7.4 sizes the 400-day retention window against it. The table
   list is read from `sqlite_master` at request time, so a table added by a migration shows up without
   a code change.
6. **Append a health-report entry** to [`POST_LAUNCH_HEALTH_REPORT.md`](./POST_LAUNCH_HEALTH_REPORT.md)
   (weekly through the first month, then at the one-month mark).

---

## 3. Launch-tunable thresholds

Every threshold below is a documented **launch placeholder** — set before real traffic existed. Revisit
each weekly; change the value in the named monitor JSON and re-apply (§4). Full rationale per monitor is
in [`OBSERVABILITY.md`](./OBSERVABILITY.md#monitors).

| Monitor | Current threshold | Retune signal |
|---|---|---|
| Worker error rate high | > 1% / 5m | raise the floor only if single failures dominate at low volume |
| Cache hit rate low | < 70% / 15m | set to observed steady-state hit rate once known |
| Detail render slow | > 1.5s / 10m (MISS) | tighten if p95 settles well below |
| page_views write errors | > 10% / 10m | lower toward 1% as volume grows |
| Auth sign-in error rate | > 30% / 15m | lower once sign-in volume is non-trivial |
| Toxicity scoring outage | > 50% / 15m | lower once review volume is non-trivial |
| Moderation queue backlog | > 48h | tighten toward the 24h internal target (§17); move cron hourly if needed |
| Linear pipeline failure | > 50% / 1h | lower once baseline request volume is known |
| Linear webhook HMAC failures | > 3 / 1h | fine as-is (security signal) |
| WAF rate-limit spike | > 500 / 15m | set once baseline mitigation volume is known |
| Data-quality check (warn) | any > 0, **non-paging** (AECI-279) | mute/relax individual warn checks that prove noisy (e.g. known duplicate candidates) |

### Home stats-card content tunables (AECI-280 / Phase 8.2)

Unlike the monitors above, these are **compute constants** in `apps/api/src/lib/home-stats.ts` — the
source/weighting knobs for the home "Trending products this week" card. Change the constant and ship via a
normal deploy/promote; the daily `0 7 * * *` cron **and** every successful `POST /api/promote` recompute
`home.trending_products`. Values were set from the **2026-07-12 prod traffic pull** (see
[`POST_LAUNCH_HEALTH_REPORT.md`](./POST_LAUNCH_HEALTH_REPORT.md)); revisit against ~30 days of traffic and
once the PostHog join lands.

| Constant | Current | Retune signal |
|---|---|---|
| `TRENDING_WINDOW_DAYS` | 7 | validated (7d had 646 product-page views across 124 products); widen only if trending routinely under-fills at steady state |
| `TRENDING_LIMIT` | 5 | validated (top-5 well-separated: 17/17/17/12/12); raising it also requires bumping the `home.trending_products` Zod `.max(5)` cap in `@aeci/shared` **and** the web fallback `.slice(0, 5)` |
| `TRENDING_MIN_VIEWS` | 3 | the honesty floor. **Since AECI-582 (2026-08-13) `computeTrendingProducts` filters on the digest's `HUMAN` predicate**, so the card and the operator's numbers rank the same population; before that it counted every view, and crawlers dominate — of 1,121 product views in the trailing 7 days, only **74** were human, so the card was ranking products by how hard they were being scraped. Consequence: the floor is **no longer inert**. On the day the filter landed exactly 9 products cleared it on human views (8/8/5/4/4/3/3/3/3) — enough to fill the top-5, but a quiet week now falls back to recently-added. Lower it if that fallback starts firing at healthy traffic |

Deferred to the AECI-280 ~30d follow-up: the PostHog-join weighting + recency decay, and the
card-resonance/swap review once PostHog + RUM have real volume.

### Trade publication floor (AECI-539 / AECI-546)

Also a compute constant rather than a monitor: `TRADE_PUBLISH_MIN_PRODUCTS` in
`packages/shared/src/api/taxonomy.ts`. `TRADES_VOCABULARY.md` §6 names it launch-tunable and points
here, so it is listed for real.

| Constant | Current | Retune signal |
|---|---|---|
| `TRADE_PUBLISH_MIN_PRODUCTS` | 1 | The floor a trade must clear before its `/trades/:slug` page is listed, indexed, sitemapped, and pinged. **Already retuned once: 3 → 1 on 2026-08-14.** The AECI-547 backfill landed and left 7 of the 34 terms carrying products (roofing 5, hvac-mechanical 3, electrical 2, sitework-utilities 2, and three at 1); a floor of 3 published only 2 of them, so the floor — not tagging coverage — was what suppressed the namespace. At 1 it withholds only the 27 zero-product terms, and single-product pages are deliberately admitted. **Raising it back** is justified if published trade pages read as thin *while tagging is healthy* — the §1.1 test is whether the page answers "what understands MY work" rather than duplicating the all-products list — or if the single-product pages measurably underperform in Search Console (impressions without clicks, or exclusion as "Crawled – currently not indexed"). Give them a full indexing cycle first. **Do not raise it to hide an under-tagged catalog**: an under-tagged catalog and an over-permissive floor look identical in the term count, but the fix for the first is tagging, and raising the floor only hides the symptom. There is no headroom left below — 1 is the minimum meaningful value, since 0 would publish all 34 terms including 27 empty pages. |

Changing it is a normal deploy — no migration, no redirect (an unpublished trade already resolves at
its permanent URL, so a term crossing the floor simply becomes indexable). Two follow-ups the deploy
does **not** do for you, both because a floor change moves terms across the gate without any promote
behind it:

1. **Purge `sitemap`, `index:trades`, and `taxonomy`**, or the edge serves the old membership until
   the TTLs lapse. The automatic purge is a promote hook; there is no promote here.
2. **Announce the newly indexable term URLs.** The IndexNow / Google Indexing pings are the same
   promote hook, so nothing tells an indexing service the pages exist. Run
   `pnpm --filter @aeci/api ops:submit-trade-urls -- --env production` (dry-run) to see the set, then
   re-run with `--apply --allow-production`. It verifies each page really serves without `noindex`
   before submitting, so run it **after** the purge — if the edge is still serving the old
   membership, it will correctly refuse rather than ping `noindex` pages.

### 3b. Traffic classification — auditing the digest's "humans" (AECI-526 follow-up)

> **Since AECI-741 the digest's HEADLINE is the post-automation figure**, not the raw
> server-side count. Subject and primary stat both read *"N human views after automation"*, with
> the raw count demoted to a sub-line beside it. Read the sections below with that in mind: where
> they say "the headline is an upper bound" they now describe the **sub-line**.
>
> **Two properties of the new headline that are load-bearing.** Its day-over-day delta is computed
> **filtered-against-filtered** — `detectSwarms` runs over the prior day too, because comparing a
> filtered day against an unfiltered prior day would print a fabricated collapse every morning.
> And "the detector ran and flagged nothing" renders differently from "the detector did not run":
> the second prints the raw count *plus an explicit UNFILTERED warning*, because a failed detector
> must never be able to look like a clean day.
>
> **The raw figure remains an UPPER bound — and since 2026-08-26 the email says so
> itself.** AECI-658 / AECI-660 changed three things, so the number no longer has to be mentally
> corrected by whoever reads it:
>
> - The subject line qualifies the raw count (**"(N raw)"**, or **"up to N human views"** when the
>   filter did not run), and the body labels it an upper bound. `page_views` is written
>   server-side on every full-document load, so any crawler that does not run JavaScript is still
>   in it.
> - A **lower bound** is reported beside it: the PostHog count for the same UTC day and host
>   (`lib/posthog-query.ts`). PostHog fires only when JS runs *and* the visitor consented, so a real
>   person who declines is invisible. The truth is between the two, and a large gap means most
>   arrivals never ran our JavaScript. Needs `POSTHOG_QUERY_API_KEY` + `POSTHOG_PROJECT_ID`; absent,
>   the email says the floor is unavailable and never prints a fabricated `0`.
> - An **Automation signal** line appears when the swarm detector (below) flags anything.
> - Since **AECI-683** a **corroborated floor** is printed beside the two bounds: human views that
>   arrived with a NAMED external search or social referrer, and the §9.8 visitors behind them.
>   It is the only one of the three figures a rotating-proxy pool cannot inflate — a proxy sends
>   no `Referer` at all. Read it as a floor (Referrer-Policy strips real referrals into `Direct`)
>   and remember it rests on a **claim** (§9.7 — production holds one confirmed forgery).
>
> The worked example that forced this: on **2026-08-23** the digest emailed "48 human views."
> PostHog for the same day recorded **5 pageviews from 1 person**, and those five were the
> operator's own session, which the digest had already excluded. The 48 produced **zero**
> client-side events.
>
> **And the example that forced AECI-683, three days later.** On **2026-08-26** the digest emailed
> "up to 102 human views" and the PostHog floor read "47 page views from 1 person" — so it looked
> like the pair was working. It was not: that *one person was the operator*, whose client tracker
> has no operator suppression. Decomposed against prod D1, the 102 were ~22 operator views a
> **lapsed admin session** left unflagged, 26 correctly-flagged swarm, ~35-40 automation sitting
> under the thresholds, and **8 views from 7 visitors** that a named external referrer corroborates.
> Both bounds were measuring the operator; only the third figure tracked people.

#### The rotating-proxy swarm detector (AECI-658)

`lib/swarm-detection.ts` groups a window's human views by `user_agent_hash` and flags a hash whose
views came overwhelmingly from *different networks*. The 2026-08-23 shape it was built from: 48 views
across **44 ASNs and 31 countries** but only **18 UA hashes**, with one hash reading nine different
pages from nine different countries on nine different networks and never repeating one.

`cf_asn` shatters a swarm like that into 44 apparent visitors; `user_agent_hash` reassembles it into
seven. It is the same join AECI-582's backfill used retroactively (`recover-ua-names.sql`), pointed
forward at live traffic.

#### The user-agent rotator detector — the exact inverse (AECI-683)

A grouping is blind to whatever it groups **on**. Rotate the user-agent instead of the IP and the
detector above collapses: on **2026-08-26**, AS47544 (IQ PL Sp. z o.o., Poland) read five product
pages under **four distinct UA hashes**, so every group was a singleton, every one was under
`SWARM_MIN_VIEWS`, and the day counted five visitors.

`detectAsnRotators` is the mirror image — group by `cf_asn`, flag one network serving nearly a new
fingerprint per request. Between them the two groupings cover both ways a client dilutes itself:
many networks behind one fingerprint, or many fingerprints behind one network.

**The request-shape verdict is a HARD GATE here, and that is the difference.** For a UA hash,
spanning many networks is anomalous on its own and `nonBrowserViews` is corroboration a reader
weighs. For an ASN it is the reverse — a high UA-hash ratio is the *normal* shape of any shared
network (an office NAT, a campus, a café), so cardinality alone would flag real people constantly.
A rotator cannot launder the shape of its own requests. Without the gate this is a
shared-connection detector wearing a bot detector's name.

`swarmFlaggedViews` is a **union** across both groupings, never a sum: a view can match both shapes,
and adding the two totals would report more suspicious views than the day contained.

**Launch-tunable thresholds** (§3 rules apply — change them here and in the module together):

| Constant | Value | Why |
|---|---|---|
| `SWARM_MIN_VIEWS` | `4` | Below this the ratios are noise; one view is trivially "1 ASN for 1 view". |
| `SWARM_MIN_ASN_RATIO` | `0.8` | "Nearly every view came from a different network." A real browser sits on one network; a proxy pool cannot. |
| `ASN_ROTATOR_MIN_VIEWS` | `4` | Same floor, same reason. A separate constant even though the values match: the two groupings have different false-positive profiles and will be tuned apart. |
| `ASN_ROTATOR_MIN_UA_RATIO` | `0.8` | "Nearly every request wore a different fingerprint." A UA changes on browser update, not between page loads. **Validated at exactly this value**: the AS47544 shape is 4 hashes over 5 views = 0.80, so `0.85` would have missed it. |
| `SWARM_MAX_CANDIDATES` | `25` | Caps each candidate list, because the union count binds one parameter per flagged hash/ASN and D1's parameter ceiling is far below stock SQLite's. `swarmNote` says when it bit; the cap is never silent. |
| `OPERATOR_PAIR_LOOKBACK_DAYS` | `30` | How far either side of a row the operator retro-join looks for an `is_operator = 1` anchor on the same `(user_agent_hash, cf_asn)` pair (below). Symmetric, because a lapse can precede the session's first flagged row as easily as follow its last. |

**Measured false-positive rate, and the honest caveat on it.** Swept across production for the 30
days to 2026-08-27, the ASN detector fires **exactly once** — AS47544 on 2026-08-26 — and flags no
other network. But `client_verdict` did not exist before the AECI-658 deploy landed on **2026-08-26**
(0 rows carry one on 08-25, 877 of 918 on 08-26), and the gate treats a NULL verdict as *no
evidence*. So that sweep is really **two days of evidence, not thirty**. Re-run it after a month of
verdict coverage before concluding the thresholds are right.

```bash
cd apps/api && pnpm exec wrangler d1 execute aeci-app-production --env production --remote \
  --command "WITH pop AS (SELECT * FROM page_views WHERE created_at >= date('now','-30 days')
                 AND is_bot = 0 AND path NOT LIKE '/admin%' AND path NOT LIKE '/account%'
                 AND (is_operator IS NULL OR is_operator = 0))
             SELECT substr(created_at,1,10) d, cf_asn, max(cf_as_organization) org, count(*) views,
                    count(DISTINCT user_agent_hash) uas,
                    sum(CASE WHEN client_verdict IN ('inconsistent','non-browser') THEN 1 ELSE 0 END) nb
               FROM pop WHERE cf_asn IS NOT NULL GROUP BY 1,2
              HAVING views >= 4 AND (uas*1.0/views) >= 0.8 AND nb > views/2.0 ORDER BY 1 DESC"
```

#### The operator session-lapse retro-join (AECI-683)

`is_operator` is decided **once, at ingest**, and `lib/operator-session.ts` resolves every failure to
`false` — deliberately, so an auth hiccup costs a flag rather than the page-view row. **An expired
access token is one of those failures.** An operator browsing across a token expiry therefore writes
flagged rows, then unflagged rows, then flagged rows again, and nothing on the unflagged ones
distinguishes them from a visitor. On 2026-08-26 that was **22 views in one 105-minute gap**, ending
on `/auth/login` — which is what a lapse looks like from the outside.

`NOT_INTERNAL` (`lib/analytics-digest.ts`) now carries a third half: a correlated `NOT EXISTS` that
excludes a row sharing a `(user_agent_hash, cf_asn)` pair with a verified operator row within
`OPERATOR_PAIR_LOOKBACK_DAYS`. Four things about it are load-bearing:

- **The pair, never either half.** Measured 2026-08-19 (`operator-pairs.sql`): the operator's second
  browser hash spans **6 ASNs across 5 countries**, so flagging the hash deletes real visitors in
  four countries; and "everything from Indonesia" was 44% false positives at 50% recall. The pair is
  also exactly the tuple §9.8 already calls a "visitor".
- **Anchors come from `is_operator = 1` only.** The ops backfill could also prove a pair from an
  `/admin*` row, because no visitor reaches one. That is gone: since AECI-575's write-side guard,
  untracked routes are not written **at all**. `/account` would be wrong regardless — every
  signed-in member reaches it.
- **It is an INFERENCE, so it is reported.** The path and session halves are facts about the request
  and are excluded silently. This one is a judgement about identity, so the digest prints
  `operatorLeakViews`, `job_runs` records it, and `/admin/overview` returns
  `operator_leak_excluded` with an `operator_leak_is_an_inference` note. Silence here would be the
  same failure the headline number itself was guilty of.
- **It does not reach every leaked row, by design.** On 2026-08-26 the decomposition put ~26 views on
  the operator; the rule recovers **22**. The other four sit on UA hashes that never carried an
  `is_operator = 1` row of their own, so no pair proves them. Recovering those would mean widening to
  the ASN, which is the rule measured to be wrong in both directions.

It is served by the partial index `page_views_operator_pair_idx` (`(user_agent_hash, cf_asn,
created_at) WHERE is_operator = 1`), which stores entries only for operator rows — a few hundred of
~27k — so the write cost on the app's hottest table is effectively zero. Confirm with
`EXPLAIN QUERY PLAN`; it should read `SEARCH op USING COVERING INDEX page_views_operator_pair_idx`.

**Known ceiling — it works because we are small.** A `user_agent_hash` is a browser *build*
fingerprint, not a person: thousands of unrelated people share "Chrome 128 on Windows 10" exactly, so
at real volume a popular hash legitimately spans many ASNs and cardinality alone would light up
constantly. The signal that survives growth is the **combination** with `client_verdict` — a
high-cardinality hash whose rows are *also* mostly `inconsistent` / `non-browser`. That is what
`nonBrowserViews` and `isCorroboratedByRequestShape()` are for; read them alongside the ratios, never
the ratios alone. Revisit both thresholds when human volume passes a few hundred views/day.

**It never writes `is_bot`, and must not start.** The rule from AECI-582 is unchanged and applies
doubly here: do **not** widen `DATACENTER_ASNS` to catch a residential-proxy swarm. Those ASNs are
genuine consumer ISPs — that is the entire point of a residential proxy — and the map drives the
**live** classifier, so listing them would classify real people's ISPs as datacenters.


The digest's headline **Traffic (humans)** filters on `page_views.is_bot IS NOT 1`, written at ingest by
`classifyTraffic(ua, asn)` (`apps/api/src/lib/bot-classification.ts`). The UA half is reliable — crawlers
self-name. The **ASN half is a hand-maintained list** and is the weak point: CF Pro yields no bot score, so
a headless browser on a hosting IP with a spoofed Chrome UA reads as human until its ASN is on the list.
This is not hypothetical — the 2026-08-03 digest reported **166 "humans" of which ≥149 were
datacenter/VPN/scanner networks**, 107 from one unlisted colocation provider (AS47007).

**Since AECI-624 the panel does part of this audit for you — but only part.** The §7.6 `asn_registry`
annotates each Activity row and each `dimension=asn` group with what the network is *registered as*
(`/admin/traffic` → Networks; a group reading "not a browsing network" with real view counts is the
tell). It deliberately does **not** change `is_bot`, so the census below is still the thing that
decides whether an ASN joins `DATACENTER_ASNS`. Two limits worth holding in mind while reading the
annotation: PeeringDB has no usable signal for ~25% of our traffic, and `Content` includes Google and
Netflix — it means "not an eyeball network", never "hosting". The annotation narrows the list of ASNs
worth censusing; it does not replace the judgement.

**Weekly audit** — census the ASNs that came through as human, and name them:

```bash
cd apps/api && pnpm exec wrangler d1 execute aeci-app-production --env production --remote \
  --command "SELECT cf_asn, COUNT(*) n, COUNT(DISTINCT user_agent_hash) uas, COUNT(DISTINCT path) paths
             FROM page_views pv WHERE created_at >= date('now','-7 days') AND is_bot = 0
               AND path NOT IN ('/admin','/account') AND path NOT LIKE '/admin/%' AND path NOT LIKE '/account/%'
               AND (is_operator IS NULL OR is_operator = 0)
               AND NOT EXISTS (SELECT 1 FROM page_views op WHERE op.is_operator = 1
                                AND op.user_agent_hash = pv.user_agent_hash AND op.cf_asn = pv.cf_asn
                                AND op.created_at >= strftime('%Y-%m-%dT%H:%M:%fZ', pv.created_at, '-30 days')
                                AND op.created_at <= strftime('%Y-%m-%dT%H:%M:%fZ', pv.created_at, '+30 days'))
             GROUP BY 1 ORDER BY n DESC LIMIT 40"
# then, per suspicious ASN:
curl -s "https://stat.ripe.net/data/as-overview/data.json?resource=AS47007" | jq -r .data.holder
```

Tells that an "ASN" is really automation: one ASN dominating the day; a handful of UA hashes covering
dozens of paths; many single `/` hits from many countries inside one short window (a residential-proxy
sweep); a holder name containing hosting / cloud / server / VPS / colo / datacenter.

The `is_operator` clause (§13 D13) matters here more than anywhere else, because **the operator's own
ASN is the single most likely "one ASN dominating the day"** and misreading it as automation is how a
residential ISP ends up in `DATACENTER_ASNS` — the exact false positive the membership rule below
forbids. It only covers rows written from 2026-08-19 onward; on older windows the operator's own
network will still show up near the top and must be recognised rather than listed.

The `NOT EXISTS` clause beside it is the AECI-683 retro-join, and it matters here for the same
reason and then some: the rows it catches are the operator's, they carry no flag saying so, and a
census that counts them will rank the operator's ISP first on exactly the days their session
lapsed. Both clauses, always — `NOT_INTERNAL` is one predicate in code precisely so a hand-written
query is the only place they can come apart.

**Widening the list** (the fix): add `[asn, 'Datacenter (Holder)']` to `DATACENTER_ASNS`, then regenerate
`scripts/ops/backfill-page-view-bots.sql` to match — `bot-classification.spec.ts` parses that SQL and fails
CI on drift. The membership rule and the deliberate exclusions (Apple/Private Relay, Zscaler and other
corporate proxies, Tor, mixed consumer/IDC networks, tier-1 transit) are documented at the top of the map;
**a false positive silently deletes a real visitor, which is worse than counting a crawler** — verify the
holder before adding.

**Backfilling history — done 2026-08-13 (AECI-582), on all four tiers.** Rows captured before the
classifier shipped had `is_bot IS NULL` and read as **human**, so every historical day and every
day-over-day delta over-counted humans. Production's 17,784 such rows are now classified and its
"reads as human" total fell **18,322 → 2,096**. Re-run after a widening with the guarded runner, which
dry-runs, exports `page_views` and verifies around both SQL files:

```bash
scripts/ops/2026-08-page-view-bot-backfill/run.sh --env production            # dry-run
scripts/ops/2026-08-page-view-bot-backfill/run.sh --env production --apply --allow-production
```

Two things to know before relying on it again. **(1)** It only reaches rows that are still null, and the
2026-08-13 run swept every remaining row to `is_bot = 0` — so newly-listed ASNs now need a targeted
`UPDATE page_views SET is_bot = 1, bot_name = '…' WHERE is_bot = 0 AND cf_asn IN (…)`, and the
"never classified" signal no longer exists to find them by. **(2)** The runner applies
`2026-08-page-view-bot-backfill/recover-ua-names.sql` *first*, which recovers a crawler's **real name**
by matching `user_agent_hash` against rows the live classifier has since named. That works because
`classifyTraffic()` tests the UA before the ASN, so such a verdict is UA-derived and transfers across
ASNs — it is how 885 `Applebot` rows on **AS714 (Apple)** were classified without adding Apple to
`DATACENTER_ASNS`. Reach for that technique before widening the list against an ASN the map excludes
on purpose: the map drives the live classifier too, and the exclusions exist to protect real people.

The path-exclusion clauses above mirror the digest, which since **AECI-575** excludes the operator-only
routes (`/admin/*`, `/account`) from every `page_views` read. Leave them in or the census will rank the
operator's own ISP first and you will spend the audit chasing yourself — on the 2026-08-10 digest day
**67 of 92 "human" views were the operator** (AS23700, Jakarta). Drop them only when you deliberately want
the unfiltered table.

**Known ceiling**: the durable fix is not a longer list — it is capturing Cloudflare's `asOrganization`
(available on all plans, unlike the bot score) at ingest and matching on the holder name, plus the PostHog
join (AECI-239) as the human source of truth. AECI-575 removed the one slice of internal traffic that could
be excluded **precisely** (operator navigation on authed surfaces, zero false positives); what remains is
genuine visitors sharing the operator's ISP, which only `ANALYTICS_INTERNAL_ASNS`
(`ADMIN_PANEL_SPEC.md` §13 D10, unbuilt) or the holder-name fix can separate. Until then, treat the digest's
human count as an **upper bound**.

**Half of that fix has landed: `page_views.cf_as_organization`** (AECI-585 / §13 D10) captures the holder
name at ingest, so from that deploy forward the `curl stat.ripe.net` step above is only needed for
**older** rows — the census query can select `cf_as_organization` directly and read the holder off the
result. It changes nothing about the audit's doctrine: the name is a **read-side label**, it never feeds
`is_bot` at ingest, and widening `DATACENTER_ASNS` remains the only thing that writes a classification, with
the same "a false positive silently deletes a real visitor" rule. Two limits to keep in mind — it is null on
every row written before the deploy and is not backfillable, and matching *on* the holder name is still
unbuilt: this is the capture, not the classifier.

---

## 4. Triage → ticket loop

When a signal regresses beyond a known launch item:

1. **Confirm it isn't expected** — e.g. analytics dark (§0), a warn-severity data-quality finding
   (informational), or a threshold known to be a low-volume placeholder (§3).
2. **Capture evidence** — the metric name, the Datadog dashboard/monitor link, and the time window.
3. **Open a Linear issue** in the **AECi** team, label `infra`, referencing the evidence and the
   governing runbook section. Per the checkpoint convention, this pass **documents** regressions for
   Chris to file rather than auto-creating issues.
4. **Record it** in the current [`POST_LAUNCH_HEALTH_REPORT.md`](./POST_LAUNCH_HEALTH_REPORT.md) entry so
   the trend is visible week over week.

---

## 5. Applying monitor changes (ops)

Monitors are committed JSON, **not** Terraform-managed — apply via the curl recipe in
[`OBSERVABILITY.md` → Applying the dashboard + monitors](./OBSERVABILITY.md#applying-the-dashboard--monitors)
(substitute `@NOTIFICATION_CHANNEL_TBD` → `@chrisw@thewbsproject.com` at apply time).

**AECI-279 changed/added three monitors — apply these:**

- `monitor-data-quality-check.json` — *edited*, now scoped `severity:error` (was all severities).
- `monitor-data-quality-check-warn.json` — *new*, `severity:warn`, informational. Uses the
  `@NOTIFICATION_CHANNEL_LOW_TBD` placeholder: substitute a low-urgency handle when one exists, or leave
  it literal so the monitor stays **UI-only / non-paging** (the daily digest already carries these rows).
- `monitor-waf-poll-no-data.json` — *new*, liveness for the hourly WAF poll (`aeci.waf.poll{outcome:ok}`).
  **Precondition:** the poll only emits `outcome:ok` once `CF_ANALYTICS_API_TOKEN` (+ `CF_ZONE_ID`) is
  provisioned for the env; until then it emits `outcome:skipped_no_creds` every hour and never `outcome:ok`,
  so this no-data monitor will fire continuously. Apply it after the token is set (or expect it to fire
  meanwhile) — the same "dark until the secret exists" caveat the §0 gate applies to the analytics monitors.
