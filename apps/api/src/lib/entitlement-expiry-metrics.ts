/**
 * Datadog metrics for the §7 entitlement term-expiry sweep (AECI-613), as a pure
 * module over an injected sink — the `lib/attestation-notify-metrics.ts` /
 * `lib/moderation-metrics.ts` pattern, so nothing here needs `ctx` / `env` / a
 * synthetic `Request` and the sweep's specs assert on plain calls.
 *
 * The load-bearing rule is the same one the attestation sweep learned: **emit on
 * every run, including zero.** A metric that only appears when a term is expiring
 * cannot distinguish "no terms due" from "the cron stopped running" — and since
 * every backfilled entitlement is perpetual (`period_end IS NULL`, §2.4) and
 * therefore structurally invisible to this job, "0 notices" is the healthy steady
 * state for a long time. {@link EXPIRY_JOB_METRIC} carries that liveness;
 * {@link EXPIRY_NOTICE_METRIC} is emitted only when there is something to report.
 * See `docs/OBSERVABILITY.md`.
 */

/** The slice of the telemetry client this module needs (`scheduled.ts`'s
 *  `metricSink` adapter satisfies it structurally). */
export interface EntitlementExpiryMetricSink {
  count(metric: string, value: number, tags: string[]): void;
  gauge(metric: string, value: number, tags: string[]): void;
}

/**
 * One count per (channel, outcome) pair, aggregated over the run — §7.3's named
 * metric. `channel:vendor` is the seats' renewal prompt, `channel:admin` the
 * operator copy. `outcome` is the `EmailOutcome` verbatim, so a deployed tier
 * reporting `channel:vendor,outcome:skipped` is a real finding (a missing
 * `SUPABASE_SERVICE_ROLE_KEY` or a vendor with no unbanned seat) rather than the
 * expected local state it is on preview.
 */
export const EXPIRY_NOTICE_METRIC = 'aeci.entitlement.expiry_notice';

/** Terms inside the warning horizon this run, BEFORE the `expiry_notice_sent_at`
 *  fence. A gauge rather than a count because it is a stock, not a flow: it
 *  answers "how much is due" and stays flat while nobody renews. Emitted on every
 *  run including zero. */
export const EXPIRY_DUE_METRIC = 'aeci.entitlement.expiry_due';

/** Per-run heartbeat + duration (emitted by the `scheduled.ts` orchestrator, which
 *  owns the clock). Named here so the metric vocabulary lives in one file. */
export const EXPIRY_JOB_METRIC = 'aeci.entitlement.expiry.job';
export const EXPIRY_DURATION_METRIC = 'aeci.entitlement.expiry.job.duration_ms';

/** Which half of a notice a data point describes. */
export type ExpiryChannel = 'vendor' | 'admin';

/** One send's result, as the sweep records it for aggregation. */
export interface ExpiryNoticeOutcome {
  channel: ExpiryChannel;
  outcome: string;
}

/**
 * Emit the send outcomes, aggregated to one point per (channel, outcome) rather
 * than one per email — the interesting shape is the ratio, and a vendor with four
 * seats should not turn into four identical counts.
 */
export function emitExpiryNoticeMetrics(
  sink: EntitlementExpiryMetricSink,
  outcomes: readonly ExpiryNoticeOutcome[],
): void {
  const tally = new Map<string, number>();
  for (const { channel, outcome } of outcomes) {
    const key = `${channel}|${outcome}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  for (const [key, value] of tally) {
    const [channel, outcome] = key.split('|');
    sink.count(EXPIRY_NOTICE_METRIC, value, [`channel:${channel}`, `outcome:${outcome}`]);
  }
}

/** Emit the due-terms gauge. Called on EVERY run, zero included — see the header. */
export function emitExpiryDueMetric(sink: EntitlementExpiryMetricSink, due: number): void {
  sink.gauge(EXPIRY_DUE_METRIC, due, []);
}
