# Edge request log and `page_views`: how the two fit together

**Version:** 0.1
**Date:** 2026-10-13
**Status:** Design proposal. Input to the ADR that epic [AECI-1196](https://linear.app/aec-integrations/issue/AECI-1196) owes, and the shared sequence with the Bot Management epic [AECI-1299](https://linear.app/aec-integrations/issue/AECI-1299) (§9). Nothing here is built. One decision is made (§1). Everything else is a proposal until that ADR accepts it. Where the ADR and this file disagree, the ADR wins.
**Related:** `docs/ANALYTICS.md` §5 (consent tiers), `docs/CACHE_STRATEGY.md` (gateway and `Renderer`), `docs/VENDOR_PLAN_DATA_READINESS.md` gap G0, AECI-1196 comment of 2026-10-02 (Cloudflare Basin names).

Cloudflare renamed its data platform to Basin on 2026-10-01. Pipelines is now Basin Pipelines, R2 Data Catalog is Basin Catalog and R2 SQL is Basin SQL. This file says "Logpush" for the per-request edge log and "the rollup" for the daily job that reads it.

## 1. Decision: keep `page_views`

Logpush does not replace our own page-view tracking. Chris decided this on 2026-10-13 after reviewing what Logpush cannot see (§2). Logpush is added beside `page_views`, not instead of it.

The question that started this was whether dropping `page_views` would let us turn the edge cache back on for demo and production. It would not need to. Caching only breaks one part of `page_views`, and that part has a small fix (§3).

## 2. What Logpush cannot replace

Logpush records every request that reaches Cloudflare's edge. It sees nothing that happens inside the app after the page loads.

### Lost outright

| What | Why Logpush cannot see it | Who depends on it |
|---|---|---|
| In-app navigations | A `routerLink` click never requests a document. It only fetches `/api/*` data. | Pages per visit, Vendor Performance counts, trending products |
| `navigation` (arrival or in-app) | Same cause | The digest's traffic-source table. Without it "Direct" mixes arrivals with in-app clicks again. |
| `is_operator` | The Worker verifies the admin session token and re-reads `profiles.role`. A log line can show a cookie was present, not that it was valid. | The filter that removed Chris's own browsing, 15% of human views on 2026-08-19 |
| `is_owner_visit` | Needs the session matched against vendor membership in D1 | Vendor Performance |
| Same-day data | The rollup is daily | Admin activity feed, swarm detection |

### Rebuildable in the rollup, at a cost

| What | How |
|---|---|
| `product_id`, `vendor_id`, pair and taxonomy ids | Map the logged path to an entity with the same parser `page_views` ingest uses. Retired slugs, 301s and the retraction "detach, keep the row" rule all apply. |
| `is_bot`, `bot_name` | Re-run our classifier on the full user agent. The log has the full string. `page_views` keeps only a hash. |
| Client signals (`sec-fetch-*`, `accept-language`, `sec-ch-ua`) | Logpush custom fields for those request headers. Believed to need Enterprise, which the zone now has. Not verified. |
| AS holder name | Believed absent from `http_requests`. Join the ASN to our ASN registry. Not verified. |
| Dedupe | The API refuses a repeat row for the same visitor and page inside `PAGE_VIEW_DEDUPE_WINDOW_MS`. Logs record every reload. The rollup must apply the same rule. |
| `ref_source`, `ref_token` | The query string is in the logged URI |

### History

Logpush records only from the day it starts. `page_views` goes back to launch. Keep it as the history.

### What Logpush adds

Cache hits. Visitors and AI assistants that never run JavaScript. Error responses. Full user agent, Cloudflare bot score, verified-bot category, TLS fingerprint.

## 3. The caching gap that exists today

Native Workers Cache sits on the `Renderer` entrypoint. The gateway (the `default` export in `apps/web/src/server.ts`) is uncached and runs on every request. The server-side arrival row is written by `firePageView` inside `Renderer`, so it fires only on a cache miss.

The browser `PageViewTracker` skips the first navigation, on the assumption that the server already counted it. On a cache hit nobody counts the landing page. This is live on staging, the only cached tier. Demo and production run uncached, so they are not affected yet. The tracker's own header comment still says the Worker covers cache hits. That stopped being true at WC-3.

Two fixes, either of which unblocks caching:

1. **The browser counts arrivals.** The tracker posts the first navigation too, and `Renderer` stops writing arrivals. The browser POST already goes through the SSR Worker, which adds the trusted `x-aeci-cf-*` context, so the enriched columns survive. Visitors that do not run JavaScript stop being counted in `page_views`. Logpush counts them instead.
2. **The gateway counts arrivals.** It runs on hits, so it can keep writing the server-side row. It knows the path but not the entity id, which only the resolver in `Renderer` knows.

Proposed: option 1, because it also carries the Ray ID (§4). The gap is tracked as [AECI-1297](https://linear.app/aec-integrations/issue/AECI-1297).

## 4. Joining the two on the Ray ID

A Ray ID is the id Cloudflare gives every request. It is in the `cf-ray` header and in every Logpush line. It belongs to one request, not to a visitor or a network. Fifty people behind one office IP get fifty different Ray IDs, and one person reloading gets a new one each time.

### Getting the page load's Ray ID to the browser

- JavaScript cannot read the response headers of the page it is running in.
- Printing the Ray ID into the HTML fails under caching. A cached page is one stored render, so every visitor served from cache would report the Ray ID of the request that filled the cache.
- `Server-Timing` is the one response header the browser exposes to JavaScript, through the Performance API (`PerformanceNavigationTiming.serverTiming`).

So the **gateway** adds `Server-Timing: cfray;desc="<ray>"` to every response, read from the inbound `cf-ray`. The gateway runs after the cache lookup, so the value is fresh per request and never stored in the cache. A zone Transform Rule was considered first. It is not needed, and Cloudflare documents that zone rules which modify a response before cache do not apply to Workers Cache.

This was proven on staging on 2026-10-14 (AECI-1303). The results are in §8. They fix four details:

- **Ray ID format.** The inbound `cf-ray` the gateway reads is the bare 16-hex id, for example `a4a350d8fbcde783`. The response `cf-ray` header adds a colo suffix (`a4a350d8fbcde783-CGK`). Logpush `RayID` has no suffix. So `desc` joins to Logpush as-is. Anything that compares against the response header strips everything from the dash.
- **Cloudflare adds no `Server-Timing` of its own** on a normal response on this zone. The exception is a managed-challenge 403, which carries `chlray;desc="<ray>"`. A challenged load never runs the gateway, so it never reports a `cfray` and never joins. That is correct.
- **What carries the stamp.** Every response that returns through gateway code: cached and uncached 200s, cached 404s, both kinds of redirect, HEAD, and POST. A Workers runtime exception (error 1101) never returns through gateway code, so it carries none. There is no 304 path today, because SSR responses send no `ETag` or `Last-Modified`.
- **The browser cache can replay a stamp.** Document responses send `max-age=0` with `stale-while-revalidate=60`. Firefox 150 applies that to page loads. A second load within the window got the stored page and the first load's Ray, with `navigation.type` still `navigate`. Chromium 148, Chrome 154 and WebKit 26.4 fetched fresh each time. See the repeat-view rule and the background-revalidation rule below.

The beacon then carries two Ray IDs:

| Ray ID | Source | Trust |
|---|---|---|
| Page load | `Server-Timing`, read by the tracker and sent in the payload | A client claim |
| Beacon request | `cf-ray` on the proxied `POST /api/page-views`, read by the SSR Worker | Trusted |

### Is `Server-Timing` a sound channel?

Yes. Browser monitoring tools (Datadog, New Relic, Elastic) use the same header to link a page load to its server-side trace. It is a W3C spec, readable in every current browser (Safari since 16.4). It is same-origin here, so no `Timing-Allow-Origin` is needed. The Ray ID is not secret. Cloudflare already sends it in `cf-ray`. The one stretch is that the spec was written for timings and we carry an id in `desc`. There is no purpose-built channel. The alternatives are a stale id in HTML, a per-response cookie that breaks the visitor-state-neutral cache rule, or fuzzy matching.

### Counting each visit once

Logpush holds all traffic, humans included. So the join defines the edge-only count:

> **Edge-only views** are successful HTML document requests in Logpush whose Ray ID is on no `page_views` row.

| Request | `page_views` | Logpush | Counted as |
|---|---|---|---|
| Human page load, beacon fired | Row with the page-load Ray ID | Document line | One view from `page_views`, enriched by the line |
| In-app click | Row | No document line. Only `/api` fetches and the beacon POST. | One view from `page_views` |
| Crawler, AI fetch, no-JS visitor | None | Document line | One edge-only view |

Rules the rollup must follow:

- Count only successful HTML documents. Exclude `/api/*`, beacon POSTs, assets and redirects.
- Join on Ray ID plus date and path, as a cheap guard against a reused id.
- **A dedupe-refused beacon must still record its Ray ID.** Otherwise the refused reload's log line matches nothing and becomes a phantom edge-only view. Either keep the refused Ray IDs or apply the same dedupe rule in the rollup.
- **A repeated Ray ID is a repeat view, never a new arrival. So is a `back_forward` navigation.** Each signal catches a case the other misses (AECI-1303). A bfcache restore or a browser-cached page replays the old `Server-Timing` entry, and the Firefox replay arrives as type `navigate`. A back navigation without bfcache refetches the page, so it carries a new Ray ID but still has type `back_forward`. Apply both.
- **A browser's background revalidation is not an edge-only view.** When Firefox serves a page under `stale-while-revalidate`, it refetches the page in the background. That refetch is a document line in Logpush with no beacon. Left alone it becomes a phantom edge-only view. Either the rollup excludes it, or document responses stop offering `stale-while-revalidate` to browsers. This is open question 7 in §7.
- A beacon with no Ray ID (old browser, extension, proxy) does not join. Its log line counts as edge-only.
- Some bots run JavaScript (Googlebot, headless scrapers). `page_views` still needs `is_bot`. The join improves it with Cloudflare's bot score.
- `page_views` is live and Logpush is daily. Same-day numbers come from `page_views` alone.
- Never add `page_views` totals to Logpush totals. Total reach is `page_views` arrivals plus edge-only views.

### If the `Server-Timing` stamp were not available

The fallback is matching page loads to beacons by IP, user agent, path and time. Two colleagues behind one office network, on the same browser build, opening the same page seconds apart, look identical to that match. One view is dropped or counted twice. The gateway stamp makes the fallback unnecessary.

### Shared code

The bot classifier and the path-to-entity parser (`parsePairPagePath` and its siblings) move to `@aeci/shared`. `page_views` ingest and the rollup both call them, so the two sources cannot label one request differently.

### What the rollup produces

1. Enrichment of matched `page_views` rows: cache status, bot score, verified-bot category, TLS fingerprint.
2. An edge-only table for unmatched documents, attributed to entities by the shared parser. It feeds the Vendor Performance §2.3 assistant-fetch line.
3. Daily beacon coverage: the share of human-looking document loads that produced a beacon. A drop means the tracker is broken. Nothing would show that today.

## 5. What an audit would raise

This section is not legal advice. Counsel should confirm the privacy items before the ADR is accepted.

### Privacy

| Finding | Why it matters | Proposed response |
|---|---|---|
| The join ties `page_views` rows to IP addresses | `page_views` is collected for every visitor without consent. That is defensible today because it holds no IP. A Ray ID join makes each row linkable to a full IP, which is personal data under GDPR. | Never write an IP to D1. Store only derived facts. Drop the Ray ID from the row once enrichment is done. |
| Raw logs hold full IP, user agent and referrer | That contradicts our own choice to hash the user agent and keep only the referrer host | Choose Logpush fields deliberately. Basin Pipelines SQL can hash or drop `ClientIP` at ingest. Put a lifecycle rule on the raw bucket. |
| The beacon may need consent in the EU | EU guidance treats JavaScript tracking beacons as reading from the device. First-party audience measurement can be exempt if it is aggregate only, never cross-site, and kept for a limited time. | Keep `page_views` inside those conditions and write the reasoning down |
| Disclosure | The privacy policy must describe Cloudflare request logging and first-party analytics, and retention for each | Update the policy and the record of processing before Logpush goes live |

### Security and data integrity

| Finding | Why it matters | Proposed response |
|---|---|---|
| The beacon trusts a client-supplied page-load Ray ID | A forged id could claim a bot's line as a human view or block a real join | Validate the format at ingest. In the rollup, accept a join only when the page-load line and the beacon's own trusted line share the same IP (or IP hash) and user agent. |
| `Server-Timing` on every page | Scanners often flag it as information disclosure, low or informational severity | Record an exemption in `docs/CODE_REVIEW_EXEMPTIONS.md` when it ships. The Ray ID is already public in `cf-ray`. |

### Vendor trust

Vendors see view counts. The design makes each count traceable to a beacon row or an edge line, with Cloudflare's bot score behind the bot exclusion. Counts before and after the switch are not directly comparable. Publish the date the method changes.

## 6. Consent-tiered storage

Proposal from Chris, 2026-10-13: keep the raw edge log and the raw beacons in separate short-lived R2 buckets. The daily combine writes detail to D1 only for visitors who accepted tracking.

```
Edge request ──► R2 edge-raw    (Logpush, every request)        ┐
                                                                  ├─► daily combine ──► D1
Browser beacon ─► R2 beacon-raw (path, Ray IDs, consent state)   ┘
                 both buckets: lifecycle delete after N days
```

Cloudflare logs a request before the visitor has chosen anything. Separate buckets do not avoid collecting the IP. They limit how long it lives and where it can go.

### Consent signal

The beacon adds `consent: granted | denied | undecided`, taken from the Tier 3 choice (`docs/ANALYTICS.md` §5). The Worker also reads `Sec-GPC` and `DNT` on the request. Those are a hard deny today and override the beacon. Logpush custom fields can capture `Sec-GPC` too, so edge-only rows can honour it.

### What the combine writes

| Visitor | Written to D1 |
|---|---|
| Accepted tracking | A detailed row: path, entity, navigation, referrer source, country, ASN, bot score, cache status. Still no IP and no full user agent. |
| Declined, undecided, or GPC/DNT | No row. Increments to daily counters keyed by date, path or entity, bot or human, navigation and country. |
| Verified crawlers | Detailed rows. Crawlers are not people. This feeds the assistant-fetch line. |
| No JavaScript, not a verified bot | Counters only. No consent signal exists. |

Work that needs raw detail runs inside the combine, before the raw buckets expire: the Ray ID join, swarm detection, the operator filter and owner visits. Their results reach the counters as flags.

### Options for the non-consented tier

1. **Counters only.** The most defensible option. No unique-visitor count for this tier.
2. **Daily-rotating hash.** Store `hash(IP + user agent + today's secret)` and destroy the secret at midnight. This gives unique visitors per day with no lasting identifier. Plausible and Fathom use this model. Several EU regulators accept it without consent.
3. **Detail only in PostHog.** PostHog already holds consented detail. D1 keeps counters for everyone and no second detail store. Less to build, but D1 can no longer answer per-visitor questions.

Proposed: option 1 or 2 for the non-consented tier, plus detailed consented rows in D1.

### Problems to design for

- **The landing view happens before the banner is answered.** Hold the arrival beacon until consent resolves or the page hides, then send it with `sendBeacon`. Otherwise every landing is `undecided`.
- **Consent withdrawal.** Detailed rows must be deletable. That needs a random visitor id stored only for consented visitors, in the Tier 3 storage they accepted. Never reuse the PostHog id. That would join the two systems.
- **About 1 in 8 visitors consents.** Features built on per-visitor rows shrink to that slice: the admin activity feed, Vendor Performance detail and trending. Each must move to counters or be labelled as a consented-slice number. This is the largest product cost.
- **Live features become daily** if beacons go to R2 first. Keep a minimal live D1 counter written at beacon time if the admin feed must stay live.
- **The raw buckets need a legal basis and retention.** Security and bot detection under legitimate interest is the usual basis. A 7 to 30 day lifecycle. A line in the privacy policy.

## 7. Open questions for the ADR

1. Option 1 or option 2 in §3: browser or gateway writes arrivals?
2. Which consent tier model in §6, and which option for the non-consented tier?
3. Raw bucket retention, and whether `ClientIP` is dropped, hashed or kept at ingest.
4. Which features move to counters, and which are relabelled as consented-slice numbers?
5. Does the Enterprise contract include Bot Management? Scores started on 2026-10-12, but every stored score is a constant 99 (AECI-1298). The contract question is AECI-1300.
6. Why was caching ruled off for demo and production on 2026-10-08 (AECI-1240)? If the reason was `page_views`, §3 removes it. If not, this design does not unblock caching.
7. Browser background revalidation (§4). Should document responses drop `stale-while-revalidate` for browsers, or should the rollup exclude revalidation requests? AECI-1303 saw Firefox use it. We do not know yet whether Logpush can tell a background revalidation from a page load.

## 8. Checks before relying on any of this

| Check | How |
|---|---|
| Gateway stamp is fresh on a hit (AECI-1303) | **Done 2026-10-14. Go.** A spike deployed to staging, then rolled back. Five requests to one `/products` URL (one MISS, four HITs) carried five different Ray IDs. Each `desc` equalled its own `cf-ray` without the colo suffix. HEAD, a cached 404, both redirect kinds and a POST carried the stamp too. Chromium 148, real Chrome 154, Firefox 150 and WebKit 26.4 (the Playwright builds) all read it through `serverTiming`. Real Safari was not tested, because Access blocked the automated session. The findings are in §4. |
| Custom fields and AS holder name (AECI-1304) | Read the current `http_requests` field list and the custom-field plan limits |
| Gateway coverage | A unit test that every gateway response, redirects and errors included, carries the header |
| Stored bot score is the visitor's (AECI-1298) | Join a day of Logpush to `page_views` by Ray ID and compare `BotScore` with `cf_bot_score` (AECI-1304) |

## 9. Sequencing with Bot Management

The Logpush work (AECI-1196) and the Bot Management change (AECI-1299) are one sequence. Six couplings tie them:

1. Logpush records Cloudflare's own bot score per request. It is the ground truth for our stored score (AECI-1298) and for judging the shadow run.
2. Both need the Ray ID on `page_views` rows.
3. Moving the arrival writer to the browser (AECI-1297) changes the classifier's inputs. It must land before the shadow run starts, or the comparison mixes two regimes.
4. Both change the human page-view number. They ship under one published method-change date, not two.
5. Retiring our bot detectors needs a trusted score. Retiring the GraphQL history pulls needs Logpush running.
6. The ingest classifier and the Logpush rollup call the same shared code.

### Now (no design dependency)

| Id | Issue | Why now |
|---|---|---|
| N1 | AECI-1300: Bot Management entitlement, cost, Logpush account | Blocks the Logpush spike and any purchase decision |
| N2 | AECI-1302: verify retention, refresh history pulls before 2026-10-31 | Done 2026-10-13. New zone keeps 90 days of requests, 31 of firewall events. Pulls refreshed across the zone move |
| N3 | AECI-1301: Ray ID and verified-bot fields on `page_views`. **Shipped** (migration `0072`: `cf_ray`, `cf_verified_bot`, `cf_verified_bot_category`) | Additive. Unblocks AECI-1298 diagnosis and the join. |
| N4 | Freeze, recorded on AECI-1299 | No new hand-built heuristics. Nothing reads `cf_bot_score`. |

### Before (spikes and decisions)

| Id | Issue | Depends on |
|---|---|---|
| S1 | AECI-1298: why the stored score is a constant 99 | N3 helps |
| S2 | AECI-1303: gateway `Server-Timing` stamp on a cache hit. **Done 2026-10-14: go** (§8) | none |
| S3 | AECI-1304: one day of Logpush through Basin, Ray ID join, score comparison | N1, N3 |
| S4 | AECI-872: agree the classification procedure and shadow thresholds. **Done 2026-10-14: D19 agreed; the classifier and shadow runner are built** | none |
| S5 | AECI-1196 ADR, with counsel on the privacy items | S2, S3 |

### During (filed after the ADR)

| Id | Step | Epic |
|---|---|---|
| D1 | Logpush production capture, lifecycle rule, backfill load | AECI-1196 |
| D2 | Bot classifier and path-to-entity parser move to `@aeci/shared` | AECI-1299 |
| D3 | Arrival writer move and page-load Ray ID (AECI-1297) | AECI-1196 |
| D4 | Shadow classifier for 2 to 4 weeks on AECI-872's machinery, cross-checked against Logpush | AECI-1299 |
| D5 | Daily rollup: enrichment, edge-only table, beacon coverage, AI-assistant fetches. Retire the GraphQL pulls and the WAF poll. | AECI-1196 |
| D6 | Cutover with one published method-change date | both |
| D7 | Retire swarm detection, `client_verdict`, `DATACENTER_ASNS`, the referrer floor and the PostHog second-opinion lines, one per PR | AECI-1299 |
| D8 | Consent-tiered storage, if the ADR adopts it | AECI-1196 |

D3 also removes the `page_views` objection to edge caching. The caching ruling (AECI-1240) stays a separate decision.
