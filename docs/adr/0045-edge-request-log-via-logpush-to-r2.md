# ADR 0045: An edge request log via Logpush to R2, with no rollup

- Status: Accepted
- Date: 2026-10-22
- Issue: AECI-1446 (epic AECI-1196)
- Follow-ups: AECI-1447 (create the bucket, the jobs and the notification), AECI-1448 (final history pull, backfill copy, delete `aeci-views-temp`), AECI-1304 (Ray ID join spike) and AECI-1330 (gateway `Server-Timing` stamp), both parked
- Relates to: ADR 0041 (the raw page-view store, a different thing); ADR 0036 (The WBS Project account); `docs/design/edge-log-and-page-views.md` §7 Q3, Q5, §9; `docs/waf-rate-limits.md` §3b, §5

## Context

Cloudflare keeps the zone's per-request record for 90 days and its firewall events for 31 days (verified 2026-10-13, AECI-1302). After that the detail is gone. Until now the only history beyond that window is a set of manual GraphQL pulls in the temporary bucket `aeci-views-temp` (`scripts/ops/2026-10-traffic-history/`, `scripts/ops/2026-10-ai-assistant-fetch-history/`). Each pull has a deadline, and a missed one loses days for good.

`page_views` and the ADR 0041 raw store see only the requests that reach `capturePageView`. Since AECI-1297 the gateway writes every arrival, cache hit or not, so cached pages are counted. They still miss assets, API calls, redirects, errors and everything the WAF blocked. Cloudflare's own record is the only consent-independent source for AI-assistant fetches and AI referrals (`docs/VENDOR_PLAN_DATA_READINESS.md` G0).

The first version of epic AECI-1196 proposed Logpush into Basin Pipelines and the R2 Data Catalog, a daily D1 rollup, a Ray ID join to `page_views` and consent-tiered storage (`docs/design/edge-log-and-page-views.md` §4 to §6). Nothing reads that output yet. Bot Management is not licensed (AECI-1300, ruled 2026-10-21), so the Logpush bot fields carry no usable value. The v2 epic, ruled 2026-10-21, keeps only the store.

## Decision

1. **Two Logpush jobs write gzip NDJSON to one R2 bucket, `aeci-edge-log-production`, on The WBS Project account.** One job per dataset: `http_requests` under `http_requests/{DATE}/` and `firewall_events` under `firewall_events/{DATE}/`. Output is ndjson with RFC 3339 timestamps and a sample rate of 1. A Logpush job covers the whole zone, so the log holds every `aecintegrations.com` host: `www.`, the apex, `demo.` and `staging.`. Filter on `ClientRequestHost` to read one tier. There is one bucket, not one per tier.
2. **The `http_requests` job takes every field except `ClientIP` and the Bot-Management-only set.** The excluded set is `BotScore`, `BotScoreSrc`, `BotTags`, `BotDetectionTags`, `BotDetectionIDs`, `JA4`, `JA3Hash`, `JA4Signals` and `JSDetectionPassed`. `VerifiedBotCategory` is kept, because Cloudflare fills it without Bot Management. `RequestHeaders` is kept and filled by one custom-fields rule (phase `http_log_custom_fields`, expression `true`) naming nine request headers: `sec-gpc`, `dnt`, `sec-fetch-mode`, `sec-fetch-site`, `sec-fetch-dest`, `accept-language`, `sec-ch-ua`, `sec-ch-ua-mobile` and `sec-ch-ua-platform`.
3. **The `firewall_events` job takes every field except `ClientIP`.** It carries `ClientASNDescription`, the AS holder name `http_requests` lacks.
4. **No raw IP is stored.** `ClientIP` is omitted from both jobs. Grouping captured page views by IP stays possible later, through the Ray ID and ADR 0041's monthly `ip_hash`. That join is not built (item 9). This answers `docs/design/edge-log-and-page-views.md` §7 Q3 for the Logpush bucket.
5. **The bucket deletes objects after 400 days through an R2 lifecycle rule.** That matches ADR 0041 and the privacy policy.
6. **Bot Management is not used.** Nothing reads a Logpush bot field as a signal, and our own classifier stays the only one (`docs/waf-rate-limits.md` §3b). Vendor-maintained verdicts (Turnstile, AECI-1457; Monocle, AECI-1459) become inputs to that classifier, not a second one. Re-open when Bot Management is bought (AECI-1299).
7. **Reads are ad hoc, with DuckDB over R2's S3 API.** It is the ADR 0041 recipe with `read_json` in place of `read_parquet` (`docs/ANALYTICS.md` §11a). No Pipelines, no Data Catalog, no Basin SQL, no Worker binding.
8. **An agent creates the jobs through the zone Logpush API, with a one-off token Chris creates and then revokes.** Wrangler cannot create Logpush jobs. The one-off token needs zone Logs Edit only. The jobs write with a second, long-lived credential: an R2 API token with Object Read & Write scoped to this bucket. Its S3 access key id and secret go into each job's `destination_conf`, which Cloudflare stores. That R2 token must never be revoked, or both jobs fail and Cloudflare disables them. Nothing is stored in the repo or on a Worker. Job ids and settings are recorded in `docs/environments.md` (AECI-1447).
9. **No daily rollup, no D1 table and no Ray ID join.** The `http_requests` `RayID` field is in the log, so the join can be built later without changing the jobs.
10. **Job health is Cloudflare's "Logpush job disabled" notification to Chris's email, not a CI check or a PostHog alert.** The runbook is `docs/RUNBOOKS.md` "Logpush job disabled".
11. **The hourly WAF GraphQL poll stays** (`docs/waf-rate-limits.md` §5). The log is a store, not an alerting path. The poll retires only when a reader of the log exists.
12. **Cost.** Logpush is available on every plan and billed at $0.03 per GB delivered to R2 after 25 GB a month per account. R2 storage is $0.015 per GB-month. Our volume is about 1 to 2 GB a month. Whether the free startup Enterprise plan changes these terms is not confirmed.

## What is never stored

- The client IP address, in either dataset.
- The Bot Management score, its source and tags, and the JA3 and JA4 TLS fingerprints.
- Cookies, the `authorization` header and every request header outside the nine in item 2.
- Response bodies.

**What is stored as sent.** Logpush cannot strip a query parameter. The request URL and the `Referer` keep their full query string, unlike ADR 0041's envelope, which removes secret parameters. Two single-use secrets land in the log this way: the claim confirm link (`/claims/confirm?token=…`, single-use, 7 days, ADR 0043) and the Supabase sign-in `?code=` (single-use, minutes). Both are dead long before anyone reads the log. Ruled 2026-10-22 (Chris): keep full URLs and say so in the privacy policy.

## Consequences

- The privacy policy discloses the edge request log, its 400 days, the full addresses and the absence of the IP (`apps/web/src/content/legal/privacy-policy.md`). Counsel's confirmation of the legal basis and retention is still owed (epic AECI-1196).
- Logpush captures from the day a job starts. It never back-fills. A disabled job leaves a gap that only a GraphQL pull can fill, within 31 days for firewall events and 90 days for requests.
- The manual pulls and their deadlines stay until AECI-1448 closes the gap to the first Logpush day and copies the backfill into `graphql-backfill/` in this bucket.
- `docs/VENDOR_PERFORMANCE_SPEC.md` §2.3 item 3 (assistant fetches on their own line) has a permanent source but still no reader.
- Deferred to a later epic: the daily rollup and the §2.3 assistant-fetch reader; the Ray ID join, the gateway `Server-Timing` stamp, the edge-only table and beacon coverage (AECI-1304, AECI-1330); consent-tiered storage; retiring the WAF poll and the pull scripts.
- Re-open trigger: a reader of the log is needed, Bot Management is bought (AECI-1299), or AECI-1457 chooses the Ray ID route, which revives AECI-1330.
