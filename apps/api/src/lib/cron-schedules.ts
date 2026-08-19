/**
 * The eleven cron expressions the API Worker is triggered on, in one place.
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
 * eleven, and `cron-schedules.spec.ts` asserts it). `scheduled.ts` `switch`es on
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
 * **02:00 UTC on Mondays** — the only non-daily, non-sub-hourly trigger here.
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
export const ASN_REGISTRY_CRON = '0 2 * * 1';

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
 *  dead-of-night daily window. Runs the ten checks and emails the digest when
 *  they finish (~04:30 UTC). */
export const DATA_QUALITY_CRON = '0 4 * * *';

/** Daily operator analytics digest (AECI-526). 05:00 UTC = 12:00 WIB (noon
 *  Jakarta) — a read of the prior *complete* UTC day (page views, top products,
 *  new + total users, pending-moderation depth). Queue-less (a cheap read-only
 *  aggregation + one email), so `queueForJob` returns `undefined` and it always
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
};

/** Display/iteration order for the System screen — chronological through the UTC
 *  day, then the two sub-daily jobs. The weekly `asn-registry` sits at its 02:00
 *  slot in that same day-ordering rather than in a section of its own; its row
 *  carries the schedule, so "Mondays" is already visible beside it. Matches
 *  `POST_LAUNCH_MONITORING.md` §1a. */
export const CRON_JOBS: readonly AdminCronJob[] = [
  'metrics-snapshot',
  'asn-registry',
  'retention-prune',
  'data-quality',
  'analytics-digest',
  'moderation-snapshot',
  'home-stats',
  'algolia-sync',
  'algolia-drift',
  'request-reconcile',
  'waf-poll',
];
