/**
 * The twenty-two cron expressions the API Worker is triggered on, in one place.
 *
 * They used to live as module-private constants in `scheduled.ts`, which was fine
 * while `scheduled.ts` was the only reader. `GET /api/admin/system` (AECI-580 /
 * §5.6) is a second reader — it renders a liveness row per cron and shows the
 * schedule beside it — and a *copy* of these strings on the read side would be a
 * silent-drift hazard: change the trigger, and the screen keeps reporting the old
 * window without anything failing. Hoisting them here means both the dispatcher
 * and the screen read the same literal.
 *
 * **Every value MUST stay byte-equal to the matching `triggers.crons` entry in
 * `apps/api/wrangler.jsonc`** (staging, demo and production each declare the same
 * twenty-two, and `cron-schedules.spec.ts` asserts it). `scheduled.ts` `switch`es on
 * `controller.cron`, so a mismatch silently stops dispatching the job — the
 * failure mode these comments have always warned about.
 *
 * The job ids are the `AdminCronJob` vocabulary in `@aeci/shared`, which is also
 * what `job_runs.job` carries since §7.2 landed (AECI-583) — one naming, three
 * consumers. {@link ADMIN_CRON_JOB} maps the dispatcher's internal ids onto it.
 */

import type { AdminCronJob } from '@aeci/shared';

import type { ScheduledJob } from '../env';

/**
 * Weekly `asn_registry` refresh (AECI-624 / `ADMIN_PANEL_SPEC.md` §7.6).
 * **02:00 UTC on Mondays** — the only non-daily, non-sub-hourly trigger here,
 * and therefore the only one exposed to the trap in the next paragraph.
 *
 * ⚠️ **Cloudflare's day-of-week field is 1 = Sunday … 7 = Saturday**, NOT the
 * Unix `0 = Sunday`. Cloudflare's own docs give `0 17 * * sun` and `0 17 * * 1`
 * as equivalent. So **Monday is `2`**, and the `'0 2 * * 1'` this constant
 * carried until AECI-661 meant *Sunday* — which is exactly what production did:
 * the job's only run landed Sunday 2026-08-23 and it did not run on Monday
 * 2026-08-24. Nothing failed, because the dispatcher matched fine; the schedule
 * simply meant a different day from the one every comment and doc claimed.
 *
 * Written numerically rather than as `'0 2 * * MON'`, despite the abbreviation
 * being the unambiguous form Cloudflare recommends, because `scheduled.ts`
 * `switch`es on the raw `controller.cron` string: if Cloudflare ever normalised
 * `MON` back to a digit on the round trip, the expression would stop matching
 * this constant and the job would silently stop dispatching — the precise
 * failure this file's header exists to prevent. The numeric form is *known* to
 * round-trip byte-identically (the Sunday run above proves it: the handler ran
 * and wrote its `job_runs` row, so `controller.cron` matched exactly). Prefer a
 * form we have evidence for over a form that merely reads better.
 *
 * Weekly, not daily, because the input barely moves: PeeringDB `info_type` values
 * change when a network re-registers, which is a matter of months, and the join
 * domain grows by a handful of ASNs a week. A daily fetch of ~35,000 upstream
 * records to rewrite ~878 unchanged rows would be seven times the egress for the
 * same answer.
 *
 * 02:00 puts it an hour clear of the 03:00 retention prune on both sides and
 * inside the same dead-of-night window as everything else. Nothing depends on its
 * ordering: it neither reads nor writes `page_views`, `metrics_daily` or
 * `job_runs` state that another job consumes, so a late or skipped run costs an
 * annotation, never a number.
 *
 * Queue-less, like `moderation`/`waf`/`analytics`/`snapshot`/`retention`: one
 * read-only GET plus an idempotent upsert that never deletes, so a failed week
 * leaves the last good rows in place and the next Monday converges.
 */
export const ASN_REGISTRY_CRON = '0 2 * * 2';

/** Daily `metrics_daily` snapshot (AECI-581 / `ADMIN_PANEL_SPEC.md` §7.1). **00:15
 *  UTC**, deliberately the first slot of the day: it captures the prior COMPLETE
 *  UTC day, mixing per-day flows with instantaneous stocks, and only a slot just
 *  after midnight lets both carry the same day label honestly. Queue-less — every
 *  metric is isolated in its own try/catch and a missed day is recoverable by
 *  re-running the backfill, so queue-native retries buy nothing. */
export const SNAPSHOT_CRON = '15 0 * * *';

/** Daily §7.4 retention prune (AECI-584 / `ADMIN_PANEL_SPEC.md` §7.4). **03:00
 *  UTC** — after the 00:15 snapshot, which is the ordering the whole job depends
 *  on: `metrics_daily` is the only thing that survives a `page_views` prune, so
 *  running ahead of the snapshot could permanently destroy a day's traffic. The
 *  2h45m gap is margin, not necessity (the job also *verifies* the snapshot
 *  landed rather than trusting the schedule), and it keeps the prune an hour
 *  clear of the 04:00 data-quality suite. Queue-less: a skipped or truncated run
 *  is simply re-attempted tomorrow, and automatic retries are the last thing a
 *  destructive job should have. */
export const RETENTION_CRON = '0 3 * * *';

/** Daily §23.1 data-quality suite (AECI-241 / Phase 7.6). 04:00 UTC — the §23.1
 *  slot, two hours ahead of the 06:00 moderation snapshot, in the same
 *  dead-of-night daily window. Runs the checks and emails the digest when
 *  they finish (~04:30 UTC). */
export const DATA_QUALITY_CRON = '0 4 * * *';

/** Daily operator analytics digest (AECI-526). 05:00 UTC = 12:00 WIB (noon
 *  Jakarta) — a read of the prior *complete* UTC day (page views, top products,
 *  new + total users, pending-moderation depth). Queue-less (a cheap read-only
 *  aggregation + one email), so `queueForJob` returns `QUEUE_LESS` and it always
 *  runs inline. */
export const ANALYTICS_CRON = '0 5 * * *';

/** Daily moderation-queue health snapshot (AECI-206). 06:00 UTC (= 01:00 EST) —
 *  one hour before the home-stats cron, in the same dead-of-night daily window.
 *  A cheap read-only gauge (no queue / ADR 0013 consumer). */
export const MODERATION_CRON = '0 6 * * *';

/** Daily home-stats compute (AECI-178). 07:00 UTC = 02:00 EST — one hour before
 *  the Algolia sync, so the `home.*` `stats_cache` rows are fresh at the start of
 *  the US morning. */
export const STATS_CRON = '0 7 * * *';

/** Daily incremental Algolia sync. 08:00 UTC = 03:00 EST (US-East, our launch
 *  customer base). Cloudflare cron is UTC-only / DST-unaware, so this is 04:00
 *  EDT in summer — both dead-of-night in the US, deliberately accepted (no
 *  per-season retune). */
export const ALGOLIA_SYNC_CRON = '0 8 * * *';

/** Daily index-drift check. 09:00 UTC = 04:00 EST — kept one hour after the sync
 *  so reconciliation reads a settled index. */
export const ALGOLIA_DRIFT_CRON = '0 9 * * *';

/** Request→Linear reconciliation sweep (AECI-214 / Phase 6.7). **Every 15
 *  minutes** — unlike the daily batch jobs, this is a tight backstop: a request
 *  whose §6.4 on-submit issue creation failed is retried within ~15 min.
 *  Queue-backed (ADR 0013) so it gets native retries. */
export const RECONCILE_CRON = '*/15 * * * *';

/** WAF firewall-event poll (AECI-262 / §15.1). **Every hour** at minute 0 — it
 *  reads the *previous clock hour* of `firewallEventsAdaptiveGroups` from
 *  Cloudflare's GraphQL Analytics API and emits the
 *  `aeci.waf.ratelimit.blocked` count, so the hourly cadence matches the one-hour
 *  query window (no overlap / gaps). Queue-less like `moderation`. */
export const WAF_CRON = '0 * * * *';

/** Daily Stage 2 §7 attestation detector sweep (AECI-302 /
 *  `STAGE_2_ATTESTATIONS_SPEC.md` §7). **10:00 UTC** — last of the daily jobs on
 *  purpose: it reads the claim/attestation spine that the earlier batch may have
 *  moved, and it is the only daily job that emails vendors rather than operators.
 *  Queue-backed, unlike the read-only gauges — it sends mail and writes
 *  `audit_log`, so it wants the consumer's native retries. */
export const ATTESTATION_NOTIFY_CRON = '0 10 * * *';

/** Daily Stage 2 §7 entitlement term-expiry warning sweep (AECI-613 /
 *  `STAGE_2_PAID_TIERS_SPEC.md` §7.1). **11:00 UTC** — the next free slot, one hour
 *  after the attestation sweep and the new last daily job.
 *
 *  **The spec says 05:00; that is stale.** §7.1 was written when seven crons
 *  existed, and 05:00 has since been taken by the AECI-526 analytics digest. The
 *  05:00–10:00 band is now fully occupied (04:00 data-quality, 05:00 analytics,
 *  06:00 moderation, 07:00 stats, 08:00 Algolia sync, 09:00 drift, 10:00
 *  attestation notify), so this continues the sequence rather than colliding.
 *  §7's actual requirement — a daily slot in the dead-of-night window, after the
 *  batch that may have moved the rows it reads — is satisfied either way.
 *
 *  Queue-less and inline, following the 06:00 moderation-snapshot precedent
 *  (`queueForJob` returns `QUEUE_LESS`): one indexed read over
 *  `licenses_ends_idx` (AECI-1356) plus a handful of fail-open emails does not
 *  justify a new `aeci-entitlement-expiry-{env}` queue, two `wrangler.jsonc`
 *  blocks per tier, and a `wrangler queues create` step in two deploy workflows.
 *  A missed night costs at most one day of warning lead time, and the
 *  `expiry_notice_sent_at` fence makes tomorrow's run pick up exactly what this
 *  one missed. */
export const ENTITLEMENT_EXPIRY_CRON = '0 11 * * *';

/**
 * IndexNow submission drain (AECI-826 / §20.2). **Daily at 00:05 UTC** since
 * AECI-1136; every 20 minutes before that.
 *
 * **Since AECI-1476 this cron sends nothing.** It expires stale rows and reports
 * the `pending` / `deferred` gauges and its heartbeat. IndexNow refused the
 * Worker's shared egress IPs, so the one daily request is made by a GitHub Actions
 * runner at 00:20 UTC (`.github/workflows/indexnow-send.yml`) through the
 * token-gated `/api/internal/indexnow/*` routes. That workflow's `schedule` is the
 * send time, and it must stay after this cron so the expiry runs first. The
 * paragraphs below explain the daily cadence, which the runner keeps.
 *
 * **Why daily.** Production PostHog for 2026-09-22..28 showed Bing refusing almost
 * every 20-minute tick with a 429 (about 60-70 a day), and accepting only the first
 * tick after 00:00 UTC. A 1,287-URL request was accepted, so the limit is on
 * request frequency, not size. So the drain sends once a day, everything at once,
 * up to IndexNow's 10,000-URL cap, highest tier first. Latency of up to a day is
 * the cost, and it is cheap: the alternative on Bing is sitemap crawling, which is
 * measured in days anyway. Ruling 2026-09-28 (Chris).
 *
 * **Why 00:05.** Just after the 00:00 UTC point where production saw Bing accept,
 * with five minutes of margin. `15 0 * * *` belongs to the metrics snapshot, and
 * every other daily job is at minute 0, so minute 5 collides with nothing. Two jobs
 * can never share an expression: `scheduled.ts` `switch`es on the raw
 * `controller.cron` string and would route both to whichever case comes first.
 * `cron-schedules.spec.ts` asserts uniqueness arithmetically.
 *
 * **One request a day.** Under a rate limit a run costs exactly one request,
 * because `lib/indexnow.ts` does not retry a bare 429 (AECI-833). A run can cost up
 * to three only on a 5xx, a transport failure, or a 429 carrying a `Retry-After`
 * inside ten seconds.
 *
 * **Queue-less, and that is the point.** A blind retry is the wrong response to a
 * rate limit — it re-submits inside the same window and 429s again. A failed drain
 * leaves its rows in `indexnow_queue` and tomorrow's run is the backoff.
 *
 * Retuning it is a config change: move this constant and the three
 * `triggers.crons` entries together (the spec keeps them honest), move the
 * liveness allowance in `observability/posthog/project-config.json`, and record
 * the new cadence in `POST_LAUNCH_MONITORING.md` §3.
 */
export const INDEXNOW_DRAIN_CRON = '5 0 * * *';

/**
 * Claim-ticket staleness check (AECI-862 / `STAGE_1_PHASE_6_SPEC.md` §6.2).
 * **Every six hours at minute 25** — 00:25, 06:25, 12:25, 18:25 UTC.
 *
 * ⚠️ **Minute 25 is load-bearing, not arbitrary.** `scheduled.ts` `switch`es on the
 * raw `controller.cron` string, so two jobs cannot share an expression — and an
 * every-6-hours job at minute 0 would have collided three ways at once when it
 * landed: with the `*` `/15` reconcile sweep (:00/:15/:30/:45), with the IndexNow
 * drain (then every 20 minutes, :00/:20/:40; daily at 00:05 since AECI-1136), and
 * with the hourly WAF poll (:00). Minute 25 is clear of all of them and of every
 * daily job (all at minute 0, except the 00:05 IndexNow drain and the 00:15
 * snapshot). `cron-schedules.spec.ts` enforces uniqueness arithmetically.
 *
 * (The split backticks above are not a typo — an unescaped `*` followed by `/`
 * closes this very comment.)
 *
 * Six hours rather than hourly because the threshold it tests is 24 hours: a
 * finer cadence would not detect anything sooner, it would only re-evaluate the
 * same unchanged rows. The email is separately band-throttled
 * (`lib/alert-bands.ts`), so the cadence sets detection latency, not mail volume.
 *
 * Queue-less and inline, following the 06:00 moderation-snapshot and hourly
 * WAF-poll precedent (`queueForJob` returns `QUEUE_LESS`): one indexed read, one
 * batched Linear query and one fail-open email do not justify a
 * `aeci-claim-stale-{env}` queue, three `wrangler.jsonc` blocks and a
 * `wrangler queues create` step in two deploy workflows. A missed run costs at
 * most six hours of warning latency, and the next run re-derives everything from
 * `created_at`.
 */
export const CLAIM_STALE_CRON = '25 */6 * * *';

/**
 * Daily protest reply reminder (AECI-1205 / `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §11b.12.10). **12:00 UTC**, the next free daily slot after the 11:00 entitlement
 * sweep. It is also 08:00 in US Eastern summer time, so the owner reads the reminder
 * at the start of a working day rather than overnight. The hourly WAF poll fires at
 * 12:00 too, but under its own expression, so the two never share a `switch` case.
 *
 * It emails the owner's seats of every open protest with no reply whose 14-day
 * deadline falls within the next three days. A daily run over a 3-day window sees a
 * protest up to three times. The `notification_sends` dedupe key
 * `contest-protest-reply-reminder:{contestId}:{protestedAt}:{profileId}` makes it one
 * send per seat, so the job needs no fence column and no migration.
 *
 * Queue-less and inline, following the `entitlement_expiry` precedent: one indexed
 * read over `integration_field_challenges_protest_idx` and a handful of fail-open
 * emails. A missed day costs one day of lead time, and the next run inside the window
 * sends what this one missed.
 */
export const PROTEST_REMINDER_CRON = '0 12 * * *';

/**
 * Daily per-vendor snapshot (AECI-1210 / `DATABASE_SCHEMA.md` §9.12). **00:30 UTC.**
 *
 * It snapshots the prior complete UTC day, like the 00:15 `metrics_daily` snapshot,
 * so it belongs just after midnight. Minute 30 is clear of the 00:05 IndexNow drain,
 * the 00:15 metrics snapshot, and the 00:25 claim-staleness check. The `*` `/15`
 * reconcile sweep also fires at 00:30, but under its own expression, so the two
 * never share a `switch` case. The activity counts read `user_activity_daily` for
 * whole days ending yesterday. The stock counts are read at run time, 30 minutes
 * after that day ended.
 *
 * Queue-backed (`VENDOR_SNAPSHOT_QUEUE`), the cron-enqueues, consumer-works pattern.
 * The write is an idempotent upsert on `(day, vendor_id)`, so a queue retry after a
 * transient D1 failure replaces rows rather than adding any. It sends nothing.
 */
export const VENDOR_SNAPSHOT_CRON = '30 0 * * *';

/**
 * Google URL Inspection run (AECI-1236 / §20.2). **Daily at 13:00 UTC.**
 *
 * 13:00 UTC is 05:00 or 06:00 in California, after Google's per-property daily
 * quota resets at Pacific midnight, so the run starts with a full day's quota
 * and the operator's own Search Console use comes after it. It cannot be 12:00:
 * the protest reply reminder owns `0 12 * * *`, and two jobs cannot share one
 * expression. The hourly WAF poll also fires at 13:00, under its own expression.
 *
 * Queue-backed, unlike most of the read-only crons, because the run does not fit
 * in one invocation: about an hour of calls against a 15-minute consumer cap. The
 * consumer handles one chunk and re-sends the next on `aeci-gsc-inspect-{env}`.
 */
export const GSC_INSPECT_CRON = '0 13 * * *';

/**
 * Daily claim owner fallback (AECI-1368 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §11a.10).
 * **14:00 UTC**, the next free daily slot after the 13:00 URL Inspection run. The
 * hourly WAF poll fires at 14:00 too, under its own expression.
 *
 * A claim on a company that already has an owner seat goes to those owners first. A
 * routed claim still open 7 days later with no owner decision is handed to AECi:
 * the run clears `routed_to_owners_at` into `owner_fallback_at`, writes one audit row
 * per claim in the same batch, and sends one operator digest. A second run finds
 * nothing to move, so it is a no-op.
 *
 * Queue-less and inline, following the `protest_reply_reminder` precedent: one
 * indexed read, one batch and one fail-open email. A missed day costs one day of
 * latency, and the next run moves what this one missed.
 */
export const CLAIM_OWNER_FALLBACK_CRON = '0 14 * * *';

/**
 * Daily pending-confirmation expiry (AECI-1435 / ADR 0043). **14:30 UTC**, half an
 * hour after the 14:00 claim owner fallback. The `*` `/15` reconcile sweep also fires at
 * 14:30, under its own expression, so the two never share a `switch` case.
 *
 * It deletes every `request_confirmations` row past its 7-day `expires_at`, confirmed
 * or not, up to 500 a run, with one summary audit row in the same batch (the
 * scheduled-delete rule, ADR 0022). An unconfirmed row is a link nobody clicked, so
 * nothing was ever claimed. A confirmed row is spent and already holds no payload.
 *
 * Queue-less and inline, following the `claim_owner_fallback` precedent: one indexed
 * read and one batch. It sends nothing. A missed day keeps expired rows one more day,
 * and the confirm refuses an expired link whether the row is there or not.
 */
export const REQUEST_CONFIRMATION_EXPIRY_CRON = '30 14 * * *';

/**
 * Daily traffic classification writer (AECI-1345 / `DATABASE_SCHEMA.md` §9.7,
 * `ADMIN_PANEL_SPEC.md` §13 D19 Phase 2). **00:45 UTC.**
 *
 * It classifies the prior complete UTC day. Not 00:15, as D19 first proposed: the
 * SPA follow-up evidence reads rows up to `SPA_FOLLOWUP_WINDOW_MINUTES` (30) past
 * the day's end, so a 00:15 run would miss the follow-ups of arrivals after 23:45.
 * Minute 45 is clear of the 00:05 IndexNow drain, the 00:15 metrics snapshot, the
 * 00:25 claim-staleness check and the 00:30 vendor snapshot. The `*` `/15`
 * reconcile sweep also fires at 00:45, under its own expression.
 *
 * Queue-backed (`TRAFFIC_CLASSIFY_QUEUE`), the cron-enqueues, consumer-works
 * pattern. The insert is `ON CONFLICT DO NOTHING` per classifier version, so a
 * retry writes nothing twice. It sends nothing and changes no reported number.
 */
export const TRAFFIC_CLASSIFY_CRON = '45 0 * * *';

/**
 * Daily Stripe reconcile (AECI-1503 / `STAGE_2_PAID_TIERS_SPEC.md` §7.6 point 2).
 * **01:15 UTC.**
 *
 * The backstop for a Stripe webhook that never arrived. Stripe retries a failed
 * delivery for three days, but an endpoint Stripe disabled, a rotated secret, or a
 * bug in the handler loses events for good. Once a day the run lists the
 * subscriptions, syncs each one the same way the webhook does, and ends the licenses
 * of a subscription Stripe no longer has live. Any change it makes means a webhook
 * was missed, so it emails `SUPPORT_EMAIL`.
 *
 * 01:15 is a free slot: no daily job runs in the 01:00 hour. The `*` `/15` reconcile
 * sweep also fires at 01:15, under its own expression, so the two never share a
 * `switch` case. Nothing depends on its order against the other jobs.
 *
 * Queue-backed (`STRIPE_RECONCILE_QUEUE`), the cron-enqueues, consumer-works
 * pattern. The sync converges on the subscription as Stripe has it now, so a queue
 * retry after a transient failure changes only what still differs.
 */
export const STRIPE_RECONCILE_CRON = '15 1 * * *';

/**
 * Every cron, in schedule order, keyed by the `AdminCronJob` id. `Record<…>` so
 * adding a member to the shared enum without adding a schedule here is a type
 * error rather than a row that quietly vanishes from the System screen.
 */
export const CRON_SCHEDULES: Record<AdminCronJob, string> = {
  'metrics-snapshot': SNAPSHOT_CRON,
  'asn-registry': ASN_REGISTRY_CRON,
  'retention-prune': RETENTION_CRON,
  'data-quality': DATA_QUALITY_CRON,
  'analytics-digest': ANALYTICS_CRON,
  'moderation-snapshot': MODERATION_CRON,
  'home-stats': STATS_CRON,
  'algolia-sync': ALGOLIA_SYNC_CRON,
  'algolia-drift': ALGOLIA_DRIFT_CRON,
  'request-reconcile': RECONCILE_CRON,
  'waf-poll': WAF_CRON,
  'attestation-notify': ATTESTATION_NOTIFY_CRON,
  'entitlement-expiry': ENTITLEMENT_EXPIRY_CRON,
  'indexnow-drain': INDEXNOW_DRAIN_CRON,
  'claim-stale-check': CLAIM_STALE_CRON,
  'protest-reply-reminder': PROTEST_REMINDER_CRON,
  'vendor-snapshot': VENDOR_SNAPSHOT_CRON,
  'gsc-inspect': GSC_INSPECT_CRON,
  'claim-owner-fallback': CLAIM_OWNER_FALLBACK_CRON,
  'request-confirmation-expiry': REQUEST_CONFIRMATION_EXPIRY_CRON,
  'traffic-classify': TRAFFIC_CLASSIFY_CRON,
  'stripe-reconcile': STRIPE_RECONCILE_CRON,
};

/**
 * The internal `ScheduledJob` ids `scheduled.ts` dispatches on → the public
 * `AdminCronJob` ids `job_runs.job` and `GET /api/admin/system` carry (AECI-583).
 *
 * Two vocabularies exist because the dispatcher's union predates the shared enum;
 * this is the one place they meet. `Record<ScheduledJob, …>` so adding a
 * dispatcher case without a mapping is a type error rather than a `job_runs` row
 * carrying an id the read side silently drops. It lives here rather than in
 * `scheduled.ts` because the read side needs the same map.
 */
export const ADMIN_CRON_JOB: Record<ScheduledJob, AdminCronJob> = {
  snapshot: 'metrics-snapshot',
  asn_registry: 'asn-registry',
  retention: 'retention-prune',
  data_quality: 'data-quality',
  analytics: 'analytics-digest',
  moderation: 'moderation-snapshot',
  stats: 'home-stats',
  sync: 'algolia-sync',
  drift: 'algolia-drift',
  reconcile: 'request-reconcile',
  waf: 'waf-poll',
  attestation_notify: 'attestation-notify',
  entitlement_expiry: 'entitlement-expiry',
  indexnow_drain: 'indexnow-drain',
  claim_stale_check: 'claim-stale-check',
  protest_reply_reminder: 'protest-reply-reminder',
  vendor_snapshot: 'vendor-snapshot',
  gsc_inspect: 'gsc-inspect',
  claim_owner_fallback: 'claim-owner-fallback',
  request_confirmation_expiry: 'request-confirmation-expiry',
  traffic_classify: 'traffic-classify',
  stripe_reconcile: 'stripe-reconcile',
};

/** Display/iteration order for the System screen — chronological through the UTC
 *  day, then the sub-daily jobs. `vendor-snapshot` (00:30) and `traffic-classify`
 *  (00:45) follow the 00:15 `metrics-snapshot`, and `stripe-reconcile` (01:15)
 *  follows them. `indexnow-drain` has been daily (00:05) since
 *  AECI-1136 but keeps its old slot among the sub-daily jobs, so the screen's
 *  order did not move. The weekly `asn-registry` sits at its 02:00
 *  slot in that same day-ordering rather than in a section of its own; its row
 *  carries the schedule, so "Mondays" is already visible beside it. Matches
 *  `POST_LAUNCH_MONITORING.md` §1a. */
export const CRON_JOBS: readonly AdminCronJob[] = [
  'metrics-snapshot',
  'vendor-snapshot',
  'traffic-classify',
  'stripe-reconcile',
  'asn-registry',
  'retention-prune',
  'data-quality',
  'analytics-digest',
  'moderation-snapshot',
  'home-stats',
  'algolia-sync',
  'algolia-drift',
  'attestation-notify',
  'entitlement-expiry',
  'protest-reply-reminder',
  'gsc-inspect',
  'claim-owner-fallback',
  'request-confirmation-expiry',
  'request-reconcile',
  'waf-poll',
  'indexnow-drain',
  'claim-stale-check',
];
