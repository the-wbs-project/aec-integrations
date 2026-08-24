/**
 * The §7 term-expiry sweep (AECI-613 / `docs/STAGE_2_PAID_TIERS_SPEC.md` §7).
 *
 * An entitlement carries a term. As `period_end` approaches, this job **warns**
 * the vendor's seats and the operator, and stamps `expiry_notice_sent_at` so a
 * term earns one notice rather than one per night. Run by the daily 11:00 UTC
 * cron (`ENTITLEMENT_EXPIRY_CRON`), queue-less and inline.
 *
 * ── THE NON-NEGOTIABLE (§7.3) ───────────────────────────────────────────────────
 *
 * **This job never writes `status`, and never writes `vendors.verified`.** It warns;
 * it never lapses. Auto-lapse would strip a badge from a paying customer over a
 * data-entry mistake, and un-verify stays a deliberate admin act (§5). The only
 * column this module mutates on `vendor_entitlements` is `expiry_notice_sent_at`
 * (plus the row's own `updated_at`); it emits no statement against `vendors` at
 * all. `expiryNoticeStatements` is exported as a pure builder precisely so
 * `entitlement-expiry.spec.ts` can assert that against the generated SQL rather
 * than against prose. `status` DOES appear in the update's `WHERE` — as a guard,
 * so a concurrent admin clear cannot be stamped — and a guard is a read, not a
 * write. That distinction is the one the invariant test has to make.
 *
 * ── WHAT IS STRUCTURALLY INVISIBLE ──────────────────────────────────────────────
 *
 * The scan rides `vendor_entitlements_expiry_idx`, which is PARTIAL
 * (`WHERE "period_end" IS NOT NULL AND "status" = 'active'`). So a **perpetual**
 * entitlement — `period_end IS NULL`, which is exactly what the §2.4 backfill
 * writes for every pre-entitlement Airtable/claim-era vendor — can never be
 * selected. That is by construction, not by a predicate someone must remember.
 *
 * ── THE IDEMPOTENCY FENCE ───────────────────────────────────────────────────────
 *
 * A row is due when `expiry_notice_sent_at` is null, or predates
 * `period_end − EXPIRY_WARNING_DAYS` — i.e. the stamp belongs to an EARLIER term.
 * A renewal pushes `period_end` out, which moves that boundary forward and makes
 * the old stamp stale again, so the new term earns its own notice; the §2.3
 * re-activation path additionally clears the stamp outright. The comparison is
 * done in TS rather than SQL: it is a column-to-column comparison and therefore
 * unindexable either way, and SQLite's `datetime()` renders `YYYY-MM-DD HH:MM:SS`,
 * which does NOT order lexically against the `…THH:MM:SS.sssZ` form this schema
 * stores. Doing the date math in TS avoids that trap entirely.
 *
 * ── FAIL-OPEN, AND WHY TWO TEMPLATES ────────────────────────────────────────────
 *
 * The vendor half needs seat addresses, which need `fetchAuthUserEmails` and
 * therefore `SUPABASE_SERVICE_ROLE_KEY` — present on staging/demo/prod, absent
 * locally and on PR previews. So it degrades to `skipped` while the operator copy
 * always lands. The fence is stamped when **either** channel was `sent`: writing
 * it on attempt would silently consume the notice during a Resend outage, and
 * requiring BOTH would re-nag the operator every night on any tier without the
 * service-role key. Nothing here throws — `sendTransactionalEmail` never does, and
 * a batch failure is logged and skipped so one bad row cannot end the sweep.
 */

import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { forwardAuditLog } from '@aeci/shared';
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm';

import { auditInsert, type BatchStmt, type BatchTuple } from './audit';
import { VENDOR_ADMIN_ROLE } from './claimed-vendors';
import {
  emitExpiryDueMetric,
  emitExpiryNoticeMetrics,
  type EntitlementExpiryMetricSink,
  type ExpiryNoticeOutcome,
} from './entitlement-expiry-metrics';
import { parseRecipients, type EmailContext, type EmailOutcome } from './email';
import { fetchAuthUserEmails } from './supabase-admin';
import { ENTITLEMENT_ENTITY_TYPE } from './vendor-entitlement';
import type { Db } from '../db/client';
import { vendorEntitlements, vendors } from '../db/schema';
import { logToPosthog } from '../posthog';
import type { Env } from '../env';

const DAY_MS = 86_400_000;

/** The one status the sweep looks at — and the only one it GUARDS on. */
const ACTIVE = 'active';

/**
 * How far ahead a term is warned about. Also the width of the idempotency fence:
 * a stamp inside `[period_end − EXPIRY_WARNING_DAYS, period_end]` belongs to the
 * current term and suppresses; anything earlier belongs to a previous one.
 *
 * Re-exported from `@aeci/shared/entitlements` rather than declared here: the
 * vendor dashboard's plan panel leans in on the same horizon, and a cron that
 * warned earlier than the dashboard admits anything is wrong would email a paying
 * customer about a problem their own portal denies. One promise, one constant.
 */
export { EXPIRY_WARNING_DAYS } from '@aeci/shared/entitlements';
import { EXPIRY_WARNING_DAYS } from '@aeci/shared/entitlements';

/** `audit_log.action` for a delivered warning (§7.3). Audited — rather than
 *  following the `stats_cache` no-audit precedent — because "we warned them on
 *  date X" is precisely the fact an offline-invoice dispute needs, and writing it
 *  keeps §26.1 unqualified. `entity_type`/`entity_id` are the vendor-keyed pair
 *  `lib/vendor-entitlement.ts` established, so this row joins the same
 *  `audit_log_entity_idx` trail as every grant/renew/clear. */
export const EXPIRY_WARNED_ACTION = 'vendor_entitlement.expiry_warned';

/** `metadata.source` on those rows. */
const EXPIRY_AUDIT_SOURCE = 'entitlement-expiry-cron';

/**
 * Most terms warned per run. A backstop against a first-adoption spike or a
 * mis-entered bulk term, not a design limit. The read that feeds it orders
 * never-warned terms FIRST (`loadExpiring`), so a term that got its notice is
 * stamped and drops to the back of the next run's window rather than
 * re-occupying it — the backlog drains across days instead of repeating, and a
 * genuinely-due term is never starved out of the window by the ever-growing set
 * of already-warned lapsed-but-active rows. The sweep logs the dropped count
 * instead of truncating silently.
 */
export const EXPIRY_BATCH_CAP = 200;

// ─── Context + deps ──────────────────────────────────────────────────────────

/** Same structural context the email + Datadog seams take, so the cron can build
 *  one from a synthetic `Request` (`scheduled.ts`'s `cronRequest`). */
export type ExpiryContext = EmailContext;

/** The §7.2 vendor renewal prompt (`entitlement-expiring`). Declared here as a
 *  seam — the §1.3 route-seam pattern — and injected by `scheduled.ts`, so this
 *  module never reaches the Resend transport and the specs never stub a fetch. */
export type SendEntitlementExpiringEmail = (
  c: ExpiryContext,
  opts: {
    to: string;
    vendorName: string;
    periodEndDay: string;
    daysRemaining: number;
  },
) => Promise<EmailOutcome>;

/** The §7.2 operator copy (`entitlement-expiring-admin`). Same seam. */
export type SendEntitlementExpiringAdminEmail = (
  c: ExpiryContext,
  opts: {
    to: string;
    vendorName: string;
    vendorSlug: string;
    tier: string;
    periodEndDay: string;
    daysRemaining: number;
    payer: string | null;
    invoiceRef: string | null;
    vendorNotice: EmailOutcome;
  },
) => Promise<EmailOutcome>;

/** Absent sender → nothing is sent and the run reports `skipped`, which leaves the
 *  fence unstamped and the notice due again tomorrow. Deliberately not a throw:
 *  an uninjected seam must degrade the way a missing API key does. */
const noopSendExpiryEmail: SendEntitlementExpiringEmail = async () => 'skipped';
const noopSendExpiryAdminEmail: SendEntitlementExpiringAdminEmail = async () => 'skipped';

export type FetchSeatEmails = (
  env: Env,
  userIds: readonly string[],
) => Promise<Map<string, string>>;

export interface ExpiryDeps {
  /** Deterministic clock for the horizon + fence math. */
  now?: Date;
  /** Days of lookahead. Overridable so specs don't have to build 30-day fixtures. */
  warningDays?: number;
  /** Read/warn cap. Overridable so specs can exercise the cap + never-warned-first
   *  ordering without a 200-row fixture; defaults to {@link EXPIRY_BATCH_CAP}. */
  batchCap?: number;
  /** The privileged `auth.users` email seam. Injected so specs never touch it. */
  fetchSeatEmails?: FetchSeatEmails;
  sendVendorEmail?: SendEntitlementExpiringEmail;
  sendAdminEmail?: SendEntitlementExpiringAdminEmail;
  /** Metric sink. Absent → metrics are simply not emitted (local/preview). */
  metrics?: EntitlementExpiryMetricSink;
}

export interface ExpiryResult {
  /** Rows inside the horizon before the fence — the `aeci.entitlement.expiry_due`
   *  gauge. */
  due: number;
  /** Rows the fence suppressed (already warned for this term). */
  suppressed: number;
  /** Rows dropped by {@link EXPIRY_BATCH_CAP} this run. */
  capped: number;
  /** Rows whose stored timestamps could not be parsed, so nothing was sent. */
  malformed: number;
  /** Terms that got at least one delivered notice AND a stamped fence. */
  warned: number;
  vendor: { sent: number; failed: number; skipped: number };
  admin: { sent: number; failed: number; skipped: number };
  /** Fence/audit batches that failed to commit (emails already went out). */
  batchFailures: number;
}

/** One `vendor_entitlements` row inside the horizon, joined to its vendor. */
interface ExpiringRow {
  entitlementId: string;
  vendorId: string;
  vendorSlug: string;
  vendorName: string;
  tier: string;
  periodEnd: string;
  expiryNoticeSentAt: string | null;
  payer: string | null;
  invoiceRef: string | null;
}

// ─── The scan ────────────────────────────────────────────────────────────────

/**
 * Terms at or inside the horizon, **never-warned first, then oldest**.
 *
 * Explicit `select` + `innerJoin`, NOT the relational query builder: §2.5 forbids
 * a `relations()` entry for `vendor_entitlements` (a relation is exactly what
 * would make joining it into the public `?verified=` filter type-check), and this
 * is the same explicit-join shape the §4 gate and the `entitlement_mirror_drift`
 * check use.
 *
 * `period_end <= horizon` is a lexical string comparison, which is sound because
 * ISO-8601 is defined to sort lexically and every writer here stamps
 * `toISOString()`. There is deliberately NO lower bound: a term that has already
 * run out while `status` is still `active` — which is the steady state, since
 * nothing lapses automatically — is exactly the row an operator most needs to see,
 * and the fence still limits it to one notice.
 *
 * ── WHY THE LEAD SORT KEY IS `expiry_notice_sent_at IS NULL` ─────────────────────
 * Those never-lapsing past-dated rows accumulate WITHOUT BOUND — each one is
 * already stamped, so the TS fence suppresses it, but it stays selectable every
 * night forever. Ordered by `period_end` alone they sort to the FRONT (oldest
 * first), so once ≥`EXPIRY_BATCH_CAP` of them exist they would fill the read
 * window and starve a genuinely-due newer term out of the scan entirely. Sorting
 * unstamped rows first defeats that: a due row is ALWAYS unstamped — a renewal
 * NULLs the stamp (`renewEntitlementStatements`) and re-activation clears it too —
 * so due rows are read before the suppressed backlog, and a warned row (now
 * stamped) drops to the back of tomorrow's window rather than re-occupying it.
 * The `period_end` key still orders within each group, so the operator's oldest
 * lapsed terms are still surfaced whenever the window has room after the due ones.
 */
async function loadExpiring(db: Db, horizonIso: string, limit: number): Promise<ExpiringRow[]> {
  return db
    .select({
      entitlementId: vendorEntitlements.id,
      vendorId: vendorEntitlements.vendorId,
      vendorSlug: vendors.slug,
      vendorName: vendors.companyName,
      tier: vendorEntitlements.tier,
      periodEnd: vendorEntitlements.periodEnd,
      expiryNoticeSentAt: vendorEntitlements.expiryNoticeSentAt,
      payer: vendorEntitlements.payer,
      invoiceRef: vendorEntitlements.invoiceRef,
    })
    .from(vendorEntitlements)
    .innerJoin(vendors, eq(vendors.id, vendorEntitlements.vendorId))
    .where(
      and(
        eq(vendorEntitlements.status, ACTIVE),
        isNotNull(vendorEntitlements.periodEnd),
        lte(vendorEntitlements.periodEnd, horizonIso),
      ),
    )
    .orderBy(
      // A plain NULL check — no SQLite date parsing, so none of the `datetime()`
      // lexical-ordering traps the fence is written in TS to avoid.
      sql`case when ${vendorEntitlements.expiryNoticeSentAt} is null then 0 else 1 end`,
      asc(vendorEntitlements.periodEnd),
      asc(vendorEntitlements.vendorId),
    )
    .limit(limit) as Promise<ExpiringRow[]>;
}

/** Whole days from `now` to `period_end`; negative once the term is past. Rounded
 *  UP so "18 hours left" reads as "tomorrow" rather than "today". */
export function daysUntil(nowMs: number, periodEndMs: number): number {
  return Math.ceil((periodEndMs - nowMs) / DAY_MS);
}

/**
 * Whether this term still owes a notice. `null` stamp → yes. A stamp at or after
 * `period_end − window` belongs to the CURRENT term → no. Anything earlier belongs
 * to a previous term (the row was renewed) → yes.
 *
 * A present-but-unparseable stamp suppresses rather than notifies: it can only
 * come from hand-written SQL, and re-nagging nightly forever is a worse failure
 * than one missed warning.
 */
export function noticeIsDue(
  expiryNoticeSentAt: string | null,
  periodEndMs: number,
  warningDays: number,
): boolean {
  if (expiryNoticeSentAt === null) return true;
  const sentMs = Date.parse(expiryNoticeSentAt);
  if (!Number.isFinite(sentMs)) return false;
  return sentMs < periodEndMs - warningDays * DAY_MS;
}

// ─── The write ───────────────────────────────────────────────────────────────

export interface ExpiryNoticeParams {
  entitlementId: string;
  vendorId: string;
  tier: string;
  periodEnd: string;
  daysRemaining: number;
  /** ISO timestamp for the stamp — the sweep's `now`. */
  now: string;
  vendorNotice: EmailOutcome;
  adminNotice: EmailOutcome;
  /** How many seat addresses the vendor half reached. */
  vendorRecipients: number;
}

/**
 * The statements one delivered warning produces: the fence stamp and its
 * `audit_log` row, in ONE `db.batch` (§26.1 — D1 has no interactive transactions).
 *
 * Exported as a pure builder, executing nothing, so the §7.3 invariant test can
 * read the generated SQL directly. What that test asserts, and what this function
 * must never stop satisfying:
 *
 *   - exactly ONE statement targets `vendor_entitlements`, and its SET clause
 *     names only `expiry_notice_sent_at` and `updated_at`;
 *   - NO statement names `vendors` or `verified` anywhere;
 *   - `status` appears only inside the `WHERE`, as a concurrency guard.
 */
export function expiryNoticeStatements(
  db: Db,
  p: ExpiryNoticeParams,
): { stmts: BatchStmt[]; auditEntry: AuditLogEntry } {
  const auditEntry: AuditLogEntry = {
    actorId: null,
    // The `audit_log_actor_type_check` value for a cron. `actor_id` stays null: it
    // is an FK to `profiles` and no profile did this.
    actorType: 'system',
    action: EXPIRY_WARNED_ACTION,
    entityType: ENTITLEMENT_ENTITY_TYPE,
    entityId: p.vendorId,
    metadata: {
      source: EXPIRY_AUDIT_SOURCE,
      vendor_id: p.vendorId,
      tier: p.tier,
      period_end: p.periodEnd,
      days_remaining: p.daysRemaining,
      warning_days: EXPIRY_WARNING_DAYS,
      vendor_notice: p.vendorNotice,
      vendor_recipients: p.vendorRecipients,
      admin_notice: p.adminNotice,
      // Stated in the trail rather than left to be inferred: this row records a
      // WARNING. No status moved, and no badge moved (§7.3).
      status_unchanged: true,
    },
  };

  const stmts: BatchStmt[] = [
    db
      .update(vendorEntitlements)
      .set({ expiryNoticeSentAt: p.now, updatedAt: p.now })
      // Guarded on the CURRENT state — a read, not a write. An admin who cleared
      // the entitlement between this run's scan and its write must not have the
      // dead row stamped.
      .where(
        and(eq(vendorEntitlements.id, p.entitlementId), eq(vendorEntitlements.status, ACTIVE)),
      ),
    auditInsert(db, auditEntry),
  ];

  return { stmts, auditEntry };
}

// ─── Recipients ──────────────────────────────────────────────────────────────

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Vendor ids per seat lookup. D1 caps bound parameters per query, so an
 *  `inArray` over an unbounded id list is a latent failure once adoption grows. */
const SEAT_LOOKUP_CHUNK = 50;

/**
 * Email addresses per vendor for the seats to warn — unbanned `vendor_admin`
 * profiles only, matching `lib/attestation-notify.ts`. A banned seat cannot act on
 * a renewal prompt (every `/api/vendor/*` call fails the ban check), so mailing it
 * is noise.
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

/**
 * Collapse the per-address outcomes for one channel into the one recorded.
 *
 * `sent` if ANY address was delivered — the notice reached the vendor, so the
 * fence is earned even if a second seat's address bounced. Otherwise `failed`
 * beats `skipped`, because a failure is the more actionable signal.
 */
function collapse(outcomes: readonly EmailOutcome[]): EmailOutcome {
  if (outcomes.includes('sent')) return 'sent';
  if (outcomes.includes('failed')) return 'failed';
  return 'skipped';
}

// ─── The sweep ───────────────────────────────────────────────────────────────

/**
 * Run one expiry pass: scan, fence, warn, stamp.
 *
 * Returns counts for the caller to log; metrics go through the injected sink so
 * this module stays free of `ctx`/`env` plumbing. Never throws for an email or a
 * batch failure — only a genuinely unexpected D1 read failure propagates, which
 * is safe because the fence makes a re-run idempotent for everything already
 * delivered.
 */
export async function runEntitlementExpirySweep(
  c: ExpiryContext,
  db: Db,
  deps: ExpiryDeps = {},
): Promise<ExpiryResult> {
  const now = deps.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const warningDays = deps.warningDays ?? EXPIRY_WARNING_DAYS;
  const cap = deps.batchCap ?? EXPIRY_BATCH_CAP;
  const fetchSeatEmails = deps.fetchSeatEmails ?? fetchAuthUserEmails;
  const sendVendorEmail = deps.sendVendorEmail ?? noopSendExpiryEmail;
  const sendAdminEmail = deps.sendAdminEmail ?? noopSendExpiryAdminEmail;

  const result: ExpiryResult = {
    due: 0,
    suppressed: 0,
    capped: 0,
    malformed: 0,
    warned: 0,
    vendor: { sent: 0, failed: 0, skipped: 0 },
    admin: { sent: 0, failed: 0, skipped: 0 },
    batchFailures: 0,
  };

  const horizonIso = new Date(nowMs + warningDays * DAY_MS).toISOString();
  // One over the cap, so "there was more" is detectable without a second query.
  const rows = await loadExpiring(db, horizonIso, cap + 1);

  const pending: Array<{ row: ExpiringRow; periodEndMs: number; daysRemaining: number }> = [];
  for (const row of rows) {
    const periodEndMs = Date.parse(row.periodEnd);
    if (!Number.isFinite(periodEndMs)) {
      result.malformed++;
      continue;
    }
    result.due++;
    if (!noticeIsDue(row.expiryNoticeSentAt, periodEndMs, warningDays)) {
      result.suppressed++;
      continue;
    }
    pending.push({ row, periodEndMs, daysRemaining: daysUntil(nowMs, periodEndMs) });
  }

  // The gauge is emitted on EVERY run, zero included — it is this job's only
  // liveness signal while every backfilled entitlement is perpetual (§2.4).
  if (deps.metrics) emitExpiryDueMetric(deps.metrics, result.due);
  if (pending.length === 0) return result;

  const batch = pending.slice(0, cap);
  result.capped = pending.length - batch.length;
  if (result.capped > 0) {
    // Never truncate silently — an operator must be able to tell "nothing due"
    // from "we stopped early".
    logToPosthog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message: `aeci.entitlement.expiry.capped dropped=${result.capped} cap=${cap}`,
      source: EXPIRY_AUDIT_SOURCE,
      dropped: result.capped,
    });
  }

  const adminRecipients = parseRecipients(c.env.ADMIN_ALERT_EMAIL);
  const seatEmails = await loadVendorSeatEmails(
    db,
    c.env,
    batch.map((b) => b.row.vendorId),
    fetchSeatEmails,
  );

  const outcomes: ExpiryNoticeOutcome[] = [];

  for (const { row, daysRemaining } of batch) {
    const periodEndDay = row.periodEnd.slice(0, 10);
    const addresses = seatEmails.get(row.vendorId) ?? [];

    const vendorSends: EmailOutcome[] = [];
    for (const to of addresses) {
      vendorSends.push(
        await sendVendorEmail(c, {
          to,
          vendorName: row.vendorName,
          periodEndDay,
          daysRemaining,
        }),
      );
    }
    const vendorNotice = collapse(vendorSends);
    result.vendor[vendorNotice]++;
    outcomes.push({ channel: 'vendor', outcome: vendorNotice });

    const adminSends: EmailOutcome[] = [];
    for (const to of adminRecipients) {
      adminSends.push(
        await sendAdminEmail(c, {
          to,
          vendorName: row.vendorName,
          vendorSlug: row.vendorSlug,
          tier: row.tier,
          periodEndDay,
          daysRemaining,
          payer: row.payer,
          invoiceRef: row.invoiceRef,
          vendorNotice,
        }),
      );
    }
    const adminNotice = collapse(adminSends);
    result.admin[adminNotice]++;
    outcomes.push({ channel: 'admin', outcome: adminNotice });

    // Stamp when EITHER channel landed (see the header): stamping on attempt would
    // consume the notice during a Resend outage, and requiring both would re-nag
    // nightly on any tier without `SUPABASE_SERVICE_ROLE_KEY`.
    if (vendorNotice !== 'sent' && adminNotice !== 'sent') continue;

    const { stmts, auditEntry } = expiryNoticeStatements(db, {
      entitlementId: row.entitlementId,
      vendorId: row.vendorId,
      tier: row.tier,
      periodEnd: row.periodEnd,
      daysRemaining,
      now: nowIso,
      vendorNotice,
      adminNotice,
      vendorRecipients: addresses.length,
    });

    try {
      await db.batch(stmts as BatchTuple);
    } catch (error) {
      // The emails for THIS row are already out. Log and move on rather than
      // aborting: the cost is one duplicate warning in 24h, which is strictly
      // better than losing every remaining row's notice to one D1 hiccup.
      result.batchFailures++;
      logToPosthog(c.executionCtx, c.env, c.req.raw, {
        level: 'error',
        message: 'aeci.entitlement.expiry.stamp_failed',
        source: EXPIRY_AUDIT_SOURCE,
        vendor_id: row.vendorId,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    result.warned++;
    forwardEntry(c, auditEntry);
  }

  if (deps.metrics) emitExpiryNoticeMetrics(deps.metrics, outcomes);
  return result;
}

/** Post-commit §26.5 forward. Best-effort and off the critical path. */
function forwardEntry(c: ExpiryContext, entry: AuditLogEntry): void {
  const forwarder = c.env.DD_API_KEY
    ? (e: AuditLogEntry) => {
        logToPosthog(c.executionCtx, c.env, c.req.raw, {
          level: 'info',
          message: `audit ${e.action} ${e.entityId ?? ''}`.trim(),
          action: e.action,
          entity_type: e.entityType ?? undefined,
          entity_id: e.entityId ?? undefined,
          source: EXPIRY_AUDIT_SOURCE,
        });
      }
    : undefined;
  c.executionCtx.waitUntil(forwardAuditLog(entry, forwarder));
}
