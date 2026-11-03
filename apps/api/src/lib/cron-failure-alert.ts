/**
 * One email per scheduled-job failure, with the reason (AECI-1587,
 * `docs/OBSERVABILITY.md` §Alerts).
 *
 * `withJobRun` decides when a run has really failed. This module turns that into the
 * `cron-job-failed-alert` email and counts how the send went on
 * `aeci.cron.failure_email`. A send that did not go out reaches the PostHog backstop
 * alert through that metric, because the email cannot report its own failure.
 */

import { submitCount } from '../posthog';
import { sendCronJobFailedAlert, type EmailContext, type EmailOutcome } from './email';
import type { JobRunFailure } from './job-runs';

/** `max_retries` on every scheduled-job queue consumer in `wrangler.jsonc`, which a
 *  Worker cannot read at run time. `wrangler-job-queues.spec.ts` keeps the two equal. */
export const SCHEDULED_JOB_MAX_RETRIES = 3;

/** Tagged `job` and `outcome`, the send's {@link EmailOutcome}. */
export const CRON_FAILURE_EMAIL_METRIC = 'aeci.cron.failure_email';

/** True while the queue will deliver the message again after this attempt. */
export function queueWillRetry(attempts: number): boolean {
  return attempts <= SCHEDULED_JOB_MAX_RETRIES;
}

/** The alert's send-ledger key: one per job, UTC day and failure reason. */
export async function cronFailureAlertKey(
  job: string,
  day: string,
  reason: string,
): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(reason));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `cron-job-failed-alert:${job}:${day}:${hex.slice(0, 16)}`;
}

/**
 * Send the alert and count the outcome. Never rejects: it runs in `waitUntil` beside a
 * job whose result it must not change.
 */
export async function sendCronFailureAlert(
  c: EmailContext,
  failure: JobRunFailure,
  attempts: number,
): Promise<EmailOutcome> {
  let outcome: EmailOutcome = 'failed';
  try {
    outcome = await sendCronJobFailedAlert(c, {
      to: c.env.SUPPORT_EMAIL,
      job: failure.job,
      reason: failure.reason,
      detail: failure.detail,
      failedAt: failure.failedAt,
      attempts,
      dedupeKey: await cronFailureAlertKey(
        failure.job,
        failure.failedAt.slice(0, 10),
        failure.reason,
      ),
    });
  } catch (error) {
    console.error(
      `cron failure alert for "${failure.job}" threw:`,
      error instanceof Error ? error.message : String(error),
    );
  }
  try {
    submitCount(c.executionCtx, c.env, c.req.raw, CRON_FAILURE_EMAIL_METRIC, 1, [
      `job:${failure.job}`,
      `outcome:${outcome}`,
    ]);
  } catch {
    // Telemetry must never break the job's bookkeeping.
  }
  return outcome;
}
