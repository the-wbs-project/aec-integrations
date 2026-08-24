/**
 * Datadog metrics for the §7 detector sweep (AECI-302), as a pure module over an
 * injected sink — the `lib/moderation-metrics.ts` / `lib/waf-metrics.ts` pattern,
 * so nothing here needs `ctx` / `env` / a synthetic `Request` and the sweep's
 * specs can assert on plain calls.
 *
 * The load-bearing rule is §7.4's: **emit the per-detector gauge on every run,
 * including zero.** A gauge that only appears when something fires cannot
 * distinguish "clean" from "the cron did not run" — and since the detectors match
 * nothing at all until vendors start attesting, the zero series is the *only*
 * liveness signal this job has for its first months. See `docs/OBSERVABILITY.md`.
 */

import type { AttestationDetector } from '@aeci/shared';

import { ATTESTATION_DETECTORS } from '@aeci/shared';
import type { DetectorResult } from './attestation-detectors';

/** The slice of the telemetry client this module needs (`scheduled.ts`'s
 *  `metricSink` adapter satisfies it structurally). */
export interface AttestationNotifyMetricSink {
  count(metric: string, value: number, tags: string[]): void;
  gauge(metric: string, value: number, tags: string[]): void;
}

/** Findings per detector per run. Value is the count, or **-1** when the detector
 *  threw — the same sentinel `aeci.data_quality.check` uses, so one monitor idiom
 *  covers both jobs. */
export const DETECTOR_METRIC = 'aeci.attestation.detector';

/** One count per (detector, outcome) pair, aggregated over the run. */
export const NOTIFY_SENT_METRIC = 'aeci.attestation.notify.sent';

/** Per-run heartbeat + duration (emitted by the `scheduled.ts` orchestrator, which
 *  owns the clock). Named here so the metric vocabulary lives in one file. */
export const NOTIFY_JOB_METRIC = 'aeci.attestation.notify.job';
export const NOTIFY_DURATION_METRIC = 'aeci.attestation.notify.job.duration_ms';

/**
 * Emit the per-detector gauge for **every** detector in the union, not merely the
 * ones that produced a result — a detector accidentally dropped from the registry
 * would otherwise vanish from the board silently rather than flatlining at zero.
 */
export function emitDetectorMetrics(
  sink: AttestationNotifyMetricSink,
  results: readonly DetectorResult[],
): void {
  const byDetector = new Map(results.map((r) => [r.detector, r]));
  for (const detector of ATTESTATION_DETECTORS) {
    const result = byDetector.get(detector);
    sink.gauge(DETECTOR_METRIC, result?.error ? -1 : (result?.findings.length ?? 0), [
      `detector:${detector}`,
    ]);
  }
}

/** What happened to each notification the sweep considered. */
export type NotifyOutcome = 'sent' | 'failed' | 'skipped' | 'suppressed';

/**
 * Emit the send outcomes, aggregated to one point per (detector, outcome) rather
 * than one per email — the interesting shape is the ratio, and a busy sweep should
 * not turn into hundreds of identical counts.
 */
export function emitNotifyOutcomeMetrics(
  sink: AttestationNotifyMetricSink,
  outcomes: ReadonlyArray<{ detector: AttestationDetector; outcome: NotifyOutcome }>,
): void {
  const tally = new Map<string, number>();
  for (const { detector, outcome } of outcomes) {
    const key = `${detector}|${outcome}`;
    tally.set(key, (tally.get(key) ?? 0) + 1);
  }
  for (const [key, value] of tally) {
    const [detector, outcome] = key.split('|');
    sink.count(NOTIFY_SENT_METRIC, value, [`detector:${detector}`, `outcome:${outcome}`]);
  }
}
