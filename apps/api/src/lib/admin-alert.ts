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
 * + the Datadog alert are the guaranteed backstop" until Loops lands.
 *
 * **Loops transactional email is a Phase 7 deliverable** (§14). Until then this
 * seam is a fail-open structured no-op: it emits `aeci.linear.reconcile.email`
 * with `outcome:skipped`, logs that an alert *would* be emailed (to
 * `ADMIN_ALERT_EMAIL` once set), and returns `'skipped'`. It mirrors the
 * absent-`LINEAR_API_KEY` posture (`lib/linear.ts`): the missing transport is the
 * expected state, not an error. Kept as its own module so Phase 7 swaps the
 * transport (and its test) in one place without touching the sweep.
 */

import type { RequestKind, RequestTargetType } from '@aeci/shared';

import { logToDatadog, submitCount } from '../datadog';
import type { Env } from '../env';

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
 * Deliver the admin alert. **Never throws** (mirrors `linearGraphql`) — a
 * telemetry or transport failure must not break the sweep. Until Phase 7 wires
 * Loops this always returns `'skipped'`; the caller has already raised the
 * Datadog alert, which is the guaranteed backstop.
 *
 * The sweep injects this as a dependency so its tests can assert the seam fires
 * on a persistent failure (the issue's "persistent failure emails" criterion)
 * without a real transport.
 */
export async function sendAdminAlert(
  c: AlertContext,
  alert: AdminAlert,
): Promise<AdminAlertOutcome> {
  // ── Phase 7 / Loops: replace this block with the transactional send. ──
  // TODO(AECI Phase 7 / Loops): POST the digest to Loops' transactional API
  //   (recipient `c.env.ADMIN_ALERT_EMAIL`), returning 'sent' / 'failed' and
  //   emitting `outcome:sent|failed`. Keep the absent-key path below as the
  //   fail-open no-op (mirrors LINEAR_API_KEY). See STAGE_1_PHASE_6_SPEC.md §14.
  const outcome: AdminAlertOutcome = 'skipped';
  emitEmailMetric(c, outcome);
  log(c, {
    level: 'info',
    message: `aeci.linear.reconcile.email outcome=${outcome} rows=${alert.rows.length}${
      c.env.ADMIN_ALERT_EMAIL ? ` recipient=${c.env.ADMIN_ALERT_EMAIL}` : ' recipient=unset'
    } (Loops deferred to Phase 7 — Datadog alert is the backstop)`,
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
