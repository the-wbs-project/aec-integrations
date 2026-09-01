# Analytics Baseline

**Version:** 1.0 · **Date:** 2026-07-11 · **Owner:** Chris · **Issue:** AECI-326

The pre-marketing measurement baseline: what is instrumented, the starting numbers, and how to
read them each week. Companion to [`OBSERVABILITY.md`](./OBSERVABILITY.md) (the instrumentation
*catalog*) — this doc is the point-in-time *record*. The point is to confirm we can measure what
marketing produces **before** we produce it.

## Instrumentation status (as of 2026-07-11)

| Signal | Source | Status | Notes |
|---|---|---|---|
| **Pageviews** (client) | PostHog `capture_pageview: 'history_change'` (`apps/web/src/app/analytics/`) | Built; **live once `POSTHOG_KEY` is set** | Auto-captures initial load + SPA navigations, consent-gated. |
| **Mailing-list signup** (client) | PostHog `mailing_list_signup` event, fired on a genuine new subscribe (AECI-326) from the shared band (`home/home-closing-cta.ts` + the directory/detail mounts, AECI-327) and the `/updates` page (AECI-536) | Built; live once `POSTHOG_KEY` is set | Consent-gated → *consented funnel only*. `source`: `home_closing_cta` / `mailing_list_band` / `updates_page`. |
| **Mailing-list signup** (server, authoritative) | `mailing_list` D1 table via `POST /api/subscribe`; mirrored to Datadog `aeci.email.send{template:landing-signup}` on each new insert | **Live** (consent-independent) | The true signup count. **Readable since AECI-586** at `/admin/audience` (`GET /api/admin/audience`), which also carries growth, exact churn, and a **consent-independent** UTM + geography breakdown. Read PostHog for the on-site funnel (*which band* converted); read the panel for the number, the trend, and *where they came from*. |
| **Product feedback** (server) | `feedback` D1 table via `POST /api/feedback` | **Live** (consent-independent) | **Readable since AECI-586** at `/admin/audience` → Feedback inbox (`GET /api/admin/feedback`). Before that the operator email fired from the handler was the only record — the table was genuinely write-only, so a filtered alert was a lost submission. |
| **Core Web Vitals** (field) | Datadog RUM `@datadog/browser-rum` (`apps/web/src/app/datadog.provider.ts`) | Built; **live once `DD_APPLICATION_ID` + `DD_CLIENT_TOKEN` are set** | RUM collects LCP/CLS/INP/FCP/TTFB automatically on init. `aeci` RUM app, us5. |
| **Server pageviews / entry pages** | `page_views` D1 table via `POST /api/page-views` | **Live** (consent-independent) | Readable since AECI-574 — see "The consent-independent read path" below. Since **AECI-582** (2026-08-13) every row is classified human/bot — the 2026-07-12 AECI-280 pull's 4,917 rows were counted as human but were ~93% crawls (see the 2026-08-13 addendum). `cf_bot_score` is still null on every row (CF Pro exposes no bot score); the split comes from UA + ASN instead. Since **AECI-575** it captures **public routes only** — `/admin/*` and `/account` are excluded at both writers and filtered out on read (see the 2026-08-12 addendum below). Since **§13 D13** (2026-08-19) views made by a verified admin session are excluded on read too, whatever the path — the operator's own public-site browsing was 15% of the human count (see the 2026-08-19 addendum). Since **§13 D15** (2026-08-27) the rows a *lapsed* session left unflagged are excluded as well, by `(user_agent_hash, cf_asn)` pair (see the 2026-08-27 addendum). |

### The consent-independent read path (updated 2026-08-13, AECI-574 + AECI-577 + AECI-582)

The row above previously read *"write-only today (no reporting endpoint); query D1
directly"*. **That is no longer true.** `page_views` now has a first-class read
surface — the admin panel's four endpoints (`docs/ADMIN_PANEL_SPEC.md` §6,
`API_CONTRACTS.md` §6.10), behind `requireAdmin()`:

- `GET /api/admin/overview` — the daily bundle, reporting the same numbers as the
  05:00 analytics digest email for the day it covers.
- `GET /api/admin/metrics/timeseries` — human/bot views and unique visitors per
  day over any window, plus catalog additions and new sign-ins.
- `GET /api/admin/traffic/breakdown` — grouped by source, country, path, product,
  or bot.
- `GET /api/admin/page-views` — **individual visits** (AECI-577), newest first,
  filtered by window / population / source / country / path, rendered at
  `/admin/activity`. The first per-visit read surface the table has ever had, and
  the direct answer to "who actually visited today" — the question the three
  aggregate endpoints above can only answer in bulk.

This matters for the same reason the panel exists: **PostHog sees only consented
traffic**, and a single-page arrival from a search engine never grants consent —
on 2026-08-10 the digest counted 92 human page views across four sources and
PostHog recorded essentially none of them. `page_views` is the consent-independent
record; read it for *what happened*, and PostHog for *the consented funnel*.

**The same argument extended to the mailing list and feedback with AECI-586**
(`GET /api/admin/audience`, `GET /api/admin/feedback`, rendered at
`/admin/audience`). PostHog's `mailing_list_signup` event knows which on-site band
converted, but only for consenting visitors; the panel's UTM and geography
breakdowns cover **every** signup and answer where they arrived from. The gap is
starker here than for page views, because attribution is exactly what a marketing
read needs and exactly what consent gating removes. Two further things only the
panel can report: **churn**, which is *exact* rather than modelled because
`unsubscribed_at` is a suppression record and no subscriber row is ever deleted;
and the **feedback inbox**, whose table had no read path at all before that unit —
the operator email was the only copy of a submission.

Three limits travel with those numbers and are returned as machine-readable notes
on every response rather than left to the reader:

- **Bot classification is complete, and trustworthy from 2026-08-03.** Every row
  is classified as of **2026-08-13**, when AECI-582 backfilled the 17,784
  unclassified rows that the digest's `is_bot IS NOT 1` predicate had been
  counting as human. Live classification began 2026-08-03 (the earlier "~08-05"
  estimate was off by two days); everything before that is classified
  retroactively by User-Agent hash and ASN, so it carries the coarser fidelity
  described in the 2026-08-13 addendum. The `bot_classification_incomplete` note
  was derived from the window's contents rather than a hardcoded date, so it
  retired itself the moment the backfill ran. **`is_bot = 0` still means "not
  known to be a bot", not "human"** — and since **AECI-624** the admin panel says
  so beside the row rather than only in this document: `/admin/activity` joins the
  §7.6 `asn_registry` at read time and annotates a network the registry lists as
  something nobody browses from, while leaving `is_bot` exactly as ingest wrote
  it. A row reading `is_bot = 0` **and** "not a network people browse from" is the
  honest state, and it is the shape the 2026-08-13 forged-referrer burst had. The
  same issue renamed the Activity Source column to **"Claimed source"**, because
  `referrer_source` comes from a client-supplied header that nothing verifies —
  production holds a confirmed `www.youtube.com` forgery. The ASN half is a
  hand-maintained list, so
  the human count remains an upper bound.
- **`referrer_source` is null on every row before August** and is not
  backfillable — the header was never stored.
- **`Direct` is a mixed bucket for every row written before AECI-585** —
  `PageViewTracker` POSTs on every SPA navigation and the same-origin `Referer`
  classifies as `Direct`, so in-app hops and true arrivals were indistinguishable.
  AECI-585 added the `navigation` flag that separates them **at write time**; rows
  before it carry null and stay permanently mixed, because nothing in a stored row
  implies which one it was.

### What AECI-585 started recording, and from when

AECI-585 (`ADMIN_PANEL_SPEC.md` §7.3) widened `page_views` ingest. Each field below
is **null on every earlier row and is not backfillable** — the information was never
captured, so no query can reconstruct it. The trustworthy-from date is the date the
change reached **production**, which per §13 D1 is the `admin-panel → main` merge and
not the PR that built it; fill it in at that merge (AECI-587 owns the closeout).

| Field | What it records | Trustworthy from |
|---|---|---|
| `taxonomy_kind` + `taxonomy_id` | Which term a `/categories`, `/audiences`, `/phases` or `/trades` page showed. Before it, ~600 rows could say a facet page was viewed but not which one | _AECI-585 production deploy_ |
| `concrete_path` | The real URL path beside the route pattern in `path`, so a row without an FK can still name itself | _AECI-585 production deploy_ |
| `navigation` | `'arrival'` (full-document load) vs `'spa'` (in-app hop) — the split that makes `Direct` a measurement | _AECI-585 production deploy_ |
| `cf_as_organization` | The AS holder *name* beside the number, so the internal-traffic filter and the weekly bot audit can label themselves instead of showing bare AS numbers | _AECI-585 production deploy_ |

Two consequences worth stating rather than discovering. Any chart that splits on one
of these must show the pre-capture population as **unknown**, never fold it into the
majority bucket — that is the same honesty rule `referrer_source` already carries.
And the read surfaces do not use these columns yet: AECI-585 was scoped to ingest,
so the panel still renders a taxonomy row as its bare route pattern and still emits
the `direct_is_mixed_bucket` note. Wiring the reads is tracked separately.

**No session identifier was introduced, deliberately** (`ADMIN_PANEL_SPEC.md` §13
**D7**). A "visitor" is defined as a distinct `(user_agent_hash, cf_asn)` pair
inside the window — which over-counts on browser updates and under-counts behind
shared NAT, and says so next to the number. Minting a real session id would create
a durable first-party identifier, and it is precisely the *absence* of one — a UA
**hash** and a referrer **host**, never the full URL or query — that makes the
`page_views` write defensible as consent-independent in the first place. The three
dead columns (`user_id`, `session_id`, `profile_role`) were dropped rather than
filled — AECI-585 removed them in migration `0014`. The table can no longer hold
user linkage at all, which is also the strongest form of the GDPR erasure story:
account deletion has nothing to erase here (`AUTH_AND_RLS.md` §12).

The per-visit feed added by AECI-577 holds that line where it would be easiest to
cross: it exposes **eight characters** of the UA hash, truncated in SQL so the
full hash never crosses the wire, and pairs it only with the ASN. There is no
cross-visit stitching, no reverse lookup, and no enrichment — a row identifies a
browser-and-network shape, never a person.

### Provisioning dependency (why prod was dark)

Verified against live prod on 2026-07-11: the served HTML on `www.aecintegrations.com` injected
only `__AECI_ALGOLIA__` + `__AECI_SUPABASE__` config — **no `__AECI_POSTHOG__`, no `__AECI_DD__`**.
Injection is gated on the Worker secrets existing, so PostHog and Datadog **RUM** were **not
capturing anything in production**. AECI-326 makes both durable: PostHog was already CI-pushed
(from `POSTHOG_KEY_{STAGING,PRODUCTION}`); the RUM credentials are now CI-pushed too (shared
un-suffixed `DD_APPLICATION_ID` / `DD_CLIENT_TOKEN`, all four deploy/promote workflows). **Both go
live once the GitHub secret *values* are set** (see [`OBSERVABILITY.md` → Credentials](./OBSERVABILITY.md#credentials)).

## Baseline (the recorded snapshot)

> **As of 2026-07-11, AECi is pre-launch and pre-marketing.** The mailing list holds ~1 real
> subscriber. Client-side traffic and Core Web Vitals capture in **production** were *dark* at the
> time of writing — PostHog and Datadog RUM are fully built but their Worker secrets were
> unprovisioned, so no pageviews, signup events, or field CWV were being recorded in prod; AECI-326
> switches both on (code + durable CI wiring; awaiting the secret values). Consequently weekly
> visitors and top entry pages are effectively **nil-to-negligible** and not yet meaningfully
> measurable from the analytics dashboards; the home page (`/`) is the sole broadly-shared entry
> point pre-launch, and the authoritative signup count (the `mailing_list` D1 table) reads ~1. This
> baseline exists to prove the *instrumentation* works — per the issue, "this is about
> instrumentation, not numbers" — so that once the secrets are set and the site launches, weekly
> visitors, signups, and top entry pages accrue against a known zero.

Re-read and update this snapshot ~1 week after the analytics secrets are provisioned (first real
numbers), and again at launch.

> **AECI-280 addendum (2026-07-12).** The server-side `page_views` D1 table is **not** nil — it holds
> 4,917 rows (3,237 in the last 7 days; 646 product-page views across 124 products) since 2026-06-23.
> But `cf_bot_score` is **null on every row** (Cloudflare **Pro** exposes no bot score), so this volume
> is *unclassified*: an unknown — pre-marketing, likely large — share is bots / crawlers / synthetic
> monitoring, not human demand. **PostHog** (still dark until `POSTHOG_KEY_PRODUCTION` is set) therefore
> remains the signal for real human traffic + funnel; AECI-280 added a prod preflight nudge for that
> secret in `promote-to-prod.yml` and it also feeds the deferred trending PostHog join. The pull was
> taken to tune the home **trending** card — see [`POST_LAUNCH_HEALTH_REPORT.md`](./POST_LAUNCH_HEALTH_REPORT.md)
> (2026-07-12 entry) and the `TRENDING_MIN_VIEWS` floor (`POST_LAUNCH_MONITORING.md` §3).

> **AECI-575 addendum (2026-08-12) — `page_views` is public routes only.** What the table "sees"
> narrowed: operator-only surfaces (`/admin/*` and `/account`) no longer produce rows, and the rows
> already in the table are filtered out on read. Before this, every admin click wrote a `page_views`
> row from the operator's own ISP and the daily digest counted it as a visitor — on the 2026-08-10
> digest day **67 of the 92 "human" page views came from AS23700 (Jakarta), the operator's own ISP**
> (`ADMIN_PANEL_SPEC.md` §14.2). The prefix list is `UNTRACKED_ROUTE_PREFIXES` in `@aeci/shared`,
> enforced at both writers (`PageViewTracker.fire()` and the SSR Worker's `firePageView()`) and in
> the daily digest's reads (`apps/api/src/lib/analytics-digest.ts`).
>
> Two consequences when reading numbers across this date. **(1)** Digest human counts for days
> *before* 2026-08-12 are now reported lower than they were in the email sent at the time — that is
> the intended retroactive correction, not a data loss; the rows are still in D1 and an ad-hoc query
> without the filter still sees them. **(2)** This is the *precise* half of internal-traffic
> filtering, with zero false positives. The coarse remainder — genuine visitors who happen to share
> the operator's ISP — is `ANALYTICS_INTERNAL_ASNS` (`ADMIN_PANEL_SPEC.md` §13 D10), still unbuilt,
> so the human count remains an **upper bound**.

> **D13 addendum (2026-08-19) — the operator's own browsing is no longer counted.** AECI-575 (above)
> stopped counting the operator while they were *in the console*. It never stopped counting them
> browsing the **public** site to check their own work, and nothing on such a row distinguishes it
> from a visitor's. Measured on 2026-08-19: **368 of 2,493 all-time human public-page views (15%)**
> came from the operator's own browser, across **AS23089/US** (Jun 23 → Jul 30), **AS23314/US**, and
> **AS23700/ID** (Aug 3 → Aug 18) as their network changed. `page_views.is_operator` now records, at
> ingest, whether the request carried a *verified* admin session, and every read excludes it
> (`ADMIN_PANEL_SPEC.md` §13 D13).
>
> Three consequences when reading numbers across this date. **(1)** The live flag is **not
> retroactive** — older rows are `is_operator = NULL` and read as visitors, because nothing stored
> on them implies a *session*. Left alone that would put a **step down at 2026-08-19** of roughly
> the 15% above, with days on either side not directly comparable. **(2)** Most of that step is
> closed by a separate, explicitly approximate backfill —
> `scripts/ops/2026-08-operator-page-view-backfill/`, see the addendum below. **(3)**
> `ANALYTICS_INTERNAL_ASNS` is now genuinely a remainder: it is left covering only the operator's
> *other* devices on a known network. The human count is still an **upper bound**, but by a much
> smaller margin than before.

> **Backfill addendum (2026-08-19) — history corrected by visitor PAIR, not by country.** The
> recoverable signal for older rows is not the session but the **`(user_agent_hash, cf_asn)` pair**
> — §9.8's own definition of a visitor. `page_views` still holds `/admin*` and `/account` rows,
> which no visitor reaches, so a pair appearing on one is *proven* to be the operator. Six pairs,
> four proven directly: **679 rows flagged, 458 of them in the human public population**, taking
> all-time human page views **2,494 → ~2,036 (an 18% correction)**. The remaining 221 are the
> operator's own WARP/VPN traffic, currently mislabelled as datacenter crawls.
>
> **Two simpler rules were measured and rejected, and the numbers are worth keeping.**
> *"Everything from Indonesia"* flags 333 rows of which only **185** are the operator — **44% false
> positives**, because Indonesian traffic carries 25 distinct browsers — while missing the **183**
> views from the operator's US period (AS23089, Jun 23 → Jul 30) entirely, for **50% recall**. It
> is wrong in both directions at once, and a country is simply a coarser network than the ASN
> §13 D10 already rejected. *"The operator's UA hash"* is safe for the primary hash but unsafe as a
> method: their **second** browser hash spans **6 ASNs across 5 countries**, since a UA hash is a
> browser *build* shared with strangers.
>
> **Do not read the backfilled rows as equivalent to the live flag.** The flag is a verified session;
> this is an inference. Two candidate pairs on the operator's own ISP (an 11-view hour, a
> 7-views-in-one-second burst) were deliberately left counted because neither can be told apart from
> a visitor, and a browser used only on public pages before the move would leave no proof row at
> all. The backfill writes only over NULL, so it never overrides the live flag and its rollback is a
> true inverse.

> **AECI-582 addendum (2026-08-13) — most of the "humans" were bots.** The one-time bot backfill ran
> on all four tiers. It classified the **17,784 of 26,671** production rows that had `is_bot IS NULL`
> and were therefore being counted as human by `is_bot IS NOT 1`. In the digest population, all-time
> human page views fell **18,318 → 2,095**: roughly **89% of everything ever recorded as human
> traffic was bots** (June ~94%, July ~93%). The real human baseline for the site's first seven weeks
> is about **2,100 page views**.
>
> Three consequences when reading numbers across this date. **(1) Every June/July figure in this
> document and in the digests sent at the time is overstated** — including the 2026-07-12 addendum
> above, whose 4,917 rows were themselves largely crawls. Those entries are left as written; this is
> the correction. **(2) No discontinuity in the daily numbers.** Live classification began
> **2026-08-03** (not the ~08-05 previously estimated), and every day from 08-04 on was already
> fully classified, so the backfill moved nothing in any recent digest. **(3) Pre-08-03 rows are
> classified retroactively and at lower fidelity** — by User-Agent *hash* and by ASN, since the raw
> UA is discarded at capture. 4,941 rows did recover a true crawler name by matching their UA hash
> against a row the live classifier had already named; the rest carry a hosting-provider label. A
> self-identifying crawler on an unlisted, non-datacenter ASN is still counted as human.
>
> The residual bias is unchanged in direction: `is_bot = 0` means "not known to be a bot". With
> `ANALYTICS_INTERNAL_ASNS` still unset, the human count stays an **upper bound**.

> **AECI-683 addendum (2026-08-27) — the digest's "humans" were still ~8x the people, and the
> PostHog floor was measuring the operator.** AECI-658/660 (2026-08-26) shipped *measurement*: an
> "up to N" subject, an upper-bound label, a PostHog lower bound, and a swarm detector. It worked —
> and what it measured is that the pair of bounds was not bracketing anything. On **2026-08-26** the
> digest emailed **"up to 102 human views"** beside **"47 page views from 1 person"**, which reads
> like corroboration until you resolve the person: PostHog person `174286d5…`, South Tangerang ID,
> active 02:44–23:25 — the **operator**, whose client tracker has no operator suppression. Both
> bounds were measuring the same person.
>
> Decomposed against production D1, the 102 were: **~26** operator self-traffic (22 of them one
> contiguous burst, 05:46–07:32, ending on `/auth/login`), **26** correctly-flagged swarm,
> **~35–40** automation sitting under the AECI-658 thresholds, and **8 views from 7 visitors** that
> a named external referrer corroborates. The "Most viewed products" table that day was largely the
> operator's own browsing plus one Polish UA-rotator; the +28% day-over-day delta was leak variance,
> not growth; and "Direct 87" was mostly automation, because proxies send no `Referer`.
>
> Three changes, and the distinction between them is the point. **(1)** `NOT_INTERNAL` gained a
> third half — a `(user_agent_hash, cf_asn)` retro-join that recovers the rows a *lapsed* admin
> session left unflagged (`is_operator` is decided once at ingest and fails open on an expired
> token). This **changes the counted population**, legitimately: it is operator-identity exclusion,
> §13 D13's business, not a bot judgement. It recovers **22 of the ~26** and deliberately stops
> there — the other four sit on UA hashes that never carried an `is_operator = 1` row, so no pair
> proves them, and reaching them would mean widening to the ASN, the rule measured wrong in both
> directions above. **(2)** An inverse ASN-grouping detector, and **(3)** a **corroborated floor**,
> are both **report-only**: they print beside the headline and never subtract from it.
>
> **Do not read the retro-join as equivalent to the live flag** — the same rule the 2026-08-19
> backfill addendum sets for the pair cohort. It is an inference about identity, which is precisely
> why the email, `job_runs`, and `/admin/overview` all report `operatorLeakViews` rather than
> quietly netting it off.
>
> Two limits recorded honestly. The corroborated figure is a **floor built on a claim**:
> Referrer-Policy strips real referrals into `Direct`, and nothing verifies a `Referer` (§9.7 — this
> table holds one confirmed forgery). And the ASN detector's clean false-positive record — one
> flag, AS47544, in 30 days of production — rests on `client_verdict`, which **did not exist before
> 2026-08-26** (0 rows carry one on 08-25, 877 of 918 on 08-26). That is two days of evidence, not
> thirty. Re-check after a month of verdict coverage.
>
> `metrics_daily` rows written before this date keep the old definition, and
> `/api/admin/metrics/timeseries` serves snapshot-first, so a chart will step at the boundary until
> `ops:backfill-metrics-daily` is re-run.

### Decomposing the residual — what survives the automation filter (2026-08-31, AECI-741)

> **The number left after the filter is not a floor of real people.** AECI-658 taught the digest to
> flag rotating-proxy traffic; AECI-741 made the post-filter count the headline. This is the
> hand-audit of what that headline actually contains, run over the two days the operator queried
> (**2026-08-29** and **2026-08-30**, production).
>
> | | 8/29 | 8/30 |
> |---|---|---|
> | Raw human page views | 87 | 70 |
> | Flagged as automation | 64 | 56 |
> | **Residual (the new headline)** | **23** | **14** |
> | PostHog floor | 0 views / 0 people | 2 views / 1 person |
> | Corroborated by external referrer | 2 views | 0 |
>
> **Of the 37 residual views across both days, at most ~3 are plausibly a person.** The breakdown:
>
> - **18 of 37 are the SAME flagged swarm, sub-threshold that day.** `SWARM_MIN_ASN_RATIO` is
>   evaluated per-day and independently each day, so a client that happens to reuse one network
>   drops under the 0.8 cutoff and escapes. `53304b2e…` was flagged on 8/29 (ratio 1.0) and escaped
>   on 8/30 at ratio 0.70 → **10 residual views**. `02048353…` escaped on 8/29 at ratio 0.63 and was
>   flagged on 8/30 → **8 residual views**. Over 2026-08-21…30 the eight swarm hashes each ran
>   **every single day**, spanning **45–68 ASNs across 29–38 countries** (525 views total). A client
>   with that history should not be re-adjudicated from scratch each morning.
> - **7 of 37 are one scraper on commercial proxy infrastructure** (`dc0402b6…`). Its ASNs are
>   AS27411 (**UAB code200**, i.e. Oxylabs) and AS62874 (**Web2Objects**). On 8/29 at
>   `16:20:11.241Z → .900Z` it read **five different product pages in 659 ms**. No person does that.
> - **3 of 37 sit under `SWARM_MIN_VIEWS`** (`87012404…`: 3 views, 3 US networks — Charter, **Rockion
>   LLC**, Airfiber — one fingerprint, and all three carry a `client_verdict` of `inconsistent`).
>   The 4-view floor is what lets them through; the verdict already knew. **Closed by AECI-744**
>   (2026-09-01) — see the addendum below.
> - **2 of 37 are ONE arrival counted twice.** `81e13bc5…` wrote `/products/leap-crm` at
>   `15:37:06.370Z` and `15:37:06.453Z` — 83 ms apart, same path, same ASN, same referrer. These two
>   rows *are* the "2 Google" that the 8/29 digest reported as its traffic-source table and its
>   entire corroborated population. The only externally-corroborated arrival in two days is inflated
>   2×. Tracked separately as a page-view double-fire.
> - **7 of 37 are singletons**, and 4 of those are `non-browser`/`inconsistent` verdicts or sit on
>   cloud/hosting ASNs (Shanghai UCloud AS23724, "365 Group" AS18450, RapidSeedbox AS214483).
>
> **The AECI-683 operator retro-join removes none of them** — verified, `operator_pair_matches = 0`
> over both days. So unlike 2026-08-26, this residual is not the operator; it is automation leaking
> through threshold gaps.
>
> **Three follow-ups this implies**, in descending value: (1) **AECI-742** — give the detector
> cross-day memory so a hash with a flagged history keeps a lower per-day bar (**shipped 2026-09-01**,
> see the addendum below); (2) **AECI-744** —
> treat `client_verdict` of `inconsistent`/`non-browser` as disqualifying on its own, with no
> cardinality floor (**shipped 2026-09-01**, see the addendum below); (3) **AECI-743** — fix the double-fire (**shipped 2026-09-01**, see the addendum below). None of them is a `DATACENTER_ASNS` widening — the standing rule that a human decides
> before an ASN joins that list still holds, and these are commercial proxy/seedbox providers rather
> than the consumer ISPs that rule exists to protect.

> **AECI-742 addendum (2026-09-01) — the largest bucket is closed, and it cost no collateral.**
> Follow-up (1) above shipped: `detectUaHashSwarms` now carries a **prior**. A hash flagged at full
> strength on `SWARM_PRIOR_MIN_FLAGGED_DAYS` (2) of the previous `SWARM_PRIOR_LOOKBACK_DAYS` (14)
> days is held to `SWARM_RECURRING_ASN_RATIO` (0.5) over `SWARM_RECURRING_MIN_VIEWS` (2) on the day
> being reported, instead of the standing 0.8 over 4. The prior is never built from a relaxed flag
> and never from the reported day itself, so the memory cannot ratchet; and the bar is lowered
> rather than removed, so a hash that settles onto one network is forgiven inside a fortnight.
>
> **Re-measured read-only against production D1**, replaying the two audited days under the new rule:
>
> | | 8/29 | 8/30 |
> |---|---|---|
> | Raw human page views | 87 | 70 |
> | Flagged as automation — before | 64 | 56 |
> | **Flagged as automation — after** | **72** | **66** |
> | **Residual (the headline)** | **23 → 15** | **14 → 4** |
> | Newly flagged | `02048353…` — 8 views, ratio 0.62, flagged on 7 of the prior 14 days | `53304b2e…` — 10 views, ratio 0.70, flagged on 8 of the prior 14 days |
>
> That is exactly the predicted 18 views, and **exactly those two hashes** — nothing else on either
> day changed. Swept across the 16 days to 2026-08-30 the relaxed bar adds 82 views in total, and
> **every hash it newly flags on any day is already one of the eight known swarm hashes**; not one
> hash outside that set is admitted. The remaining residual is the rest of this decomposition — the
> Oxylabs/Web2Objects scraper, the sub-`SWARM_MIN_VIEWS` cluster AECI-744 addresses, and the
> singletons.
>
> **Read the "after" numbers as a filter, not a headcount.** This closes a leak; it does not turn the
> residual into a floor of real people. The standing rule holds — nothing here writes `is_bot`, and
> no ASN joined `DATACENTER_ASNS` on this evidence.

> **AECI-743 addendum (2026-09-01) — the double-fire is fixed, and it was not the suspect anyone
> named.** Queried against production D1, both rows of the 8/29 pair are `navigation = 'arrival'`
> with `path = '/products/:slug'` and the product FK resolved — i.e. two full SSR cacheable-branch
> **cache-MISS renders**, not an SSR write racing a client `PageViewTracker` write. That suspect is
> ruled out structurally, not by inspection: the tracker sends `navigation = 'spa'`, and
> `classifyReferrer` maps any same-origin `Referer` to `Direct`, so a client row can never read
> `Google`. `handleSsr` fires `firePageView` at most once per invocation and runs once per request,
> so **the browser sent the document request twice** — a prerender, a double-click, or a
> HEAD-then-GET probe — and nothing in the stack refused the second row.
>
> **What changed for reading these numbers.** From 2026-09-01 ingest refuses a second row for the
> same `(concrete_path, user_agent_hash, cf_asn)` within ~10–20 s (`dedupe_key` + a UNIQUE index,
> migration `0020`), the SSR Worker no longer counts speculative (`Sec-Purpose: prefetch`/
> `prerender`) loads or non-GET requests, and the browser tracker no longer fires on a query-only
> re-navigation. Mechanism: `API_CONTRACTS.md` §6.9, "One document load, one row".
>
> **Two limits that must travel with any pre-2026-09 figure.** Rows written before the fix are
> **not** repairable — the stored row cannot distinguish a double-fire from two genuine arrivals —
> so every historical day may read slightly high.
> `scripts/ops/2026-09-page-view-duplicates/find-duplicates.sql` reports the suspects read-only;
> against production on 2026-09-01 it found 52 human `arrival` pairs, 23 human `spa` pairs and 589
> pairs with a null `navigation` (pre-AECI-585 rows, which cannot be attributed to a writer) inside
> the 20 s window. **The corroborated floor is affected on exactly two days**: 2026-08-29 (2 → 1)
> and 2026-08-18 (4 → 3). Both are corrected in `POST_LAUNCH_HEALTH_REPORT.md`.
>
> And the guard is a floor on precision, not a claim of exactness: bot-classified rows and rows with
> no `user_agent_hash` are deliberately left unconstrained, so a crawler's repeat fetches still count
> once each and the crawler tables stay a raw count.

## How to read the numbers (weekly, going forward)

Once the secrets are provisioned (config injected — verify with
`curl -s https://www.aecintegrations.com/ | grep -oE '__AECI_(POSTHOG|DD)__'`):

- **Weekly visitors + pageviews** — PostHog UI (Web Analytics / Insights), filter to production.
  Cross-check against the Datadog **Phase-2 Traffic** dashboard (top routes by request count; us5).
- **Signups** — **`/admin/audience`** (AECI-586). The authoritative count is still the
  `mailing_list` D1 table; that screen is now the read path for it, so the manual
  `wrangler d1 execute … "select count(*) from mailing_list"` is no longer the procedure
  (it still works, and is the fallback if the panel is down). The screen also carries
  growth and churn over a window, which the raw count never did — churn is *exact* there,
  because `unsubscribed_at` is a suppression record rather than a delete.
  Funnel/attribution has **two** sources now, and they answer different questions: the
  PostHog `mailing_list_signup` event covers the consented slice and knows the on-site
  `source` (which band the visitor used); `/admin/audience`'s UTM and geography
  breakdowns are **consent-independent**, cover every signup, and know where the visitor
  came from. Prefer the panel for "how many and from where", PostHog for "through which
  surface".
- **Top entry pages** — PostHog referrers/entry-path breakdown; or the server-side `page_views` D1
  table for a consent-independent view. Public routes only — `/admin/*` and `/account` are excluded
  (AECI-575); add `and path not in ('/admin','/account') and path not like '/admin/%' and path not like '/account/%'`
  to any ad-hoc query so it matches what the digest reports (the digest matches on an exact prefix
  boundary, so a bare `'/admin%'` would wrongly drop public look-alikes like `/administrators`).
  Add `and (is_operator is null or is_operator = 0)` as well — that is the second half of the same
  exclusion (§13 D13) and an ad-hoc query that applies only the path clause is still counting the
  operator's public-site browsing. Since §13 **D15** there is a **third** clause, the
  `(user_agent_hash, cf_asn)` retro-join — copy it verbatim from `DATABASE_SCHEMA.md` §9.1, which
  now carries the full three-clause block. Without it an ad-hoc query still counts every row the
  operator wrote while their session was lapsed, and those cluster on their own ISP, which is
  exactly the network the §3b census must not misread as automation.
- **Core Web Vitals** — Datadog **RUM → Performance / Core Web Vitals** for the `aeci` app (us5),
  filter `env:production` (LCP, CLS, INP). Thin sample pre-launch — re-read post-launch.

## Verification checklist (closes AECI-326 "Done when")

1. **Signup fires as a tracked event** — ✅ code: `home-closing-cta.ts` calls
   `Analytics.mailingListSignup({ source: 'home_closing_cta' })` on `created`; covered by the
   analytics + closing-CTA specs. (AECI-536 adds the `/updates` page firing the same event with
   `source: 'updates_page'`, covered by `updates.component.spec.ts`.)
2. **PostHog captures pageviews + signup** — gated on `POSTHOG_KEY` (CI-wired; set the GH secret,
   then confirm `__AECI_POSTHOG__` in the HTML and the event in the PostHog UI).
3. **Datadog RUM reports CWV** — gated on `DD_APPLICATION_ID` + `DD_CLIENT_TOKEN` (now CI-wired; set
   the GH secrets, then confirm `__AECI_DD__` in the HTML and CWV populating in the RUM app).
4. **Baseline written** — ✅ this document.

> **AECI-744 addendum (2026-09-01) — the verdict now flags on its own, with no view floor.**
> `client_verdict IN ('inconsistent','non-browser')` is direct evidence about *that request*, not a
> cardinality inference over a sample, so `detectNonBrowserClients` evaluates it **per row**: no
> grouping, no floor, no ratio. That reaches the two sub-threshold groups this baseline named — the
> `87012404…` trio (3 views, ASN ratio 1.00, under the 4-view floor by one) and the four singletons
> on cloud/hosting ASNs — i.e. **~7 of the 37 residual views**, which now leave the headline instead
> of being admitted as human on a technicality.
>
> Three properties to hold on to when reading a future residual against this one:
>
> - **The floors did not move.** `SWARM_MIN_VIEWS` and `ASN_ROTATOR_MIN_VIEWS` are both still 4, and
>   both groupings still exclude the trio. This is a third signal beside them, not a loosening of
>   either — so the 18-of-37 cross-day-memory gap (AECI-742) is untouched and still the largest item.
> - **NULL is still no evidence.** Every row written before 2026-08-26 has no verdict and counts as a
>   person. This baseline's caution against reading verdict coverage as complete stands.
> - **The number is filtered-vs-filtered on both sides.** The digest's prior-day comparison already
>   ran the detector over the prior window, so the first morning after this shipped shows a real
>   step down in both columns, not a manufactured one-day drop.
>
> Read-side only, as ever: no `is_bot` write, and RapidSeedbox AS214483 / Web2Objects AS62874 /
> UAB code200 AS27411 / Rockion AS199737 did **not** join `DATACENTER_ASNS`.
