/**
 * The claim owner fallback (AECI-1368 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §11a.10).
 *
 * A claim on a company that already has an unbanned owner seat is routed to those
 * owners at submit (`vendor_requests.routed_to_owners_at`). They accept or decline it
 * from the Seats section. If they have not decided within {@link OWNER_REVIEW_DAYS}
 * days, AECi steps in. This is the daily `claim_owner_fallback` cron that does that.
 *
 * One run:
 *
 * 1. Reads the routed claims that are still undecided (`open` or `in_review`) and
 *    were routed at least 7 days ago. D1 only, never Linear.
 * 2. In ONE `db.batch`, for each claim: clears `routed_to_owners_at`, stamps
 *    `owner_fallback_at`, and writes a `vendor_claim.owner_fallback` audit row
 *    (§26.1). The UPDATE is guarded on the claim still being routed and undecided,
 *    so an owner who decides between the read and the write wins, and the claim is
 *    left alone.
 * 3. After the commit, sends ONE `claim-owner-fallback-alert` digest to
 *    `SUPPORT_EMAIL`, keyed on the sorted claim ids.
 *
 * **A second run is a no-op.** The claims step 2 moved no longer match step 1, so the
 * next run reads nothing and sends nothing. That fence is the column itself: no
 * extra ledger, no `job_runs` read.
 *
 * **The digest is best-effort.** It goes after the commit, so a failed send does not
 * put the claims back with the owners. They are in the `/admin/claims` queue either
 * way, and from now on `claim-stale-check` counts them again like any other claim.
 *
 * The claim's status does not change, so there is no workflow transition. The audit
 * row is the record that AECi took it over.
 */

import { CLAIM_OWNER_REVIEW_DAYS, claimOwnerReviewDeadline } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import { and, asc, eq, inArray, isNotNull, lte } from 'drizzle-orm';

import type { Db } from '../db/client';
import { vendorRequests, vendors } from '../db/schema';
import { auditInsert, type BatchStmt, type BatchTuple } from './audit';
import {
  sendClaimOwnerFallbackAlert,
  type ClaimOwnerFallbackSummary,
  type EmailContext,
  type EmailOutcome,
} from './email';
import { forwardAuditBatch } from './moderation-forward';
import { adminRequestUrl } from './request-links';

const DAY_MS = 86_400_000;

/** How long the owners have to decide before AECi takes the claim. The shared
 *  constant, so the cron, the emails and both web surfaces agree. */
export const OWNER_REVIEW_DAYS = CLAIM_OWNER_REVIEW_DAYS;

/** Most claims one run moves. A backstop: the next daily run continues. */
export const OWNER_FALLBACK_BATCH_CAP = 100;

/** `metadata.source` on the audit rows and the PostHog forward. */
export const OWNER_FALLBACK_AUDIT_SOURCE = 'claim-owner-fallback-cron';

/** The audit action for a claim handed back to AECi. */
export const OWNER_FALLBACK_ACTION = 'vendor_claim.owner_fallback';

/** The statuses that mean nobody has decided yet. */
const UNDECIDED = ['open', 'in_review'] as const;

/** The deadline the owners have (`claimOwnerReviewDeadline` from `@aeci/shared`). */
export const ownerReviewDeadline = claimOwnerReviewDeadline;

/** The digest's send-ledger key: one per set of claims, independent of read order.
 *  Binary order on purpose: these are ids, not names (`API_CONTRACTS.md` §3.2). */
export function ownerFallbackDigestKey(requestIds: readonly string[]): string {
  const sorted = [...requestIds].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return `claim-owner-fallback-alert:${sorted.join(',')}`;
}

export interface ClaimOwnerFallbackDeps {
  /** The digest seam, injected so specs assert it fires. */
  sendAlert?: typeof sendClaimOwnerFallbackAlert;
  now?: Date;
}

export interface ClaimOwnerFallbackResult {
  /** Claims moved to AECi this run. */
  moved: number;
  /** Claims past the window that the cap left for the next run. */
  capped: number;
  /** The digest outcome, or `null` when nothing moved and nothing was sent. */
  alert: EmailOutcome | null;
}

export interface OwnerFallbackParams {
  requestId: string;
  vendorId: string;
  routedToOwnersAt: string;
  now: string;
}

/**
 * The two statements for one claim: the guarded column move and its audit row.
 * Pure, so the spec can read the SQL.
 */
export function ownerFallbackStatements(
  db: Db,
  p: OwnerFallbackParams,
): { stmts: BatchStmt[]; auditEntry: AuditLogEntry } {
  const auditEntry: AuditLogEntry = {
    actorId: null,
    // A cron. `actor_id` is an FK to `profiles`, and no profile did this.
    actorType: 'system',
    action: OWNER_FALLBACK_ACTION,
    entityType: 'vendor_request',
    entityId: p.requestId,
    vendorId: p.vendorId,
    beforeState: { routed_to_owners_at: p.routedToOwnersAt, owner_fallback_at: null },
    afterState: { routed_to_owners_at: null, owner_fallback_at: p.now },
    metadata: {
      source: OWNER_FALLBACK_AUDIT_SOURCE,
      kind: 'claim',
      vendor_id: p.vendorId,
      owner_review_days: OWNER_REVIEW_DAYS,
      // Stated, not inferred: the claim is still undecided. Only who decides moved.
      status_unchanged: true,
    },
  };
  return {
    stmts: [
      db
        .update(vendorRequests)
        .set({ routedToOwnersAt: null, ownerFallbackAt: p.now })
        .where(
          and(
            eq(vendorRequests.id, p.requestId),
            isNotNull(vendorRequests.routedToOwnersAt),
            inArray(vendorRequests.status, [...UNDECIDED]),
          ),
        ),
      auditInsert(db, auditEntry),
    ],
    auditEntry,
  };
}

/** Run one fallback pass. Throws only on a D1 error, which the cron shell records
 *  as a failed run. The email layer never throws. */
export async function runClaimOwnerFallback(
  c: EmailContext,
  db: Db,
  deps: ClaimOwnerFallbackDeps = {},
): Promise<ClaimOwnerFallbackResult> {
  const sendAlert = deps.sendAlert ?? sendClaimOwnerFallbackAlert;
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();
  // ISO-8601 TEXT compares lexically, so the cutoff is a string.
  const cutoffIso = new Date(now.getTime() - OWNER_REVIEW_DAYS * DAY_MS).toISOString();

  const rows = await db
    .select({
      id: vendorRequests.id,
      targetId: vendorRequests.targetId,
      submitterEmail: vendorRequests.submitterEmail,
      submitterName: vendorRequests.submitterName,
      routedToOwnersAt: vendorRequests.routedToOwnersAt,
      createdAt: vendorRequests.createdAt,
      vendorName: vendors.companyName,
    })
    .from(vendorRequests)
    .leftJoin(vendors, eq(vendors.id, vendorRequests.targetId))
    .where(
      and(
        eq(vendorRequests.kind, 'claim'),
        // Routing only ever sets the column on a vendor-target claim.
        eq(vendorRequests.targetType, 'vendor'),
        inArray(vendorRequests.status, [...UNDECIDED]),
        isNotNull(vendorRequests.routedToOwnersAt),
        lte(vendorRequests.routedToOwnersAt, cutoffIso),
      ),
    )
    .orderBy(asc(vendorRequests.routedToOwnersAt), asc(vendorRequests.id))
    .limit(OWNER_FALLBACK_BATCH_CAP + 1);

  const batch = rows.slice(0, OWNER_FALLBACK_BATCH_CAP);
  const capped = rows.length - batch.length;
  if (batch.length === 0) return { moved: 0, capped: 0, alert: null };

  const stmts: BatchStmt[] = [];
  const audits: AuditLogEntry[] = [];
  for (const row of batch) {
    const built = ownerFallbackStatements(db, {
      requestId: row.id,
      vendorId: row.targetId,
      routedToOwnersAt: row.routedToOwnersAt!,
      now: nowIso,
    });
    stmts.push(...built.stmts);
    audits.push(built.auditEntry);
  }
  await db.batch(stmts as BatchTuple);
  forwardAuditBatch(c, audits, [], OWNER_FALLBACK_AUDIT_SOURCE);

  const summaries: ClaimOwnerFallbackSummary[] = batch.map((row) => ({
    requestId: row.id,
    vendorName: row.vendorName ?? null,
    submitterEmail: row.submitterEmail,
    submitterName: row.submitterName ?? null,
    createdAt: row.createdAt,
    routedToOwnersAt: row.routedToOwnersAt!,
    adminUrl: adminRequestUrl(c.env, 'claim', row.id),
  }));
  const alert = await sendAlert(c, {
    to: c.env.SUPPORT_EMAIL,
    rows: summaries,
    dedupeKey: ownerFallbackDigestKey(batch.map((r) => r.id)),
    ...(batch.length === 1 ? { entity: { type: 'vendor_request', id: batch[0]!.id } } : {}),
  });

  return { moved: batch.length, capped, alert };
}
