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

### 1a. The 10 scheduled crons (row 6 detail)

Each cron emits an always-on heartbeat; the "not running" monitor's no-data is the liveness signal.
A green board here means all ten fired on schedule. Since AECI-583 each run **also** writes a
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
| `0 5 * * *` | Operator analytics digest (AECI-526) — **human** page views + top products, sign-ins, moderation depth, and a Crawler-activity breakdown (human/bot split classified at ingest by UA + ASN) | `analytics-digest` | `aeci.analytics_digest.email` heartbeat (no dedicated monitor yet) |
| `0 6 * * *` | Moderation queue snapshot | `moderation-snapshot` | moderation-queue-age (threshold + no-data) |
| `0 7 * * *` | Home-stats compute | `home-stats` | stats-compute-failed / stats-not-running |
| `0 8 * * *` | Algolia incremental sync | `algolia-sync` | sync-failed / sync-not-running |
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

The digest's headline **Traffic (humans)** filters on `page_views.is_bot IS NOT 1`, written at ingest by
`classifyTraffic(ua, asn)` (`apps/api/src/lib/bot-classification.ts`). The UA half is reliable — crawlers
self-name. The **ASN half is a hand-maintained list** and is the weak point: CF Pro yields no bot score, so
a headless browser on a hosting IP with a spoofed Chrome UA reads as human until its ASN is on the list.
This is not hypothetical — the 2026-08-03 digest reported **166 "humans" of which ≥149 were
datacenter/VPN/scanner networks**, 107 from one unlisted colocation provider (AS47007).

**Weekly audit** — census the ASNs that came through as human, and name them:

```bash
cd apps/api && pnpm exec wrangler d1 execute aeci-app-production --env production --remote \
  --command "SELECT cf_asn, COUNT(*) n, COUNT(DISTINCT user_agent_hash) uas, COUNT(DISTINCT path) paths
             FROM page_views WHERE created_at >= date('now','-7 days') AND is_bot = 0
               AND path NOT IN ('/admin','/account') AND path NOT LIKE '/admin/%' AND path NOT LIKE '/account/%'
             GROUP BY 1 ORDER BY n DESC LIMIT 40"
# then, per suspicious ASN:
curl -s "https://stat.ripe.net/data/as-overview/data.json?resource=AS47007" | jq -r .data.holder
```

Tells that an "ASN" is really automation: one ASN dominating the day; a handful of UA hashes covering
dozens of paths; many single `/` hits from many countries inside one short window (a residential-proxy
sweep); a holder name containing hosting / cloud / server / VPS / colo / datacenter.

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
