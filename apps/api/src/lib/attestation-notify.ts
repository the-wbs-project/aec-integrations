/**
 * The §7.2/§7.3 notification sweep (AECI-302 / `STAGE_2_ATTESTATIONS_SPEC.md` §7).
 *
 * Takes the findings `lib/attestation-detectors.ts` produced, decides which are
 * new, resolves who to email, sends through Resend, and records each successful
 * send in `audit_log`. **Email-only** at launch (epic decision §1.3(4)); the
 * real-time channel is AECI-516 and nothing here assumes it.
 *
 * ## The ledger is the whole design (§7.3)
 *
 * There is no notifications table (decision §1.3(6)). Suppression, history and the
 * in-portal list all read one `audit_log` shape:
 *
 *   action: 'notification.sent'   entity_type: 'claim'   entity_id: <claim id>
 *   metadata: { detector, vendorId, … the send-time snapshot }
 *
 * Consequences worth stating, because they are easy to get wrong later:
 *
 * - **Write only after a successful send.** A `failed` or `skipped` send leaves no
 *   row, so tomorrow's sweep retries it. Writing on attempt would silently consume
 *   the nudge — the failure mode nobody notices for a month.
 * - **`actor_type` is `'system'`** (the `audit_log_actor_type_check` value for a
 *   cron) and `actor_id` stays null, because it is an FK to `profiles` and no
 *   profile did this.
 * - **`vendorId: null` means AECi ops**, so an ops row can never match a vendor
 *   caller's `GET /api/vendor/notifications` filter. That is the isolation, and it
 *   is structural rather than a `WHERE` clause someone must remember.
 *
 * ## Fail-open, everywhere
 *
 * `sendTransactionalEmail` never throws: no `RESEND_API_KEY` is `'skipped'`, a
 * Resend outage is `'failed'`. Neither aborts the sweep (§7 AC #4). Likewise a
 * missing `SUPABASE_SERVICE_ROLE_KEY` yields an empty email map, which is
 * `'skipped'` and *not* a ledger row — the nudge survives to be sent once the key
 * exists, instead of being marked delivered on a preview.
 *
 * Only genuinely unexpected throws (a D1 read failure) propagate, so the queue
 * consumer retries; that is safe because detection is pure and the ledger makes a
 * re-run idempotent for everything already delivered.
 */

import type { AttestationDetector, AuditLogEntry, NotificationProductRef } from '@aeci/shared';
import { forwardAuditLog } from '@aeci/shared';
import { and, eq, gte } from 'drizzle-orm';

import { auditInsert, type BatchStmt, type BatchTuple } from './audit';
import {
  findingsOf,
  runAttestationDetectors,
  type DetectorFinding,
  type DetectorResult,
} from './attestation-detectors';
import {
  emitDetectorMetrics,
  emitNotifyOutcomeMetrics,
  type AttestationNotifyMetricSink,
  type NotifyOutcome,
} from './attestation-notify-metrics';
import {
  parseRecipients,
  sendAttestationOpenConflictEmail,
  sendAttestationOpsAlertEmail,
  sendAttestationSilentCounterpartyEmail,
  sendAttestationStaleVersionEmail,
  type EmailContext,
  type EmailOutcome,
} from './email';
import { VENDOR_ADMIN_ROLE } from './claimed-vendors';
import { fetchAuthUserEmails } from './supabase-admin';
import type { Db } from '../db/client';
import { auditLog } from '../db/schema';
import { logToDatadog } from '../datadog';
import type { Env } from '../env';

const DAY_MS = 86_400_000;

/** `audit_log.action` for a delivered notification — the §7.3 ledger key. Shared
 *  with `routes/vendor-notifications.ts`, which reads the same rows. */
export const NOTIFICATION_SENT_ACTION = 'notification.sent';

/** `audit_log.entity_type` for the same rows (§7.3). `entity_type` is deliberately
 *  unconstrained in the schema, so this needs no migration. */
export const NOTIFICATION_ENTITY_TYPE = 'claim';

/** How long a delivered notification suppresses the same (claim, detector,
 *  recipient) triple. The anti-nag control: a daily sweep must not re-send daily,
 *  so at most one nudge per claim per detector per month. Launch-tunable —
 *  `docs/POST_LAUNCH_MONITORING.md` §3. */
export const NOTIFICATION_SUPPRESSION_DAYS = 30;

/** Most notifications delivered per run. A backstop against a first-adoption
 *  spike, not a design limit: the next daily sweep continues the backlog, and the
 *  sweep logs the dropped count rather than truncating silently. */
export const NOTIFY_BATCH_CAP = 200;

/** Ledger rows per `db.batch`. Chunked rather than one batch at the end so a batch
 *  failure costs at most this many suppressions (which would re-send tomorrow)
 *  instead of the whole run's. */
const LEDGER_CHUNK = 25;

/** Vendor ids per seat lookup. D1 caps bound parameters per query, so an
 *  `inArray` over an unbounded id list is a latent failure once adoption grows. */
const SEAT_LOOKUP_CHUNK = 50;

/**
 * Most-signal-first, so the {@link NOTIFY_BATCH_CAP} drops the least urgent work
 * if it ever bites — and so the cap is deterministic enough to test.
 */
const DETECTOR_PRIORITY: readonly AttestationDetector[] = [
  'open-conflict',
  'aeci-denied',
  'silent-counterparty',
  'stale-version',
];

// ─── Context + deps ──────────────────────────────────────────────────────────

/** Same structural context the email + Datadog seams take, so the cron can build
 *  one from a synthetic `Request` (`scheduled.ts`'s `cronRequest`). */
export type NotifyContext = EmailContext;

export type FetchSeatEmails = (
  env: Env,
  userIds: readonly string[],
) => Promise<Map<string, string>>;

export interface NotifyDeps {
  /** Deterministic clock for the threshold + suppression math. */
  now?: Date;
  /** The privileged `auth.users` email seam. Injected so specs never touch it. */
  fetchSeatEmails?: FetchSeatEmails;
  /** Detector pass. Injected so the sweep's own specs can drive synthetic findings
   *  without seeding a full claim graph (the detectors have their own suite). */
  runDetectors?: typeof runAttestationDetectors;
  /** Metric sink. Absent → metrics are simply not emitted (local/preview). */
  metrics?: AttestationNotifyMetricSink;
}

export interface NotifyResult {
  detectors: DetectorResult[];
  /** Findings the detectors produced, before suppression. */
  found: number;
  /** Findings a ledger row inside the window already covered. */
  suppressed: number;
  /** Findings dropped by {@link NOTIFY_BATCH_CAP} this run. */
  capped: number;
  sent: number;
  failed: number;
  skipped: number;
}

// ─── Ledger metadata ─────────────────────────────────────────────────────────

/**
 * What a ledger row records beyond §7.3's required `{ detector, vendorId }`.
 *
 * The extra keys are a deliberate extension: they are what make §7.2's "gives the
 * in-portal list its backing query for free" literally true. The list renders from
 * this snapshot with **zero joins**, and a year-old notification stays legible
 * after the claim it names has been re-curated or deleted.
 */
export interface NotificationLedgerMetadata {
  detector: AttestationDetector;
  /** `null` = AECi ops. Never matches a vendor caller. */
  vendorId: string | null;
  integrationId: string;
  dataObject: NotificationProductRef;
  counterpartProduct: NotificationProductRef | null;
  pairSlugs: readonly [string, string];
}

function ledgerEntry(finding: DetectorFinding): AuditLogEntry {
  const metadata: NotificationLedgerMetadata = {
    detector: finding.detector,
    vendorId: finding.vendorId,
    integrationId: finding.integrationId,
    dataObject: finding.context.dataObject,
    counterpartProduct: finding.context.counterpartProduct,
    pairSlugs: finding.context.pairSlugs,
  };
  return {
    actorId: null,
    actorType: 'system',
    action: NOTIFICATION_SENT_ACTION,
    entityType: NOTIFICATION_ENTITY_TYPE,
    entityId: finding.claimId,
    metadata,
  };
}

/** The suppression identity of a finding. Recipient is part of the key: nudging
 *  vendor A about a conflict must not suppress the identical nudge to vendor B. */
function suppressionKey(claimId: string, detector: string, vendorId: string | null): string {
  return `${claimId}|${detector}|${vendorId ?? '~ops'}`;
}

/**
 * Ledger rows inside the suppression window, as a key set.
 *
 * One query per sweep rather than one per finding — served by
 * `audit_log_action_idx (action, created_at)`, which is exactly this shape. The
 * `metadata` match happens in memory because it is unindexed JSON; the window
 * bounds how much there is to match against.
 */
async function loadSuppressed(db: Db, windowStartIso: string): Promise<Set<string>> {
  const rows = await db
    .select({ entityId: auditLog.entityId, metadata: auditLog.metadata })
    .from(auditLog)
    .where(
      and(eq(auditLog.action, NOTIFICATION_SENT_ACTION), gte(auditLog.createdAt, windowStartIso)),
    );

  const keys = new Set<string>();
  for (const row of rows) {
    const meta = row.metadata as Partial<NotificationLedgerMetadata> | null;
    if (!row.entityId || !meta?.detector) continue;
    keys.add(suppressionKey(row.entityId, meta.detector, meta.vendorId ?? null));
  }
  return keys;
}

// ─── Recipients ──────────────────────────────────────────────────────────────

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Email addresses per vendor for the seats we may nudge.
 *
 * **Banned seats are excluded** — unlike `seatsOf` in `routes/vendor.ts`, which
 * deliberately keeps them on the roster so co-admins can see a colleague is locked
 * out. A banned seat cannot act on a nudge (every `/api/vendor/*` call fails the
 * §4.2 ban check), so emailing it is noise at best.
 *
 * Degrades to an empty map without `SUPABASE_SERVICE_ROLE_KEY`: `profiles` holds
 * no email column, addresses live in Supabase `auth.users`, and local dev / PR
 * previews legitimately lack the key.
 */
async function loadVendorSeatEmails(
  db: Db,
  env: Env,
  vendorIds: readonly string[],
  fetchSeatEmails: FetchSeatEmails,
): Promise<Map<string, string[]>> {
  const unique = [...new Set(vendorIds)];
  if (unique.length === 0) return new Map();

  const seats: Array<{ id: string; vendorId: string | null }> = [];
  for (const batch of chunk(unique, SEAT_LOOKUP_CHUNK)) {
    seats.push(
      ...(await db.query.profiles.findMany({
        columns: { id: true, vendorId: true },
        where: (p, { and: andOp, eq: eqOp, inArray: inArrayOp, isNull: isNullOp }) =>
          andOp(
            inArrayOp(p.vendorId, batch),
            eqOp(p.role, VENDOR_ADMIN_ROLE),
            isNullOp(p.bannedAt),
          ),
      })),
    );
  }
  if (seats.length === 0) return new Map();

  const emails = await fetchSeatEmails(
    env,
    seats.map((s) => s.id),
  );

  const byVendor = new Map<string, string[]>();
  for (const seat of seats) {
    const address = emails.get(seat.id);
    if (!seat.vendorId || !address) continue;
    const list = byVendor.get(seat.vendorId);
    if (list) list.push(address);
    else byVendor.set(seat.vendorId, [address]);
  }
  return byVendor;
}

// ─── Sending ─────────────────────────────────────────────────────────────────

function sendForFinding(
  c: NotifyContext,
  finding: DetectorFinding,
  to: string,
): Promise<EmailOutcome> {
  const shared = {
    to,
    dataObject: finding.context.dataObject.name,
    product: finding.context.subjectProduct.name,
    counterpart: finding.context.counterpartProduct.name,
    mechanismName: finding.context.mechanismName,
    pairSlugs: finding.context.pairSlugs,
  };
  switch (finding.detector) {
    case 'silent-counterparty':
      return sendAttestationSilentCounterpartyEmail(c, shared);
    case 'open-conflict':
      return sendAttestationOpenConflictEmail(c, shared);
    case 'stale-version':
      return sendAttestationStaleVersionEmail(c, shared);
    case 'aeci-denied':
      // Ops-only detector; a vendor address never reaches this branch (guarded by
      // `finding.vendorId === null` at the call site), but the switch stays total.
      return sendOpsForFinding(c, finding, to);
  }
}

function sendOpsForFinding(
  c: NotifyContext,
  finding: DetectorFinding,
  to: string,
): Promise<EmailOutcome> {
  return sendAttestationOpsAlertEmail(c, {
    to,
    detector: finding.detector === 'aeci-denied' ? 'aeci-denied' : 'open-conflict',
    dataObject: finding.context.dataObject.name,
    productA: finding.context.subjectProduct.name,
    productB: finding.context.counterpartProduct.name,
    mechanismName: finding.context.mechanismName,
    claimId: finding.claimId,
    integrationId: finding.integrationId,
    pairSlugs: finding.context.pairSlugs,
  });
}

/**
 * Collapse the per-address outcomes for one finding into the one that decides
 * whether a ledger row is written.
 *
 * `sent` if **any** address was delivered: the notification reached the vendor, so
 * suppressing the next 30 days is right even if a second seat's address bounced.
 * Otherwise `failed` beats `skipped`, because a failure is the more actionable
 * signal on the dashboard.
 */
function collapseOutcomes(outcomes: readonly EmailOutcome[]): NotifyOutcome {
  if (outcomes.includes('sent')) return 'sent';
  if (outcomes.includes('failed')) return 'failed';
  return 'skipped';
}

// ─── The sweep ───────────────────────────────────────────────────────────────

/**
 * Run one notification pass: detect, suppress, send, record.
 *
 * Returns counts for the caller to log; metrics go through the injected sink so
 * this module stays free of `ctx`/`env` plumbing.
 */
export async function runAttestationNotifySweep(
  c: NotifyContext,
  db: Db,
  deps: NotifyDeps = {},
): Promise<NotifyResult> {
  const now = deps.now ?? new Date();
  const fetchSeatEmails = deps.fetchSeatEmails ?? fetchAuthUserEmails;
  const runDetectors = deps.runDetectors ?? runAttestationDetectors;

  const detectors = await runDetectors({ db, now });
  if (deps.metrics) emitDetectorMetrics(deps.metrics, detectors);

  const found = findingsOf(detectors);
  const result: NotifyResult = {
    detectors,
    found: found.length,
    suppressed: 0,
    capped: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  };
  if (found.length === 0) return result;

  // Suppression first, then the cap — a suppressed backlog must not starve the
  // findings that actually need sending.
  const windowStartIso = new Date(
    now.getTime() - NOTIFICATION_SUPPRESSION_DAYS * DAY_MS,
  ).toISOString();
  const suppressed = await loadSuppressed(db, windowStartIso);
  const fresh = found.filter((f) => {
    if (!suppressed.has(suppressionKey(f.claimId, f.detector, f.vendorId))) return true;
    result.suppressed++;
    return false;
  });

  const ordered = [...fresh].sort(
    (a, b) =>
      DETECTOR_PRIORITY.indexOf(a.detector) - DETECTOR_PRIORITY.indexOf(b.detector) ||
      a.claimId.localeCompare(b.claimId) ||
      (a.vendorId ?? '').localeCompare(b.vendorId ?? ''),
  );
  const batch = ordered.slice(0, NOTIFY_BATCH_CAP);
  result.capped = ordered.length - batch.length;
  if (result.capped > 0) {
    // Never truncate silently — an operator reading the dashboard must be able to
    // tell "nothing to send" from "we stopped early".
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message: `aeci.attestation.notify.capped dropped=${result.capped} cap=${NOTIFY_BATCH_CAP}`,
      source: 'attestation-notify-cron',
      dropped: result.capped,
    });
  }

  const opsRecipients = parseRecipients(c.env.ADMIN_ALERT_EMAIL);
  const vendorEmails = await loadVendorSeatEmails(
    db,
    c.env,
    batch.flatMap((f) => (f.vendorId ? [f.vendorId] : [])),
    fetchSeatEmails,
  );

  const outcomes: Array<{ detector: AttestationDetector; outcome: NotifyOutcome }> = [];
  const pendingLedger: BatchStmt[] = [];
  const pendingForward: AuditLogEntry[] = [];

  for (const finding of batch) {
    const addresses = finding.vendorId ? (vendorEmails.get(finding.vendorId) ?? []) : opsRecipients;

    // No resolvable address is `skipped`, NOT a silent success — no ledger row, so
    // tomorrow's sweep tries again once the key / recipient exists.
    const sends: EmailOutcome[] = [];
    for (const to of addresses) {
      sends.push(
        finding.vendorId
          ? await sendForFinding(c, finding, to)
          : await sendOpsForFinding(c, finding, to),
      );
    }
    const outcome = collapseOutcomes(sends);
    outcomes.push({ detector: finding.detector, outcome });
    result[outcome === 'sent' ? 'sent' : outcome === 'failed' ? 'failed' : 'skipped']++;

    if (outcome !== 'sent') continue;
    const entry = ledgerEntry(finding);
    pendingLedger.push(auditInsert(db, entry));
    pendingForward.push(entry);
    if (pendingLedger.length >= LEDGER_CHUNK) {
      await flushLedger(c, db, pendingLedger.splice(0), pendingForward.splice(0));
    }
  }
  await flushLedger(c, db, pendingLedger, pendingForward);

  if (deps.metrics) emitNotifyOutcomeMetrics(deps.metrics, outcomes);
  return result;
}

/**
 * Commit one chunk of ledger rows, then forward them post-commit (§26.5).
 *
 * A batch failure is logged and swallowed rather than thrown: the emails in this
 * chunk are already delivered, and losing the sweep to a D1 hiccup would re-send
 * everything after it. The cost of the swallow is a duplicate nudge in 24 hours,
 * which is strictly better than aborting mid-run.
 */
async function flushLedger(
  c: NotifyContext,
  db: Db,
  statements: readonly BatchStmt[],
  entries: readonly AuditLogEntry[],
): Promise<void> {
  if (statements.length === 0) return;
  try {
    await db.batch([...statements] as BatchTuple);
  } catch (error) {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'error',
      message: 'aeci.attestation.notify.ledger_failed',
      source: 'attestation-notify-cron',
      rows: statements.length,
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  const forwarder = c.env.DD_API_KEY
    ? (entry: AuditLogEntry) => {
        logToDatadog(c.executionCtx, c.env, c.req.raw, {
          level: 'info',
          message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
          action: entry.action,
          entity_type: entry.entityType ?? undefined,
          entity_id: entry.entityId ?? undefined,
          source: 'attestation-notify-cron',
        });
      }
    : undefined;
  c.executionCtx.waitUntil(Promise.all(entries.map((entry) => forwardAuditLog(entry, forwarder))));
}
