# 2026-10 traffic history backfill (AECI-1169)

> **The data files are in R2 only.** They were removed from the tree on 2026-10-01, after every file
> in R2 was downloaded and matched by SHA-256. They remain in this branch's git history up to commit
> `fe0055a6`. See "Copy in R2" below for the bucket and a download command.

Everything Cloudflare still held about traffic to the `aecintegrations.com` zone on
2026-10-01, saved before its retention window drops it. A second pull on 2026-10-13 covers the
days after it, across the zone move; see "Refresh 2026-10-13" below. Logpush only captures traffic from the
day it is switched on, so these files are the only source for anything earlier.

**This is staging, not a home.** The plan is to parse these files into the R2 Iceberg table
AECI-1169 builds, then delete the temporary bucket.

No client IP addresses were requested. User agents, networks (ASN) and countries are kept.

| Dataset | Source (GraphQL) | Covers | Grain | What it is |
|---|---|---|---|---|
| `http-requests/` | `httpRequestsAdaptiveGroups` | 31 days (90 on the new zone) | Hour | Every request at the edge, all hosts, all content types. Path, query, status, user agent, verified bot, network, country, device, referrer host, cache status, WAF action, timing |
| `firewall-events/` | `firewallEventsAdaptiveGroups` | 3 days (31 on the new zone) | Hour | WAF and bot actions: which rule, which request |
| `daily-rollup/` | `httpRequests1dGroups` | 2026-04-08 on | Day | Per-zone totals: requests, page views, uniques, bytes, threats. Country, status, browser, content-type and IP-class breakdowns as JSON |
| `rum-pageloads/` | `rumPageloadEventsAdaptiveGroups` | 184 days | Hour | Cloudflare Web Analytics beacon. Real browsers only, because it needs JavaScript. Path, referrer, country, device, browser, OS |
| `rum-web-vitals/` | `rumWebVitalsEventsAdaptiveGroups` | 184 days | Day | Core Web Vitals per path (LCP, INP, CLS, TTFB): good / needs-improvement / poor counts and p75. FCP is in `rum-performance`, because account queries cap at 30 fields |
| `rum-performance/` | `rumPerformanceEventsAdaptiveGroups` | 184 days | Day | Page load timings per path: averages, p50, p75, p95 |

`daily-rollup` holds about a year, but the zone's history starts on 2026-04-08. The RUM datasets
only hold what the beacon recorded, and it covers all hosts in the account.

## File layout

`<dataset>/<YYYY-MM>.csv.gz`, one file per UTC month. Download one (see "Copy in R2"), then read it with:

```bash
gzcat http-requests-2026-09.csv.gz | head
```

Columns are the GraphQL field paths joined with `_`, such as `dimensions_clientRequestPath` or
`sum_visits`. A row is one unique combination of the dimensions, with its metrics. Counts are
Cloudflare's sample-adjusted estimates, so small numbers are approximate. The first and last
day of each dataset are partial.

## Reading it

- **Filter `http-requests` to `dimensions_requestSource = eyeball` for visitor traffic.** The
  dataset also holds our own Workers' outbound calls (`edgeWorkerFetch`, mostly to
  `us.i.posthog.com`), which were 542,111 of September's 1,292,893 requests. Eyeball
  requests reconcile with `daily-rollup` (about 737k against 733,903 for September).
- **Bots are in `http-requests`.** Use `dimensions_verifiedBotCategory` for verified crawlers and
  assistants. Unverified automation is not flagged. Filter on user agent and network instead.
- **Real browsers are in `rum-*`.** These are the closest thing to human page views Cloudflare has.
- **Non-production hosts are included.** Filter `dimensions_clientRequestHTTPHost` or
  `dimensions_requestHost` to `www.aecintegrations.com` for the public site.
- **`daily-rollup` page views count bots.** Use it for volume trend, not human traffic.

## Re-run

Needs `CF_READONLY_API_TOKEN` with zone and account Analytics: Read. It is read-only. The token
in Conductor's environment reads the live zone on The WBS Project account.

```bash
node scripts/ops/2026-10-traffic-history/pull.mjs
```

The script defaults to the live zone (`2246ff6d…`). It reads each dataset's reach from
Cloudflare's own `notOlderThan` setting at run time, so it pulls 90 days of requests on the
Enterprise zone, and skips a dataset whose setting is 0. `CF_ZONE_TAG`, `CF_ACCOUNT_TAG` and
`OUT_DIR` point it at another zone and output directory.

Pass dataset names to pull only those. A re-run never overwrites an existing month file. It
writes `<YYYY-MM>.pulled-<date>.csv.gz` beside it, because the older file may hold days the new
pull can no longer reach. When combining, de-duplicate on the dimension columns and prefer the
newer file for any day both contain. Windows that return the 10,000-row page limit are split
until they don't.

The AI-assistant subset from the same day is in `../2026-10-ai-assistant-fetch-history/`.

## Refresh 2026-10-13 (AECI-1302)

The zone moved to The WBS Project account on 2026-10-04 and got a new zone id. Cloudflare
analytics do not follow a moved zone, so the record is split:

| Zone | Status | Holds requests from | Retention seen on 2026-10-13 |
|---|---|---|---|
| `32f7aec29792163c443b6c40f5fb9a56` (AEC Integrations account) | `moved` | up to 2026-10-04T04:30Z | Requests 31 days. Firewall events 0. Daily rollup 365 days |
| `2246ff6dadcf91ea2d8a0160427b23ac` (The WBS Project account) | `active`, Enterprise | 2026-10-04T04:00Z on | Requests 90 days. Firewall events 31 days. Daily rollup 365 days |

The two overlap for half an hour and leave no gap. The old zone's history ends on its own about
2026-11-03, when its 31 days run out and ADR 0036 deletes what is left on the old account.

**The old zone answers with a reduced field set.** It refuses `datetimeHour`, host, query
string, ASN, referrer host and `securityAction`. `pull-moved-zone.mjs` pulls what it still gives,
at 15-minute grain, one host at a time. Its daily totals matched the unfiltered API count exactly
for every day from 2026-09-30 to 2026-10-04. Query string and network are lost
from the end of the 2026-10-01 backfill to 2026-10-04T04:00Z. Only the wrangler OAuth login could read the old
zone on 2026-10-13; the Conductor token reads only the new account.

**Cloudflare Web Analytics has a gap from 2026-10-04 to 2026-10-14 (AECI-1307).** The beacon's last page load
on the old account is 2026-10-03. Web Analytics is a per-zone dashboard setting, and it did not
follow the zone move. The new account recorded no `aecintegrations.com` page loads until automatic
setup was turned on again for the new zone.

| | |
|---|---|
| Gap starts | 2026-10-04 (UTC) |
| Gap ends | 2026-10-14, when automatic setup was turned on again. That day is partial |
| Cause | Web Analytics was not turned on again on the new zone after cutover |

No `rum-*` data exists for the gap, and none can be recovered. `http-requests` still covers those
days, but it counts bots too. The old account's 184 days were pulled in this refresh, before ADR
0036's deletion.

What was pulled, under `cloudflare-backfill-2026-10-13/`:

| Prefix | Contents |
|---|---|
| `old-zone-32f7aec2/2026-10-traffic-history/http-requests/` | `2026-09.moved-zone.csv.gz`, `2026-10.moved-zone.csv.gz`: 2026-09-30 to 2026-10-04T06:00Z, reduced fields |
| `old-zone-32f7aec2/2026-10-traffic-history/{daily-rollup,rum-*}/` | Daily rollup since 2026-04-08 and Web Analytics from the old account, full fields |
| `new-zone-2246ff6d/2026-10-traffic-history/` | All six datasets from the new zone, full fields. The `rum-*` files hold other WBS sites only |
| `new-zone-2246ff6d/2026-10-ai-assistant-fetch-history/fetches-new-zone.csv` | 571 rows, 1,487 requests, 222 verified |
| `old-zone-32f7aec2/2026-10-ai-assistant-fetch-history/` | Empty. The AI query needs fields the old zone refuses. Filter the old-zone `http-requests` on user agent instead |

**Next deadlines, until Logpush runs (AECI-1196):**

- Firewall events keep 31 days. Re-run `pull.mjs firewall-events` before 2026-11-12.
- Requests keep 90 days. Re-run `pull.mjs` and the AI pull before 2027-01-01.

## Copy in R2

The 2026-10-13 refresh sits under `cloudflare-backfill-2026-10-13/`, same bucket. Uploaded on
2026-10-01 to the temporary bucket `aeci-views-temp` on **The WBS Project** account
(`004dc1af737b22a8aa83b3550fa9b9d3`), under the prefix `cloudflare-backfill-2026-10-01/<this directory>/`.
Download with your wrangler OAuth login and the target account set, run from a directory with no
`wrangler.jsonc` (the repo's configs pin the AEC Integrations account and override the variable):

```bash
cd /tmp && env -u CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID=004dc1af737b22a8aa83b3550fa9b9d3 npx wrangler r2 object get aeci-views-temp/cloudflare-backfill-2026-10-01/2026-10-traffic-history/daily-rollup/2026-09.csv.gz --remote --file daily-rollup-2026-09.csv.gz
```
