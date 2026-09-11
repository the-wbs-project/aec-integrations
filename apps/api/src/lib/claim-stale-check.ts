/**
 * Claim-ticket staleness check (AECI-862 / `STAGE_1_PHASE_6_SPEC.md` §6.2).
 *
 * The §6.7 reconciliation sweep covers exactly one failure: a request whose Linear
 * issue was **never created**. Once the issue exists the pipeline considers itself
 * finished, so a ticket can sit in Backlog indefinitely with no signal to anyone.
 * That is the gap this closes — a claim that was filed correctly and then ignored.
 *
 * Every six hours it reads the claims that are past `STALE_THRESHOLD_HOURS` and
 * have a linked issue, asks Linear what state each of those issues is actually in,
 * and emails `FOUNDER_ALERT_EMAIL` one digest naming the ones nobody has started.
 *
 * ── IT ASKS LINEAR, NOT D1 ────────────────────────────────────────────────────
 * `vendor_requests.status` advances past `open` only when the §6.3 inbound webhook
 * delivers, which needs `LINEAR_WEBHOOK_SIGNING_SECRET` on the Worker **and** a
 * webhook registered in Linear pointing at this environment. Neither is confirmed
 * — it is still the open operator action on AECI-851, and production logged no
 * webhook-driven status change in the window surveyed when this was written.
 *
 * If the webhook is dark, every row reads `open` forever and a D1-only check would
 * warn about every ticket the operator had already picked up. A warning channel
 * that cries wolf is worse than no warning channel, so this pays four GraphQL
 * queries a day for an answer that cannot be wrong in that direction. The local
 * status is still read, but only to REPORT the disagreement (see below).
 *
 * ── THE THROTTLE IS NOT OPTIONAL ──────────────────────────────────────────────
 * Without age bands a single stale ticket emails four times a day forever. That is
 * the hazard AECI-854 removed from the reconciliation sweep, on the same Resend
 * account that carries Supabase magic links. `lib/alert-bands.ts` is the shared
 * arithmetic: first warning as the ticket crosses 24 hours, then once a day.
 * Stateless — no `warned_at` column, no migration (ADR 0013).
 *
 * The metric and the log are NOT throttled, matching the sweep: the email is a
 * convenience, the metric is the record.
 *
 * ── WEBHOOK DRIFT IS REPORTED, NOT REPAIRED ───────────────────────────────────
 * Because it holds both answers, this job can see when Linear says `started` while
 * the local row still says `open`. That is inbound-webhook drift, and it is worth
 * knowing. It is NOT repaired here: writing `vendor_requests.status` is a domain
 * write and would need its own `audit_log` row in the same `db.batch` (§26.1), a
 * `workflow_transitions` row, and a decision about which side wins. That is its
 * own issue, not a side effect of a read-only sweep.
 *
 * Queue-less and inline, following the §6.2 moderation-snapshot and WAF-poll
 * precedent: one indexed read, one batched GraphQL call, one fail-open email does
 * not justify a queue binding in three wrangler blocks. A missed run costs at most
 * six hours of warning latency, and the next run re-derives everything from
 * `created_at`.
 */

import type { RequestKind } from '@aeci/shared';
import { and, asc, eq, isNotNull, lt } from 'drizzle-orm';

import { crossedBand } from './alert-bands';
import type { AlertContext } from './admin-alert';
import { sendStaleClaimTicketAlert, type StaleClaimSummary } from './email';
import { fetchLinearIssueStates } from './linear';
import { NOTIFIED_REQUEST_KINDS, adminRequestUrl } from './request-links';
import type { Db } from '../db/client';
import { products, vendorRequests, vendors } from '../db/schema';
import { logToPosthog, submitCount, submitGauge } from '../posthog';

const MINUTE_MS = 60_000;

/** A claim whose ticket is older than this and still un-started is warned about. */
export const STALE_THRESHOLD_HOURS = 24;

/** How often this job runs, in minutes. MUST match `CLAIM_STALE_CRON`
 *  (`lib/cron-schedules.ts`) — `claim-stale-check.spec.ts` asserts the pair,
 *  because the email throttle is computed from it and a silent drift would either
 *  double-send or skip a band. */
export const STALE_CHECK_INTERVAL_MINUTES = 360;

/** Ages (minutes) at which a stale ticket EMAILS. Past the last one, once a day.
 *  One band, because the threshold IS the first band: 24h. */
export const STALE_ALERT_BANDS_MINUTES = [STALE_THRESHOLD_HOURS * 60] as const;

/** Repeat interval (minutes) past the final band — one email a day. */
export const STALE_ALERT_REPEAT_MINUTES = 1440;

/**
 * Most claims inspected per run. A backlog bound, like the sweep's: at this
 * cadence the next run continues, and the job logs a warn when it caps rather than
 * truncating silently. Also keeps the batched Linear query inside its `first: 250`
 * ceiling with room to spare.
 */
export const STALE_BATCH_CAP = 100;

/**
 * Linear workflow-state CATEGORIES that mean somebody has the ticket. Keyed on
 * `state.type`, the fixed enum, never the workspace's custom `state.name` — the
 * same reasoning as the §6.3 webhook's map, so renaming "In Progress" in Linear
 * cannot silently break this.
 *
 * `completed` and `canceled` count as not-stale: a ticket that went straight from
 * Backlog to Done inside 24 hours was handled, and warning about it would be
 * noise. The complement (`triage`, `backlog`, `unstarted`) is what we warn on.
 */
const ACTIVE_STATE_TYPES: ReadonlySet<string> = new Set(['started', 'completed', 'canceled']);

export interface ClaimStaleDeps {
  /** The Linear read seam, injected so tests drive states without a transport. */
  fetchStates?: typeof fetchLinearIssueStates;
  /** The digest email seam, injected so tests assert it fires. */
  sendAlert?: typeof sendStaleClaimTicketAlert;
  /** `now` for deterministic age math (mirrors the reconciliation sweep). */
  now?: Date;
}

export interface ClaimStaleResult {
  /** Claims past the threshold with a linked issue — the population inspected. */
  checked: number;
  /** Of those, the ones Linear reports as still un-started. */
  stale: number;
  /** Rows where Linear says started/done but `vendor_requests.status` says open. */
  drifted: number;
  /** Whether the digest email seam was invoked (band-throttled). */
  alerted: boolean;
  /** Set when the Linear read failed; no warning is sent on a failed read. */
  failedReason?: string;
}

/** Run one staleness pass. Per-row errors are contained; an unexpected throw
 *  propagates to the dispatcher, which records the `job_runs` failure. */
export async function runClaimStaleCheck(
  c: AlertContext,
  db: Db,
  deps: ClaimStaleDeps = {},
): Promise<ClaimStaleResult> {
  const fetchStates = deps.fetchStates ?? fetchLinearIssueStates;
  const sendAlert = deps.sendAlert ?? sendStaleClaimTicketAlert;
  const now = deps.now ?? new Date();
  const nowMs = now.getTime();
  // `created_at` is ISO-8601 TEXT under D1, which compares lexically, so the
  // cutoff is a string — same idiom as the reconciliation sweep.
  const cutoffIso = new Date(nowMs - STALE_THRESHOLD_HOURS * 60 * MINUTE_MS).toISOString();

  // `kind` is filtered through the shared set rather than a literal, so admitting
  // corrections later is one edit in `request-links.ts` (AECI-861).
  const kinds = [...NOTIFIED_REQUEST_KINDS];
  const rows = (await db.query.vendorRequests.findMany({
    columns: {
      id: true,
      kind: true,
      status: true,
      targetType: true,
      targetId: true,
      submitterEmail: true,
      linearIssueId: true,
      linearIssueUrl: true,
      createdAt: true,
    },
    where: and(
      eq(vendorRequests.status, 'open'),
      isNotNull(vendorRequests.linearIssueId),
      lt(vendorRequests.createdAt, cutoffIso),
      kinds.length === 1 ? eq(vendorRequests.kind, kinds[0]!) : undefined,
    ),
    orderBy: asc(vendorRequests.createdAt),
    limit: STALE_BATCH_CAP,
  })) as unknown as Array<{
    id: string;
    kind: RequestKind;
    status: string;
    targetType: 'product' | 'vendor';
    targetId: string;
    submitterEmail: string;
    linearIssueId: string;
    linearIssueUrl: string | null;
    createdAt: string;
  }>;

  // Always emit the gauge, 0 included, so a no-data monitor can tell "ran clean"
  // from "did not run" (mirrors the sweep and index-drift).
  gauge(c, 'aeci.linear.claim_stale.checked', rows.length);

  if (rows.length === 0) {
    gauge(c, 'aeci.linear.claim_stale.stale', 0);
    log(c, {
      level: 'info',
      message: 'aeci.linear.claim_stale: no open claims past the threshold',
    });
    return { checked: 0, stale: 0, drifted: 0, alerted: false };
  }
  if (rows.length === STALE_BATCH_CAP) {
    log(c, {
      level: 'warn',
      message: `aeci.linear.claim_stale: hit the ${STALE_BATCH_CAP}-row cap — the next run continues`,
    });
  }

  // One request for every id (AECI-666: never a per-issue fan-out).
  const states = await fetchStates(
    c.env,
    rows.map((r) => r.linearIssueId),
  );
  if (!states.ok) {
    // A read we could not make is not evidence that anyone is ignoring anything.
    // Report it and send nothing — a false warning costs more than a late one.
    gauge(c, 'aeci.linear.claim_stale.stale', 0);
    count(c, 'aeci.linear.claim_stale.read_failure', 1, [`reason:${states.reason}`]);
    log(c, {
      level: states.reason === 'no_api_key' ? 'info' : 'warn',
      message: `aeci.linear.claim_stale: could not read Linear (${states.reason}) — no warning sent`,
    });
    return {
      checked: rows.length,
      stale: 0,
      drifted: 0,
      alerted: false,
      failedReason: states.reason,
    };
  }

  const stale: StaleClaimSummary[] = [];
  let drifted = 0;
  for (const row of rows) {
    const issue = states.issues.get(row.linearIssueId);
    // Absent means Linear did not return it — deleted, or outside this key's
    // scope. "Cannot tell" is not "stale"; warning on it would be a guess.
    if (!issue) {
      log(c, {
        level: 'warn',
        message: `aeci.linear.claim_stale: issue ${row.linearIssueId} for request ${row.id} not returned by Linear — skipping`,
      });
      continue;
    }
    if (issue.stateType && ACTIVE_STATE_TYPES.has(issue.stateType)) {
      // Linear has moved on but our row still says `open`: §6.3 webhook drift.
      // Reported, never repaired — see the file header.
      drifted++;
      continue;
    }
    const ageMinutes = Math.max(0, Math.floor((nowMs - Date.parse(row.createdAt)) / MINUTE_MS));
    stale.push({
      requestId: row.id,
      kind: row.kind,
      identifier: issue.identifier,
      title: issue.title,
      issueUrl: issue.url ?? row.linearIssueUrl ?? null,
      adminUrl: adminRequestUrl(c.env, row.kind, row.id),
      stateName: issue.stateName,
      submitterEmail: row.submitterEmail,
      targetName: await resolveTargetName(db, row.targetType, row.targetId),
      ageMinutes,
    });
  }

  gauge(c, 'aeci.linear.claim_stale.stale', stale.length);
  if (drifted > 0) {
    count(c, 'aeci.linear.claim_stale.webhook_drift', drifted, []);
    log(c, {
      level: 'warn',
      message: `aeci.linear.claim_stale.webhook_drift: ${drifted} claim(s) are started/closed in Linear but still 'open' locally — the §6.3 inbound webhook may not be delivering`,
    });
  }

  let alerted = false;
  if (stale.length > 0) {
    // Unthrottled, like the sweep's: the metric and the log are the record.
    log(c, {
      level: 'warn',
      message: `aeci.linear.claim_stale: ${stale.length} claim ticket(s) un-started after ${STALE_THRESHOLD_HOURS}h`,
      request_ids: stale.map((r) => r.requestId),
      identifiers: stale.map((r) => r.identifier),
    });

    const emailRows = stale.filter((r) =>
      crossedBand(
        r.ageMinutes,
        STALE_CHECK_INTERVAL_MINUTES,
        STALE_ALERT_BANDS_MINUTES,
        STALE_ALERT_REPEAT_MINUTES,
      ),
    );
    if (emailRows.length > 0) {
      const outcome = await sendAlert(c, { to: c.env.FOUNDER_ALERT_EMAIL, rows: emailRows });
      alerted = true;
      count(c, 'aeci.linear.claim_stale.email', 1, [`outcome:${outcome}`]);
      log(c, {
        level: outcome === 'failed' ? 'warn' : 'info',
        message: `aeci.linear.claim_stale.email outcome=${outcome} rows=${emailRows.length}${
          c.env.FOUNDER_ALERT_EMAIL ? ` recipient=${c.env.FOUNDER_ALERT_EMAIL}` : ' recipient=unset'
        }`,
      });
    } else {
      log(c, {
        level: 'info',
        message: `aeci.linear.claim_stale: ${stale.length} stale row(s), none crossed an alert band this run — email suppressed`,
      });
    }
  }

  return { checked: rows.length, stale: stale.length, drifted, alerted };
}

/** Display name for a `target_id`, or `null` if the target row is gone. Mirrors
 *  `resolveTargetById` in the reconciliation sweep. */
async function resolveTargetName(
  db: Db,
  targetType: 'product' | 'vendor',
  targetId: string,
): Promise<string | null> {
  if (targetType === 'product') {
    const row = await db.query.products.findFirst({
      columns: { name: true },
      where: eq(products.id, targetId),
    });
    return row?.name ?? null;
  }
  const row = await db.query.vendors.findFirst({
    columns: { companyName: true },
    where: eq(vendors.id, targetId),
  });
  return row?.companyName ?? null;
}

// ─── Telemetry (wrapped so it never breaks the job) ───────────────────────────

function gauge(c: AlertContext, metric: string, value: number): void {
  try {
    submitGauge(c.executionCtx, c.env, c.req.raw, metric, value, []);
  } catch {
    // Telemetry must never break the job.
  }
}

function count(c: AlertContext, metric: string, value: number, tags: string[]): void {
  try {
    submitCount(c.executionCtx, c.env, c.req.raw, metric, value, tags);
  } catch {
    // Telemetry must never break the job.
  }
}

function log(
  c: AlertContext,
  entry: { level: 'info' | 'warn' | 'error'; message: string } & Record<string, unknown>,
): void {
  try {
    logToPosthog(c.executionCtx, c.env, c.req.raw, { ...entry, source: 'claim-stale-check' });
  } catch {
    // Telemetry must never break the job.
  }
}
