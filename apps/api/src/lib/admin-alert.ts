/**
 * Admin-alert seam for the request→Linear reconciliation sweep (AECI-214 / Phase
 * 6.7). When the sweep finds a `vendor_request` that has been stuck (`open` /
 * `linear_issue_id = null`) past the persistent threshold and a fresh retry still
 * fails, it raises the §6.2 "admin email" so the request is never silently lost.
 *
 * This is the **email channel** specifically. The high-severity *Datadog alert*
 * (the `aeci.linear.reconcile.persistent_failure` count + the `source:reconcile`
 * error log) is emitted by the sweep itself and is the guaranteed backstop — per
 * `STAGE_1_PHASE_6_SPEC.md` §6.2: "the stuck-row visibility in `/admin/requests`
 * + the Datadog alert are the guaranteed backstop" — which holds even when the
 * email send is fail-open `'skipped'` (no key/recipient).
 *
 * **The transport is Resend** (AECI-240 / Phase 7.5, §11.1) — `sendAdminAlert`
 * delegates to `sendStuckRequestAdminAlert` in `lib/email.ts`, then emits
 * `aeci.linear.reconcile.email` with the send `outcome` and logs the digest. It
 * stays fail-open: an absent `RESEND_API_KEY` / `ADMIN_ALERT_EMAIL` resolves to
 * `'skipped'` (the expected local/preview state, mirroring the absent-`LINEAR_API_KEY`
 * posture), and the §6.2 Datadog alert remains the guaranteed backstop regardless.
 * Kept as its own module so the email channel (and its test) live in one place,
 * apart from the sweep. (Originally specced as "Loops"; the repo uses Resend — see
 * docs/email.md.)
 */

import type { RequestKind, RequestTargetType } from '@aeci/shared';

import { logToDatadog, submitCount } from '../datadog';
import type { Env } from '../env';
import { sendStuckRequestAdminAlert } from './email';

/** The slice of Hono's `Context` the Datadog helpers need, typed structurally so
 *  a cron-synthesised context (see `lib/reconciliation-sweep.ts`) fits — same
 *  shape as `lib/linear.ts`'s `LinearContext`. */
export type AlertContext = { env: Env; executionCtx: ExecutionContext; req: { raw: Request } };

/** One persistently-stuck request, summarised for the digest. */
export interface StuckRequestSummary {
  requestId: string;
  kind: RequestKind;
  targetType: RequestTargetType;
  /** Display name if the target resolved; `null` if the target row is gone. */
  targetName: string | null;
  /** Whole minutes the row has been stuck (`now - created_at`). */
  ageMinutes: number;
}

/** A single digest covering every persistently-stuck request found this sweep. */
export interface AdminAlert {
  kind: 'stuck_requests';
  rows: StuckRequestSummary[];
}

export type AdminAlertOutcome = 'sent' | 'failed' | 'skipped';

/**
 * Deliver the admin alert via Resend (`lib/email.ts`). **Never throws** (mirrors
 * `linearGraphql`) — a telemetry or transport failure must not break the sweep.
 * Returns the send `outcome`; an absent `RESEND_API_KEY` / `ADMIN_ALERT_EMAIL`
 * yields `'skipped'`, in which case the caller has already raised the Datadog
 * alert, which is the guaranteed backstop (§6.2).
 *
 * The sweep injects this as a dependency so its tests can assert the seam fires
 * on a persistent failure (the issue's "persistent failure emails" criterion)
 * without a real transport.
 */
export async function sendAdminAlert(
  c: AlertContext,
  alert: AdminAlert,
): Promise<AdminAlertOutcome> {
  const outcome: AdminAlertOutcome = await sendStuckRequestAdminAlert(c, {
    to: c.env.ADMIN_ALERT_EMAIL,
    rows: alert.rows,
  });
  emitEmailMetric(c, outcome);
  log(c, {
    level: outcome === 'failed' ? 'warn' : 'info',
    message: `aeci.linear.reconcile.email outcome=${outcome} rows=${alert.rows.length}${
      c.env.ADMIN_ALERT_EMAIL ? ` recipient=${c.env.ADMIN_ALERT_EMAIL}` : ' recipient=unset'
    }`,
    request_ids: alert.rows.map((r) => r.requestId),
  });
  return outcome;
}

/** Emit the `aeci.linear.reconcile.email` outcome count. Wrapped so a missing
 *  `DD_API_KEY` / ExecutionContext can never turn the no-op into a throw. */
function emitEmailMetric(c: AlertContext, outcome: AdminAlertOutcome): void {
  try {
    submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.linear.reconcile.email', 1, [
      `outcome:${outcome}`,
    ]);
  } catch {
    // Telemetry must never break the sweep.
  }
}

function log(
  c: AlertContext,
  entry: { level: 'info' | 'warn' | 'error'; message: string } & Record<string, unknown>,
): void {
  try {
    logToDatadog(c.executionCtx, c.env, c.req.raw, { source: 'reconcile', ...entry });
  } catch {
    console[entry.level === 'error' ? 'error' : 'warn'](`reconcile-alert: ${entry.message}`);
  }
}
