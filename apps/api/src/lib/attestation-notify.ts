/**
 * The §7.2/§7.3 notification sweep (AECI-302, digest since AECI-1204 /
 * `STAGE_2_ATTESTATIONS_SPEC.md` §7).
 *
 * Takes the findings `lib/attestation-detectors.ts` produced, decides which are
 * due, and then:
 *
 *   1. groups the due vendor findings by vendor, then by seat;
 *   2. sends ONE `attestation-digest` per unmuted seat per day, listing every due
 *      finding for that seat's vendor;
 *   3. sends ONE `attestation-ops-digest` per `SUPPORT_EMAIL` address per day,
 *      listing every due ops finding;
 *   4. records every due finding in `audit_log` (the ledger that is also the portal
 *      row), unless delivery failed or could not be attempted.
 *
 * Before AECI-1204 each finding was its own email to every seat: 40 findings meant
 * 40 emails per seat in one morning, on the Resend account that also sends sign-in
 * links. A complaint spike there could block sign-in for everyone.
 *
 * ## The ledger is the whole design (§7.3)
 *
 * There is no notifications table (decision §1.3(6)). Suppression, history and the
 * in-portal list all read one `audit_log` shape:
 *
 *   action: 'notification.sent'   entity_type: 'claim'   entity_id: <claim id>
 *   metadata: { detector, vendorId, emailedSeats, … the send-time snapshot }
 *
 * **When a ledger row is written** (one per due finding, per vendor or ops):
 *
 * | Seat outcomes for the vendor                                | Row? | Finding outcome |
 * |-------------------------------------------------------------|------|-----------------|
 * | at least one seat `sent`, `duplicate` or `unknown`          | yes  | `sent`          |
 * | otherwise, and any seat `failed`                            | no   | `failed`        |
 * | otherwise, no seat `skipped`, and at least one seat muted,  |      |                 |
 * |   tier-suppressed or operator-paused (AECI-1224)            | yes  | `portal-only`   |
 * | otherwise (no seat, no address, no key)                     | no   | `skipped`       |
 *
 * A muted seat chose not to get email, the tier policy refuses on purpose, and an
 * operator who paused the digest on this tier chose the same for every seat. All three
 * are final answers, so the finding is recorded and the vendor sees it in the
 * portal. That holds when the other seats had no address, too: `['muted',
 * 'no-address']` is `portal-only`, because no retry can email the muted seat and the
 * seat with no address will not grow one by tomorrow (AECI-1197 review). A Resend
 * failure or a missing key (`skipped`) is not an answer, even beside a muted seat: writing the row would consume the nudge
 * silently for 30 days, so no row is written and tomorrow retries.
 *
 * `unknown` (AECI-1197 review) counts as emailed. The call timed out or threw after
 * the request may have reached Resend, so the seat most likely got the digest. Its
 * dedupe key stays held, so a same-day retry would be a `duplicate` anyway. Writing
 * the row is the honest reading of "probably sent". Not writing it would re-list the
 * finding tomorrow under a new day key, which is the double nudge the key exists to
 * stop.
 * `duplicate` counts as emailed because the digest key is held by an earlier send of
 * today's digest. That is a same-day re-run, after a killed run or a manual re-trigger.
 * A failed ledger flush is swallowed, not retried, so its findings are re-listed in
 * tomorrow's digest under a new day key. The cost is a
 * finding that first appeared in a same-day re-run: it is recorded as emailed though
 * the earlier digest did not list it. The sweep runs once a day, so that window is a
 * queue retry.
 *
 * Other rules, easy to get wrong later:
 *
 * - **`actor_type` is `'system'`** and `actor_id` stays null: it is an FK to
 *   `profiles` and no profile did this.
 * - **`vendorId: null` means AECi ops**, so an ops row can never match a vendor
 *   caller's `GET /api/vendor/notifications` filter.
 * - **Nothing is recorded if the run aborts before sending.** Every read and the
 *   lazy preference create happen before the first send, and they throw.
 *
 * ## Fail-open, everywhere
 *
 * `sendTransactionalEmail` never throws: no `RESEND_API_KEY` is `'skipped'`, a
 * Resend outage is `'failed'`. Neither aborts the sweep (§7 AC #4). A missing
 * `SUPABASE_SERVICE_ROLE_KEY` yields no seat addresses, which is `skipped` with no
 * ledger row, so the nudge survives to be sent once the key exists.
 *
 * Only genuinely unexpected throws (a D1 failure) propagate, so the queue consumer
 * retries. That is safe: detection is pure, the ledger suppresses what was recorded,
 * and the digest dedupe key stops a second send to a seat the same day.
 */

import type { AttestationDetector, AuditLogEntry, NotificationProductRef } from '@aeci/shared';
import { and, eq, gte, inArray } from 'drizzle-orm';

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
  sendAttestationDigestEmail,
  sendAttestationOpsDigestEmail,
  type AttestationDigestFinding,
  type AttestationOpsDigestFinding,
  type EmailContext,
  type EmailOutcome,
} from './email';
import { VENDOR_ADMIN_ROLE } from './claimed-vendors';
import { recipientHash } from './hash';
import {
  ensureNudgePreferences,
  isNudgeMuted,
  loadNudgePreferences,
} from './notification-preferences';
import { fetchAuthUserEmails } from './supabase-admin';
import type { Db } from '../db/client';
import { auditLog, vendors } from '../db/schema';
import type { AttestationNotificationId } from './notifications/registry';
import { logBatchToPosthog, logToPosthog } from '../posthog';
import type { Env } from '../env';

const DAY_MS = 86_400_000;

/** `audit_log.action` for a recorded notification — the §7.3 ledger key. Shared
 *  with `routes/vendor-notifications.ts`, which reads the same rows. */
export const NOTIFICATION_SENT_ACTION = 'notification.sent';

/** `audit_log.entity_type` for the same rows (§7.3). `entity_type` is deliberately
 *  unconstrained in the schema, so this needs no migration. */
export const NOTIFICATION_ENTITY_TYPE = 'claim';

/** How long a recorded finding suppresses the same (claim, detector, recipient)
 *  triple. The anti-nag control: at most one listing per claim per detector per
 *  month. Launch-tunable — `docs/POST_LAUNCH_MONITORING.md` §3. */
export const NOTIFICATION_SUPPRESSION_DAYS = 30;

/** Most findings handled per run. A backstop against a first-adoption spike, not a
 *  design limit: the next daily sweep continues the backlog, and the sweep logs the
 *  dropped count rather than truncating silently. */
export const NOTIFY_BATCH_CAP = 200;

/** Ledger rows per `db.batch`. Chunked so a batch failure costs at most this many
 *  suppressions instead of the whole run's. */
const LEDGER_CHUNK = 25;

/** Vendor ids per seat lookup. D1 caps bound parameters per query. */
const SEAT_LOOKUP_CHUNK = 50;

/**
 * Most-signal-first, so the {@link NOTIFY_BATCH_CAP} drops the least urgent work
 * if it ever bites, and so the digest lists the most urgent findings first.
 */
const DETECTOR_PRIORITY: readonly AttestationDetector[] = [
  'open-conflict',
  'claim-denied',
  'silent-counterparty',
  'stale-version',
];

// ─── Context + deps ──────────────────────────────────────────────────────────

/** Same structural context the email seams take, so the cron can build one from a
 *  synthetic `Request` (`scheduled.ts`'s `cronRequest`). */
export type NotifyContext = EmailContext;

export type FetchSeatEmails = (
  env: Env,
  userIds: readonly string[],
) => Promise<Map<string, string>>;

export interface NotifyDeps {
  /** Deterministic clock for the threshold, suppression and digest-day math. */
  now?: Date;
  /** The privileged `auth.users` email seam. Injected so specs never touch it. */
  fetchSeatEmails?: FetchSeatEmails;
  /** Detector pass. Injected so the sweep's own specs can drive synthetic findings. */
  runDetectors?: typeof runAttestationDetectors;
  /** Metric sink. Absent → metrics are simply not emitted (local). */
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
  /** Findings emailed to at least one seat or ops address. */
  sent: number;
  /** Findings recorded for the portal with no email, on purpose (muted, tier policy). */
  portalOnly: number;
  /** Findings with no delivery and at least one failed send. Not recorded. */
  failed: number;
  /** Findings with no delivery that could not be attempted. Not recorded. */
  skipped: number;
  /** Digest emails Resend accepted this run, vendor and ops together. */
  digestsSent: number;
}

// ─── Ledger metadata ─────────────────────────────────────────────────────────

/**
 * What a ledger row records beyond §7.3's required `{ detector, vendorId }`.
 *
 * The snapshot is what makes the in-portal list a zero-join read, and keeps a
 * year-old row legible after the claim it names has been re-curated or deleted.
 */
export interface NotificationLedgerMetadata {
  /** The registry entry of the digest that carries this finding (AECI-1199). Rows
   *  written before AECI-1204 name the retired per-finding template. */
  notificationId: AttestationNotificationId;
  detector: AttestationDetector;
  /** `null` = AECi ops. Never matches a vendor caller. */
  vendorId: string | null;
  integrationId: string;
  dataObject: NotificationProductRef;
  counterpartProduct: NotificationProductRef | null;
  pairSlugs: readonly [string, string];
  /** AECI-1204: how many seats (or ops addresses) the day's digest reached. `0`
   *  means recorded for the portal only. Absent on rows written before AECI-1204,
   *  which were all emailed. */
  emailedSeats: number;
}

function ledgerEntry(
  notification: AttestationNotificationId,
  finding: DetectorFinding,
  emailedSeats: number,
): AuditLogEntry {
  const metadata: NotificationLedgerMetadata = {
    notificationId: notification,
    detector: finding.detector,
    vendorId: finding.vendorId,
    integrationId: finding.integrationId,
    dataObject: finding.context.dataObject,
    counterpartProduct: finding.context.counterpartProduct,
    pairSlugs: finding.context.pairSlugs,
    emailedSeats,
  };
  return {
    actorId: null,
    actorType: 'system',
    action: NOTIFICATION_SENT_ACTION,
    entityType: NOTIFICATION_ENTITY_TYPE,
    entityId: finding.claimId,
    // AECI-1192: the RECIPIENT; `null` for an ops-only finding.
    vendorId: finding.vendorId,
    metadata,
  };
}

/** The suppression identity of a finding. Recipient is part of the key: nudging
 *  vendor A about a conflict must not suppress the identical nudge to vendor B. */
function suppressionKey(claimId: string, detector: string, vendorId: string | null): string {
  return `${claimId}|${detector}|${vendorId ?? '~ops'}`;
}

/**
 * Ledger rows inside the suppression window, as a key set. One query per sweep,
 * served by `audit_log_action_idx (action, created_at)`. The `metadata` match
 * happens in memory because it is unindexed JSON.
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

// ─── Grouping + the delivery decision (pure, exported for the unit specs) ────

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** The digest's UTC day, `YYYY-MM-DD`. Part of every digest dedupe key. */
export function digestDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** `attestation-digest:{vendorId}:{profileId}:{YYYY-MM-DD}`. */
export function vendorDigestKey(vendorId: string, profileId: string, day: string): string {
  return `attestation-digest:${vendorId}:${profileId}:${day}`;
}

/** `attestation-ops-digest:{YYYY-MM-DD}:{recipient hash prefix}`. Per address,
 *  because `SUPPORT_EMAIL` may list several and one key would make the second
 *  a duplicate of the first. */
export function opsDigestKey(day: string, addressHash: string): string {
  return `attestation-ops-digest:${day}:${addressHash.slice(0, 16)}`;
}

/**
 * Split findings into vendor groups (in first-seen order, which is priority order
 * because the caller sorts first) and the ops list.
 */
export function groupFindings(findings: readonly DetectorFinding[]): {
  byVendor: Map<string, DetectorFinding[]>;
  ops: DetectorFinding[];
} {
  const byVendor = new Map<string, DetectorFinding[]>();
  const ops: DetectorFinding[] = [];
  for (const f of findings) {
    if (!f.vendorId) {
      ops.push(f);
      continue;
    }
    const list = byVendor.get(f.vendorId);
    if (list) list.push(f);
    else byVendor.set(f.vendorId, [f]);
  }
  return { byVendor, ops };
}

/** What happened at one seat (or ops address): an email outcome, or a reason no
 *  email was attempted. */
export type SeatOutcome = EmailOutcome | 'muted' | 'no-address';

/**
 * The delivery decision for one recipient group (a vendor's seats, or the ops
 * addresses). See the table in the module header.
 */
export function decideDelivery(seats: readonly SeatOutcome[]): {
  outcome: Exclude<NotifyOutcome, 'suppressed'>;
  record: boolean;
  emailedSeats: number;
} {
  const emailedSeats = seats.filter(
    (s) => s === 'sent' || s === 'duplicate' || s === 'unknown',
  ).length;
  if (emailedSeats > 0) return { outcome: 'sent', record: true, emailedSeats };
  if (seats.includes('failed')) return { outcome: 'failed', record: false, emailedSeats: 0 };
  // `skipped` (no Resend key or sender) is a config gap that a retry can close, so it
  // blocks the portal-only answer exactly as `failed` does. `no-address` does not.
  // `paused` (AECI-1224) is an operator's mute of the whole digest on this tier, so it
  // answers like a seat's own mute: the portal row is still written.
  if (
    !seats.includes('skipped') &&
    seats.some((s) => s === 'muted' || s === 'suppressed' || s === 'paused')
  ) {
    return { outcome: 'portal-only', record: true, emailedSeats: 0 };
  }
  return { outcome: 'skipped', record: false, emailedSeats: 0 };
}

// ─── Recipients ──────────────────────────────────────────────────────────────

/**
 * The seats we may nudge, per vendor, as profile ids.
 *
 * **Banned seats are excluded**, unlike `seatsOf` in `routes/vendor.ts`, which keeps
 * them on the roster so co-admins can see a colleague is locked out. A banned seat
 * cannot act on a nudge (every `/api/vendor/*` call fails the §4.2 ban check).
 */
async function loadVendorSeats(
  db: Db,
  vendorIds: readonly string[],
): Promise<Map<string, string[]>> {
  const byVendor = new Map<string, string[]>();
  for (const batch of chunk([...new Set(vendorIds)], SEAT_LOOKUP_CHUNK)) {
    const seats = await db.query.profiles.findMany({
      columns: { id: true, vendorId: true },
      where: (p, { and: andOp, eq: eqOp, inArray: inArrayOp, isNull: isNullOp }) =>
        andOp(inArrayOp(p.vendorId, batch), eqOp(p.role, VENDOR_ADMIN_ROLE), isNullOp(p.bannedAt)),
    });
    for (const seat of seats) {
      if (!seat.vendorId) continue;
      const list = byVendor.get(seat.vendorId);
      if (list) list.push(seat.id);
      else byVendor.set(seat.vendorId, [seat.id]);
    }
  }
  // A stable seat order, so the send order (and a spec reading it) is deterministic.
  for (const list of byVendor.values()) list.sort();
  return byVendor;
}

async function loadVendorNames(db: Db, vendorIds: readonly string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const batch of chunk([...new Set(vendorIds)], SEAT_LOOKUP_CHUNK)) {
    const rows = await db
      .select({ id: vendors.id, name: vendors.companyName })
      .from(vendors)
      .where(inArray(vendors.id, batch));
    for (const row of rows) names.set(row.id, row.name);
  }
  return names;
}

function digestFinding(f: DetectorFinding): AttestationDigestFinding {
  return {
    detector: f.detector,
    dataObject: f.context.dataObject.name,
    product: f.context.subjectProduct.name,
    counterpart: f.context.counterpartProduct.name,
    mechanismName: f.context.mechanismName,
    pairSlugs: f.context.pairSlugs,
  };
}

function opsDigestFinding(f: DetectorFinding): AttestationOpsDigestFinding {
  return {
    detector: f.detector === 'claim-denied' ? 'claim-denied' : 'open-conflict',
    dataObject: f.context.dataObject.name,
    productA: f.context.subjectProduct.name,
    productB: f.context.counterpartProduct.name,
    mechanismName: f.context.mechanismName,
    claimId: f.claimId,
    integrationId: f.integrationId,
    pairSlugs: f.context.pairSlugs,
  };
}

// ─── The sweep ───────────────────────────────────────────────────────────────

/**
 * Run one notification pass: detect, suppress, group, send digests, record.
 *
 * Returns counts for the caller to log. Metrics go through the injected sink so
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
    portalOnly: 0,
    failed: 0,
    skipped: 0,
    digestsSent: 0,
  };
  if (found.length === 0) return result;

  // Suppression first, then the cap, so a suppressed backlog cannot starve the
  // findings that are actually due.
  const windowStartIso = new Date(
    now.getTime() - NOTIFICATION_SUPPRESSION_DAYS * DAY_MS,
  ).toISOString();
  const suppressed = await loadSuppressed(db, windowStartIso);
  const due = found.filter((f) => {
    if (!suppressed.has(suppressionKey(f.claimId, f.detector, f.vendorId))) return true;
    result.suppressed++;
    return false;
  });

  const ordered = [...due].sort(
    (a, b) =>
      DETECTOR_PRIORITY.indexOf(a.detector) - DETECTOR_PRIORITY.indexOf(b.detector) ||
      a.claimId.localeCompare(b.claimId) ||
      (a.vendorId ?? '').localeCompare(b.vendorId ?? ''),
  );
  const batch = ordered.slice(0, NOTIFY_BATCH_CAP);
  result.capped = ordered.length - batch.length;
  if (result.capped > 0) {
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message: `aeci.attestation.notify.capped dropped=${result.capped} cap=${NOTIFY_BATCH_CAP}`,
      source: 'attestation-notify-cron',
      dropped: result.capped,
    });
  }

  const { byVendor, ops } = groupFindings(batch);
  const day = digestDay(now);

  // ── Every read, and the lazy token create, BEFORE the first send. A throw here
  //    aborts the run with nothing sent and nothing recorded.
  const vendorIds = [...byVendor.keys()];
  const seatsByVendor = await loadVendorSeats(db, vendorIds);
  const vendorNames = await loadVendorNames(db, vendorIds);
  const allSeats = [...seatsByVendor.values()].flat();
  const existing = await loadNudgePreferences(db, allSeats);
  const unmuted = allSeats.filter((id) => !isNudgeMuted(existing.get(id)));
  const emails = unmuted.length > 0 ? await fetchSeatEmails(c.env, unmuted) : new Map();
  const { prefs, created } = await ensureNudgePreferences(
    db,
    unmuted.filter((id) => emails.has(id)),
    'attestation-digest',
  );
  forwardEntries(c, created, 'attestation-notify-cron');
  for (const [id, pref] of existing) if (!prefs.has(id)) prefs.set(id, pref);

  const outcomes: Array<{ detector: AttestationDetector; outcome: NotifyOutcome }> = [];
  const pendingLedger: BatchStmt[] = [];
  const pendingForward: AuditLogEntry[] = [];

  const record = async (
    findings: readonly DetectorFinding[],
    notification: AttestationNotificationId,
    seatOutcomes: readonly SeatOutcome[],
  ): Promise<void> => {
    const decision = decideDelivery(seatOutcomes);
    result.digestsSent += seatOutcomes.filter((s) => s === 'sent').length;
    for (const finding of findings) {
      outcomes.push({ detector: finding.detector, outcome: decision.outcome });
      if (decision.outcome === 'portal-only') result.portalOnly++;
      else result[decision.outcome]++;
      if (!decision.record) continue;
      const entry = ledgerEntry(notification, finding, decision.emailedSeats);
      pendingLedger.push(auditInsert(db, entry));
      pendingForward.push(entry);
      if (pendingLedger.length >= LEDGER_CHUNK) {
        await flushLedger(c, db, pendingLedger.splice(0), pendingForward.splice(0));
      }
    }
  };

  // ── Vendor digests: one per seat. Sends are sequential, one connection at a time.
  for (const [vendorId, findings] of byVendor) {
    const digest = findings.map(digestFinding);
    const seatOutcomes: SeatOutcome[] = [];
    for (const profileId of seatsByVendor.get(vendorId) ?? []) {
      const pref = prefs.get(profileId);
      if (isNudgeMuted(pref)) {
        seatOutcomes.push('muted');
        continue;
      }
      const to = emails.get(profileId);
      if (!to) {
        seatOutcomes.push('no-address');
        continue;
      }
      seatOutcomes.push(
        await sendAttestationDigestEmail(c, {
          to,
          vendorId,
          vendorName: vendorNames.get(vendorId) ?? null,
          findings: digest,
          muteToken: pref?.muteToken ?? null,
          dedupeKey: vendorDigestKey(vendorId, profileId, day),
        }),
      );
    }
    await record(findings, 'attestation-digest', seatOutcomes);
  }

  // ── The ops digest: one per SUPPORT_EMAIL address.
  if (ops.length > 0) {
    const opsFindings = ops.map(opsDigestFinding);
    const seatOutcomes: SeatOutcome[] = [];
    for (const to of parseRecipients(c.env.SUPPORT_EMAIL)) {
      seatOutcomes.push(
        await sendAttestationOpsDigestEmail(c, {
          to,
          findings: opsFindings,
          dedupeKey: opsDigestKey(day, await recipientHash(to)),
        }),
      );
    }
    await record(ops, 'attestation-ops-digest', seatOutcomes);
  }

  await flushLedger(c, db, pendingLedger, pendingForward);

  if (deps.metrics) emitNotifyOutcomeMetrics(deps.metrics, outcomes);
  return result;
}

/** Forward audit entries post-commit, in ONE batched request (AECI-666): one
 *  request per entry opened 2N connections and lost the forwards silently. */
function forwardEntries(c: NotifyContext, entries: readonly AuditLogEntry[], source: string): void {
  if (entries.length === 0) return;
  logBatchToPosthog(
    c.executionCtx,
    c.env,
    c.req.raw,
    entries.map((entry) => ({
      level: 'info' as const,
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source,
    })),
  );
}

/**
 * Commit one chunk of ledger rows, then forward them post-commit (§26.5).
 *
 * A batch failure is logged and swallowed rather than thrown: the digests are
 * already delivered, and losing the sweep to a D1 hiccup would abandon the rest.
 * The findings in a lost chunk are due again tomorrow. Their seats' digest keys
 * for today are held, so a same-day queue retry sends no second email.
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
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'error',
      message: 'aeci.attestation.notify.ledger_failed',
      source: 'attestation-notify-cron',
      rows: statements.length,
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  forwardEntries(c, entries, 'attestation-notify-cron');
}
