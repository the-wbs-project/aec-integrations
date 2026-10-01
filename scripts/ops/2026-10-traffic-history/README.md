# 2026-10 traffic history backfill (AECI-1169)

Everything Cloudflare still held about traffic to the `aecintegrations.com` zone on
2026-10-01, saved before its retention window drops it. Logpush only captures traffic from the
day it is switched on, so these files are the only source for anything earlier.

**This is staging, not a home.** The plan is to parse these files into the R2 Iceberg table
AECI-1169 builds, then delete them from the tree. Deleting them will not shrink the repo: once on
`main`, they stay in git history. That is why every file is gzipped.

No client IP addresses were requested. User agents, networks (ASN) and countries are kept.

| Dataset | Source (GraphQL) | Covers | Grain | What it is |
|---|---|---|---|---|
| `http-requests/` | `httpRequestsAdaptiveGroups` | 31 days | Hour | Every request at the edge, all hosts, all content types. Path, query, status, user agent, verified bot, network, country, device, referrer host, cache status, WAF action, timing |
| `firewall-events/` | `firewallEventsAdaptiveGroups` | 3 days | Hour | WAF and bot actions: which rule, which request |
| `daily-rollup/` | `httpRequests1dGroups` | 2026-04-08 on | Day | Per-zone totals: requests, page views, uniques, bytes, threats. Country, status, browser, content-type and IP-class breakdowns as JSON |
| `rum-pageloads/` | `rumPageloadEventsAdaptiveGroups` | 184 days | Hour | Cloudflare Web Analytics beacon. Real browsers only, because it needs JavaScript. Path, referrer, country, device, browser, OS |
| `rum-web-vitals/` | `rumWebVitalsEventsAdaptiveGroups` | 184 days | Day | Core Web Vitals per path (LCP, INP, CLS, TTFB): good / needs-improvement / poor counts and p75. FCP is in `rum-performance`, because account queries cap at 30 fields |
| `rum-performance/` | `rumPerformanceEventsAdaptiveGroups` | 184 days | Day | Page load timings per path: averages, p50, p75, p95 |

`daily-rollup` holds about a year, but the zone's history starts on 2026-04-08. The RUM datasets
only hold what the beacon recorded, and it covers all hosts in the account.

## File layout

`<dataset>/<YYYY-MM>.csv.gz`, one file per UTC month. Read one with:

```bash
gzcat scripts/ops/2026-10-traffic-history/http-requests/2026-09.csv.gz | head
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

Needs `CF_READONLY_API_TOKEN` with zone and account Analytics: Read. It is read-only.

```bash
node scripts/ops/2026-10-traffic-history/pull.mjs
```

Pass dataset names to pull only those. A re-run never overwrites an existing month file. It
writes `<YYYY-MM>.pulled-<date>.csv.gz` beside it, because the older file may hold days the new
pull can no longer reach. When combining, de-duplicate on the dimension columns and prefer the
newer file for any day both contain. Windows that return the 10,000-row page limit are split
until they don't.

The AI-assistant subset from the same day is in `../2026-10-ai-assistant-fetch-history/`.
