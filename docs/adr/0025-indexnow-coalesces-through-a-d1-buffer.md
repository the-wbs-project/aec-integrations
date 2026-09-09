# ADR 0025: IndexNow submissions coalesce through a D1 buffer drained by a cron, not a Cloudflare Queue

**Status:** Accepted
**Date:** 2026-09-09
**Context owner:** chrisw@thewbsproject.com
**Relates to:** AECI-826 (this record), AECI-236 (the original per-promote ping), AECI-801 (closed affirmatively — the key was always provisioned). Build contract: `docs/STAGE_1_SPEC.md` §20.2. Applies the AECI-666 batching rule to a second transport. Follows ADR 0013's cron→job shape and declines its queue, for a reason ADR 0013 did not have to consider. Builds on ADR 0016 (D1/Drizzle, `db.batch` as the atomic unit) and ADR 0022 (the scheduled-`DELETE` exception it satisfies).

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
   request.
2. A new `*/20 * * * *` cron (`indexnow-drain`, the fourteenth) reads the buffer, submits it
   in **one** `callIndexNow` request, and deletes what it sent.
3. On failure the rows stay. **The next tick is the backoff.**
4. The transport gains a bounded retry — two attempts on 429 or 5xx, honouring a capped
   `Retry-After` — for an *isolated* throttle.
5. A PostHog alert fires on a sustained refusal ratio (> 90% over 24 h, ≥3-submission floor).

**Ceiling: 72 requests a day**, and far fewer in practice because an empty buffer makes no
request at all. Against eleven in seven minutes.

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

## Consequences

- **Discovery latency rises to at most 20 minutes.** Irrelevant: the alternative on Bing is
  ordinary sitemap crawling, measured in days. If it ever matters, the cadence is one constant
  plus three `triggers.crons` entries.
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
  buys nothing. It does inherit the new retry.

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
   not against a guess about an undocumented limit.
