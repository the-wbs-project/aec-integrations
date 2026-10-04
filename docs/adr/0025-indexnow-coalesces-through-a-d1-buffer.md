# ADR 0025: IndexNow submissions coalesce through a D1 buffer drained by a cron, not a Cloudflare Queue

**Status:** Accepted (amended 2026-09-10 — the transport no longer retries a bare 429, and the request ceiling stated below was wrong by a factor of three; see the [Amendment](#amendment--2026-09-10-aeci-833-the-retry-now-makes-the-distinction-this-record-only-asserted). Amended again 2026-09-28 — the drain runs once a day, highest tier first, instead of every 20 minutes; see the [second Amendment](#amendment--2026-09-28-aeci-1136-send-once-a-day-highest-priority-pages-first). Amended again 2026-10-02 — the vendor appender is plan-gated; see the [third Amendment](#amendment--2026-10-02-aeci-1186-the-vendor-appender-is-plan-gated). Amended again 2026-10-04 — the drain logs every URL it sends; see the [fourth Amendment](#amendment--2026-10-04-aeci-1183-the-drain-logs-every-url-it-sends))
**Date:** 2026-09-09
**Context owner:** chrisw@thewbsproject.com
**Relates to:** AECI-826 (this record), AECI-833 (the first amendment), AECI-1136 (the second amendment), AECI-236 (the original per-promote ping), AECI-801 (closed affirmatively — the key was always provisioned). Build contract: `docs/STAGE_1_SPEC.md` §20.2. Applies the AECI-666 batching rule to a second transport. Follows ADR 0013's cron→job shape and declines its queue, for a reason ADR 0013 did not have to consider. Builds on ADR 0016 (D1/Drizzle, `db.batch` as the atomic unit) and ADR 0022 (the scheduled-`DELETE` exception it satisfies).

---

## Context

From AECI-236 (2026-07) until this ADR, the promote's post-commit hook called
`https://api.indexnow.org/indexnow` directly, once per promote. **One promote, one outbound
request.**

That is fine for one promote and wrong for how the catalogue is actually curated. The
operator works through vendors in bulk sessions, so promotes arrive in bursts. On 2026-09-07
eleven landed inside seven minutes:

```
07:00, 07:36, 07:37, 07:38, 07:38, 07:39, 07:40, 07:41, 07:41, 07:42, 07:43
```

**Every production submission visible in PostHog returned HTTP 429 `TooManyRequests` — 23 of
23 across 2026-09-07 to 09, with no `outcome=ok` series at all.** So the only automated
discovery channel we have on Bing or Yandex was pushing nothing. AECI-747 had already deleted
the Google Indexing ping (that API accepts `JobPosting` / `BroadcastEvent` only), and Google
discovery is a manual human step, so the automated half of the discovery pipeline was dead.

Two facts shaped the fix:

- **Payload size was never the constraint.** IndexNow accepts **10,000 URLs per request**;
  our largest attempt carried **107**. Request *frequency* was the whole problem.
- **Nothing alerted, and nothing could have.** The hook is fail-open by design — it warns and
  swallows, which is correct — and no alert existed on `aeci.indexnow.submit`. A uniformly
  failing non-zero series looked identical to a healthy one from every surface we had.

How far back the failure goes is **unknowable and left unknown**. The metric series begins the
day production received the PostHog-only build (`44aba9cf`, 2026-09-07); everything before
went to Datadog, which AECI-651 decommissioned. "Chronic since launch" and "recent burst" are
equally consistent with the evidence, and this ADR asserts neither.

## Decision

**The promote buffers; a cron submits.**

1. `POST /api/promote`'s post-commit hook appends the affected public URLs to a new D1 table,
   `indexnow_queue`, on `on conflict do nothing` keyed on the URL. It makes **no** outbound
   request. *(**Second appender since AECI-944**: every vendor-portal write that changes a
   public page, through `afterVendorWrite`, tagged `source = 'vendor'` on the row. Nothing here
   changes, because the `url` UNIQUE index dedupes across writers as well as within one call.
   The Google half of that work is a separate table and a separate decision — see ADR 0031.)*
2. A new `*/20 * * * *` cron (`indexnow-drain`, the fourteenth) reads the buffer, submits it
   in **one** `callIndexNow` request, and deletes what it sent. *(**Daily at `5 0 * * *` since
   2026-09-28**, reading highest tier first. See the second Amendment.)*
3. On failure the rows stay. **The next tick is the backoff.** *(Since 2026-09-28 the next
   tick is tomorrow.)*
4. The transport gains a bounded retry — two attempts, honouring a capped `Retry-After` — for
   an *isolated* throttle. **As shipped this retried a bare 429 too, which contradicted this
   record's own reasoning; AECI-833 gated it. See the Amendment.**
5. A PostHog alert fires on a sustained refusal ratio (> 90% over 24 h, ≥3-submission floor).
   *(Window widened to 72 h on 2026-09-28: at one submission a day, 24 h can never meet the
   floor. See the second Amendment.)*

**Ceiling: 72 ticks a day**, and far fewer requests in practice because an empty buffer makes
no request at all. Against eleven in seven minutes. *(One tick a day since 2026-09-28.)*

A tick and a request are not the same thing, and this record originally conflated them.
**Under a sustained throttle a tick costs exactly one request**, because a bare 429 is not
retried. A tick costs up to three only on a 5xx, a transport failure, or a 429 that names a
`Retry-After` inside ten seconds — so **216 a day is the absolute worst case and it is not the
throttled case**. See the Amendment.

Three properties fall out of the shape rather than being designed in:

- **Dedupe, for free.** `url` is UNIQUE, so a product promoted three times inside one window
  is submitted once. The per-promote design could not dedupe at all.
- **A D1 write is more durable than an outbound `fetch`.** The announcement now survives an
  IndexNow outage instead of being lost with a warn log.
- **One fewer Worker connection held in the promote's post-commit block** — the scarce
  resource AECI-666 was about.

## Why not a Cloudflare Queue

The WC-5 cache-purge queue (ADR 0020) is the obvious precedent, and it is the wrong tool here
for a measurable reason: **`max_batch_timeout` caps at 60 seconds.** The 2026-09-07 burst
spanned seven minutes, so a 60-second window still produces roughly seven requests instead of
eleven. Better, not fixed — and IndexNow's actual limit is undocumented, so there is nothing
to tune the window *against*. The buffer gives complete control over the submission rate
instead of hoping a window is wide enough.

A queue also cannot dedupe. Two messages carrying the same URL are two messages.

## Why the job is queue-less, unlike every other sub-hourly job

`queueForJob` returns `undefined` for `indexnow_drain`. Every other queue-less cron here
(`moderation`, `waf`, `analytics`, `snapshot`, `retention`, `asn_registry`) is queue-less
because native retries would **buy nothing**. This one is queue-less because they would be
**actively harmful**: a retry re-submits inside the same rate-limit window, which is precisely
the burst the job exists to remove.

That is the one genuinely new argument in this record, and it is why ADR 0013's cron→queue
default does not extend here.

## Why not retry alone

Retry with backoff was considered as the whole fix and rejected. `dispatchHook` caps
fire-and-forget work at a 20-second watchdog, so a retry lands inside the same rate-limit
window and 429s again. It fixes an isolated throttle and does nothing for the pattern we
actually had. It ships **alongside** the buffer, not instead of it.

The word doing the work in that paragraph is *isolated*, and the shipped code did not
honour it — it retried a rate limit identically to an aggregator fault. AECI-833 made the
distinction real; see the Amendment.

## Consequences

- **Discovery latency rises to at most 20 minutes.** Irrelevant: the alternative on Bing is
  ordinary sitemap crawling, measured in days. If it ever matters, the cadence is one constant
  plus three `triggers.crons` entries. *(Up to a day since 2026-09-28. See the second
  Amendment.)*
- **A new D1 table and a fourteenth cron.** The cron count is a lockstep number written down
  in roughly twenty places (`AdminCronJobSchema`, `cron-schedules.ts`, `wrangler.jsonc` × 3,
  the liveness registry, `ADMIN_PANEL_SPEC.md`, `POST_LAUNCH_MONITORING.md`, …).
  `cron-schedules.spec.ts` catches the ones that matter — it asserts
  `CRON_JOBS.length * 3` declared triggers, so a missing or duplicated expression is a red
  test rather than a job that silently stops dispatching.
- **The drain's `DELETE` audits.** §26.1 never exempts a scheduled delete, so each run that
  removes rows writes one summary `audit_log` row (`indexnow.drained`) in the same
  `db.batch`, with "no change, no row". Its delete is queue consumption rather than data
  retention and the rule is written without that distinction; following it costs one statement
  and is wanted anyway, because a bug there silently drops URLs out of the only automated
  discovery channel we have.
- **The buffer needs its own bound.** Seven days
  (`INDEXNOW_QUEUE_MAX_AGE_DAYS`), swept before each read. If IndexNow stays hostile the table
  would otherwise grow without limit, and by then the sitemap has covered those URLs for six
  days. Dropped rows are counted (`aeci.indexnow.expired`), because a non-zero value is a
  finding rather than routine housekeeping.
- **`ops:submit-trade-urls` still submits directly.** It runs from a laptop with no D1
  binding, it is a one-shot operator action, and its set is bounded at ~35 URLs, so coalescing
  buys nothing. It does inherit the new retry, and since AECI-833 it inherits the 429 gate
  with it — which is right for a one-shot operator action, whose correct response to a rate
  limit is to report it rather than to hammer it.

## What this does NOT fix

**The key value is still unverified, and batching cannot verify it.** Bing throttles *before*
it fetches `<key>.txt`, so a wrong key and a rate limit are indistinguishable from our side. A
429 proves the transport reaches the aggregator and gets a structured response — DNS, TLS and
egress are all fine — and proves nothing about the key. The current production value is also
**unrecoverable**: both stores are write-only, and the SSR route serves the file only at the
exact `/{key}.txt` path, so the URL cannot be built without already knowing the key. The Bing
Webmaster Tools panel is **not** a recovery route (that claim was wrong and is corrected at
`bb576250`).

Rotation is the only way to a known value, it is cheap, and IndexNow supports it by design.
Procedure: `docs/launch-cutover-runbook.md` §2a.

**The fix is unproven until `aeci.indexnow.submit{source:cron,outcome:ok}` is non-zero in
production.** That needs a prod promote plus a real catalogue write. Until then, treat Bing
discovery as sitemap-only.

## Alternatives not taken

- **A Cloudflare Queue with `max_batch_timeout: 60`.** Covered above: a 60-second cap against
  a seven-minute burst, and no dedupe.
- **Retry with backoff, alone.** Covered above: it retries into the same window.
- **Submit directly to `www.bing.com/indexnow` instead of the aggregator.** May carry
  different limits, but it forfeits Yandex, Seznam and Naver. Kept as a **fallback** if the
  aggregator stays hostile after batching — not the primary fix, and not adopted here.
- **Do nothing and rely on the sitemap.** The honest baseline, and what production has
  effectively been doing. Rejected because the channel is cheap to fix and its silence was
  itself the defect.

## Amendment — 2026-09-10 (AECI-833): the retry now makes the distinction this record only asserted

**What was wrong.** Decision item 4 above described the transport retry as being "for an
*isolated* throttle". The code did not make that distinction. `isRetryableStatus` treated a
429 exactly like a 5xx, so every drain tick cost up to three requests whether the previous
tick had succeeded or been throttled. Two things followed.

**The ceiling was wrong by a factor of three.** "72 requests a day" was really 72 *ticks* a
day at up to three requests each — 216. The same figure was stated in
`apps/api/src/lib/cron-schedules.ts`, `docs/POST_LAUNCH_MONITORING.md` (twice, including a
flat "at most one outbound IndexNow request per tick") and `docs/STAGE_1_SPEC.md` §20.2.

**And it contradicted this record.** "Why the job is queue-less" declines a Cloudflare Queue
because a retry "re-submits inside the same rate-limit window, which is precisely the burst
the job exists to remove". The transport then did precisely that, on every tick.

Not theoretical. Production's first real drain tick, 2026-09-09 08:20:11 UTC, logged
`status: 429, attempts: 3` on 344 buffered URLs — three guaranteed-failing requests spent
against the limiter we were waiting on.

**What changed.** `isRetryableStatus` now takes the parsed `Retry-After` and applies two
rules instead of one:

| Failure | Retried? | Backoff |
|---|---|---|
| 5xx | yes, twice | 1 s then 4 s |
| thrown transport error (DNS, TLS, reset) | yes, twice | 1 s then 4 s |
| 429 naming a `Retry-After` inside the 10 s cap | yes, twice | the header's value |
| **429 with no usable `Retry-After`** | **no** | the next drain tick |
| any other 4xx | no | n/a |

The gate is on the *justification*, not on the status: a 429 is retried when IndexNow itself
named a time to come back, and not when we would only be guessing. `INDEXNOW_MAX_RETRIES`
stays `2` and now bounds the 5xx path rather than the rate-limit path.

**Why this rather than suppressing the retry when the previous tick 429'd**, which was the
other candidate. That would have read the drain's own `job_runs` row to detect a sustained
episode. Three reasons against it. It still spends three requests on the *first* tick of every
episode, which is the majority of short throttles. It makes the job's behaviour depend on its
own bookkeeping, inverting `lib/job-runs.ts`'s stated rule that a bookkeeping write must never
alter the job it records. And it adds cross-tick state to a job whose whole shape is that the
next tick is the backoff. The `Retry-After` gate needs no state, no query and no migration,
and it fixes the first throttled tick as well as the hundredth.

**What did not change.** The buffer, the cadence, the queue-less decision, the staleness
sweep, and the alert. `ops:submit-trade-urls` inherits the gate, which is correct for a
one-shot operator action. Nothing about the key is settled by this either.

**The evidence it worked** is `attempts: 1` in the next throttled tick's
`aeci.indexnow.submit_failed` log from the `indexnow-drain-cron` source. That is independent
of the outstanding AECI-826 criterion, which still needs `outcome:ok` and still waits on
IndexNow's limiter.

## Amendment — 2026-09-28 (AECI-1136): send once a day, highest-priority pages first

**Ruling 2026-09-28 (Chris):** daily send, tiered by the GSC reason-to-tier map, sorted highest
tier first with tier 4 last, no artificial cap below IndexNow's 10,000-URL limit.

**What the evidence showed.** Production PostHog for 2026-09-22 to 2026-09-28:

| Observation | Value |
|---|---|
| Refusals | every one HTTP 429, on one attempt (the AECI-833 gate held) |
| Refusals per day | about 60 to 70 |
| Accepted submissions | only the first tick after 00:00 UTC (09-23 00:00, 09-25 00:01, 09-27 00:01) |
| Largest accepted request | 1,287 URLs |
| `aeci.indexnow.expired` | 0 |

So Bing throttles request **frequency**, not size, and its allowance appears to reset at
midnight UTC. The 20-minute cadence spent about 70 refused requests to land one. Re-open
trigger 1 below ("429s persist after coalescing") had fired. The key was not the problem: the
midnight submissions were accepted.

**What changed.**

1. **Cadence.** `INDEXNOW_DRAIN_CRON` is `5 0 * * *`, once a day at 00:05 UTC. Five minutes
   after the reset we observed. `15 0 * * *` is the metrics snapshot and every other daily job
   sits at minute 0, so minute 5 collides with nothing.
2. **Tiers.** `indexnow_queue` gains `priority` (migration `0051`, additive, `DEFAULT 4`, no
   CHECK). The tier comes from the Google worklist's `GSC_RECRAWL_PRIORITY` map through
   `indexNowEntriesByTier`: a URL that has a GSC entry in the same write takes that entry's tier,
   and anything else (a hub or facet page) is tier 4. The tables stay separate, as ADR 0031 §1
   requires. Only the map and its pure helpers are shared.
3. **Conflict rule.** `ON CONFLICT DO UPDATE SET priority = min(existing, incoming)`, applied only
   when the tier improves. `queued_at` keeps its first value. This is the GSC queue's rule.
4. **Read.** `ORDER BY priority ASC, queued_at ASC, id ASC`, up to 10,000 rows (IndexNow's cap),
   in keyset pages of 2,000 (D1's ~1 MB response cap). All of it goes in one request.
5. **Delete.** Exactly the ids that were read, 100 per statement (D1's bound-parameter cap), in
   one `db.batch` with the summary audit row. The old `id <= maxId` range was only correct while
   the read was in id order. A tier watermark was rejected: a tier-1 URL buffered while the
   request is in flight sorts before the watermark and would be deleted unsent.
6. **Alert.** The refusal-ratio alert window widened from 24 h to 72 h. At one submission a day,
   a 24 h window never meets the ≥3 floor, so the alert could not fire. With three samples, 90%
   means all three daily sends were refused.
7. **Liveness.** The sweep's allowance for `aeci.indexnow.drain` moved from 90 minutes to 26 h,
   the house value for a daily job.

**What was given up.** Latency. A URL now waits up to a day for its announcement instead of up
to 20 minutes. That is acceptable for the same reason the original 20 minutes was: the
alternative on Bing is sitemap crawling, measured in days. And the old 20 minutes was nominal,
because nearly every tick was refused. Measured latency was already about a day.

**What did not change.** The buffer, the queue-less decision, the AECI-833 `Retry-After` gate,
the seven-day expiry and the audit rule. Seven days now means seven daily attempts before a URL
is dropped. We kept it: the sitemap covers a dropped URL, and `aeci.indexnow.expired` still
reports every drop.

## Amendment — 2026-10-02 (AECI-1186): the vendor appender is plan-gated

Chris ruled on 2026-09-29 that IndexNow submission is a Managed-only benefit (recorded on
AECI-1160). The second appender from AECI-944 now buffers only when the writing vendor holds an
active entitlement. A Free seat's write commits and purges as before, and appends nothing.

- The gate is in `bufferVendorRecrawl` (`apps/api/src/routes/vendor-shared.ts`). It reads the
  session's resolved entitlement, so it costs no read.
- It keys off the write's origin. The admin retire shares the vendor tail with a session that
  carries no entitlement, and AECi's own writes stay ungated. The promote appender is unchanged.
- The buffer, the drain, the cadence and the alerts are unchanged. A quieter buffer only means
  fewer `source:vendor` rows.
- It is external discovery, not a ranking input (`STAGE_2_PAID_TIERS_SPEC.md` §3.2).

## Amendment — 2026-10-04 (AECI-1183): the drain logs every URL it sends

The drain used to delete what it sent and keep only counts. We could not show a vendor which of
its pages we had submitted, and IndexNow is a Managed-plan benefit. The drain now writes one
`recrawl_submissions` row per sent URL (`DATABASE_SCHEMA.md` §9.6a).

- Each run mints one `batchId`. The log rows carry it as `batch_id`. The `indexnow.drained`
  audit row carries it as `metadata.batchId`, and `job_runs.detail` carries it too.
- On success one `db.batch` holds the log inserts, then the id-chunked deletes, then the audit
  row. The insert is `INSERT … SELECT` from `indexnow_queue` by id, so it must precede the delete.
  It chunks ids at 95, which binds 99 parameters per statement under D1's cap of 100.
- On a refusal or a transport failure the log rows are written in a batch of their own, with
  outcome `refused` or `failed`. The queue rows stay buffered and no audit row is written, as
  before. Tomorrow's retry adds a second row per URL.
- Retired-slug URLs are never sent, so they are never logged.
- The log is kept forever and has no foreign key. Its exemption from per-row auditing is ADR
  0022's 2026-10-04 amendment.
- The cadence, the request ceiling, the buffer bound and the alerts are unchanged. The drain
  adds at most 106 statements to its success batch on a 10,000-URL day.

## Re-open trigger

Revisit if any of these becomes true:

1. **429s persist after coalescing.** Then the limit is not frequency-shaped and the key or
   the host registration is the suspect. Rotate first (§2a), then consider the direct Bing
   endpoint.
2. **`aeci.indexnow.expired` goes non-zero repeatedly.** URLs are being dropped unsent, which
   means the channel has been down for a week at a time and the containment bound is masking
   an unfixed problem.
3. **Discovery latency starts to matter.** If Bing indexation becomes a measured growth
   input rather than a hygiene item, tighten the cadence — but tighten it against evidence,
   not against a guess about an undocumented limit. The 2026-09-28 evidence says one request
   a day is what Bing accepts. A second daily slot needs its own evidence first.
4. **A day exceeds 10,000 URLs.** Then tier 4 is being left behind every day and `pending`
   climbs. Split the day's send only if Bing accepts a second request in the same UTC day.
