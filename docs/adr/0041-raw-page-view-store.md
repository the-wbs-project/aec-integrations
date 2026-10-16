# ADR 0041: A raw page-view store in R2, beside D1

- Status: Accepted
- Date: 2026-10-16
- Issue: AECI-1384
- Follow-ups: AECI-1385 (retention review, due 2027-04-01), AECI-1386 (DNT and GPC gap, Bugs)
- Relates to: `docs/design/edge-log-and-page-views.md` §5, §6, §7 Q3; ADR 0022 (page views are a log-class write)

## Context

`page_views` keeps derived facts only. When we changed what a row stores (AECI-585, AECI-1301), every earlier row was stuck with the old shape. The 2026-09-07 gateway defect nulled eight columns on every arrival, and those days could not be rebuilt (`docs/CACHE_STRATEGY.md` §4a).

The fix is a copy of what the API received, kept outside D1, so a future change to the row can be back-filled from source.

`docs/design/edge-log-and-page-views.md` §6 proposes something larger: consent-tiered raw buckets with a 7 to 30 day lifecycle, fed by Logpush. That design is not built and its questions (§7) are open.

## Decision

1. **Every capture that reaches `capturePageView` writes one raw JSON envelope to a Cloudflare Pipelines stream.** The sink is Parquet in R2. The envelope carries the request body, the received headers, the whole `request.cf`, the eyeball URL, the outcome and the values the API derived. The shape is `RawPageViewEnvelope` in `packages/shared/src/api/page-view-raw.ts`.
2. **The write happens after the D1 outcome is known, in its own `try`, and never changes that outcome.** The five outcomes are `inserted`, `conflict`, `deduped`, `sampled_out` and `failed`. A body that fails validation is a 400 before `waitUntil` and produces no envelope.
3. **The raw copy ships ahead of the consent-tiered design and does not follow it.** This is a deliberate divergence from §6. It is a backup store beside D1, not the raw tier §6 describes. It holds every visitor, with no consent signal, for 400 days.
4. **The 400-day retention is known privacy debt.** §6 asks for 7 to 30 days. We chose 400 days so a year-on-year rebuild is possible. Chris accepted the gap on 2026-10-16. The review is AECI-1385, due 2027-04-01. It must either shorten the lifecycle or record a legal basis.
5. **The Ray ID stays on the `page_views` row.** §5 proposed dropping it once enrichment was done. We keep it, because it is the join key between D1 and the raw store, and Logpush later. The mitigation is that no raw IP is in D1 and the raw store holds only a monthly-keyed hash.
6. **The IP is stored only as `ip_hash`.** It is `HMAC(HMAC(PAGE_VIEW_IP_HASH_SECRET, 'YYYY-MM' in UTC), ip)`. The same address hashes the same within a month and differently across months. With no secret the hash is null. There is no unkeyed fallback, because a bare SHA-256 of an IPv4 address is reversible by enumeration.
7. **Plain Parquet in R2, not a Data Catalog (Iceberg) sink.** A plain sink lets an R2 lifecycle rule delete old objects. A catalog sink would need snapshot expiry as well, and R2 SQL reads Iceberg only. The cost is that we read the store with DuckDB over R2's S3 API (`docs/ANALYTICS.md`).
8. **The whole `request.cf` crosses the service binding base64 encoded.** The header is `x-aeci-cf-raw`. Raw JSON throws in `Headers.set` on a non-Latin-1 city name, which would kill the write. The API refuses to decode more than 16 KB.
9. **Two more trusted headers carry the eyeball URL and IP.** `x-aeci-eyeball-url` is set on the arrival path only. `x-aeci-client-ip` is set on both. The proxy path strips client copies of all three before setting its own. None feeds a `page_views` column. `docs/API_CONTRACTS.md` §6.9 has the contract.

## What is never stored

- `cookie` and `authorization` headers.
- Every `cf-access-*` header. On staging, Cloudflare Access adds a session JWT and the user's email, and CI sends its service token. The proxy path forwards the browser's headers as they came, so the family is dropped by prefix.
- Any IP-bearing header: `cf-connecting-ip`, `cf-connecting-ipv6`, `cf-pseudo-ipv4`, `true-client-ip`, `x-forwarded-for`, `x-real-ip` and `x-aeci-client-ip`.
- Secret query parameters in `eyeball_url` and `headers.referer`: `code`, `token`, `access_token`, `refresh_token`, `state`, `key`, `api_key`, `session`, and any name matching `secret`, `password` or `auth`.

## Consequences

- The store is per environment: `aeci-page-views-raw-staging` and `aeci-page-views-raw-production`. Demo and local dev have no binding, so the write is counted as `skipped`.
- The metric is `aeci.pageviews.raw`. The alert `pageviews-raw-unsent` fires on any `failed` or `skipped` in an hour. A missed capture cannot be back-filled.
- A raw write failure never shows in `aeci.pageviews.write`. That metric is unchanged.
- Pipelines needs Workers Paid. Expected cost is under $1 a month.
- The privacy policy discloses the log and the 400-day period (`apps/web/src/content/legal/privacy-policy.md`).
- Visitors who send DNT or Sec-GPC are still captured. That gap is AECI-1386.
- Q3 of the edge-log design is answered for this store only. It is still open for the Logpush raw buckets.
- Re-open trigger: AECI-1385's review, or the consent-tiered design being built.
