/**
 * Vendor claim → verified-account grant batch-builders (AECI-519 /
 * `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §3).
 *
 * D1 has no interactive transactions — only atomic `db.batch([...])`. Like
 * `lib/audit.ts`, each function RETURNS the Drizzle statements (plus the audit /
 * workflow entries the caller forwards to Datadog post-commit) rather than
 * executing them, so the seat write, the `vendors.verified` flip, the request
 * resolution, and the `audit_log` row all commit or roll back as one unit
 * (§26.1 — no state change without an audit row). The route handler
 * (`routes/admin-claims.ts`) owns HTTP, identity resolution, and the post-commit
 * cache purge / email; this module is pure so the batch shape is unit-testable
 * without a live Supabase or the D1 harness.
 *
 * The pieces are split out (rather than inlined in the handler) so the grant,
 * reject, and revoke batches share one no-drift definition and AECI-524 can wire
 * an endpoint onto `revokeSeatStatements` later without re-deriving the shape.
 */

import type { ClaimEntitlement } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import type { WorkflowTransitionEntry } from '@aeci/shared/workflow-transition';
import { and, eq, inArray } from 'drizzle-orm';

import type { Db } from '../db/client';
import { profiles, vendorRequests, vendors, workflowInstances } from '../db/schema';
import { auditInsert, workflowTransitionInsert, type BatchStmt } from './audit';
import { VENDOR_ADMIN_ROLE } from './claimed-vendors';

/** The role a granted seat drops back to on revoke — the `profiles` default. */
const REVIEWER_ROLE = 'reviewer';

/**
 * `metadata.source` on every audit row this module writes. Matches the admin
 * moderation surfaces (`admin-requests.ts` / `admin-reviews.ts`): the actor is an
 * `admin` acting on `/api/admin/*`, so the trail reads alongside the other
 * moderation actions, not the vendor-portal self-service edits (`vendor-portal`).
 */
const CLAIM_AUDIT_SOURCE = 'admin-moderation';

/** `workflow_instances.final_outcome` for the terminal claim statuses (§26.2),
 *  mirroring `TERMINAL_OUTCOME` in `routes/admin-requests.ts`. */
export const CLAIM_TERMINAL_OUTCOME = {
  resolved: 'completed',
  rejected: 'rejected',
} as const;

/** A `profiles` snapshot before the write — the exclusivity-checked columns plus
 *  what the audit before-state records. `null` when the account has never signed
 *  in (no `profiles` row yet). */
export interface SeatProfileBefore {
  role: string;
  vendorId: string | null;
}

/** The statements + forwarding entries a claim moderation batch produces. */
export interface ClaimBatch {
  stmts: BatchStmt[];
  auditEntry: AuditLogEntry;
  workflowEntry: WorkflowTransitionEntry;
}

export interface GrantSeatParams {
  /** Resolved auth-user id (= `profiles.id`, = JWT `sub`). */
  userId: string;
  /** The VENDOR being claimed (a product claim's vendor is resolved by the caller). */
  vendorId: string;
  requestId: string;
  /** The acting admin. */
  actorId: string;
  actorType: AuditLogEntry['actorType'];
  /** ISO timestamp used for `resolved_at` / the seat + vendor `updated_at` stamp. */
  resolvedAt: string;
  /** The request's real prior state — `'open' | 'in_review'`. */
  fromStatus: string;
  /** Whether the vendor was ALREADY verified (drives `verified_flipped` in audit;
   *  a second-seat grant leaves the flip a no-op). */
  vendorWasVerified: boolean;
  workflowId: string;
  /** Whether a `vendor_claim` workflow instance already exists (update vs insert). */
  existingWf: boolean;
  /** `linked` (auth user pre-existed) vs `invited` (provisioned) — audit only. */
  identityOutcome: 'linked' | 'invited';
  /** Whether a brand-new `profiles` row is written (grant before first sign-in). */
  seatCreated: boolean;
  /** The seat profile before the write (audit before-state); `null` if none. */
  profileBefore: SeatProfileBefore | null;
  /** The offline PO/invoice arrangement — the launch entitlement record (§3). */
  entitlement?: ClaimEntitlement;
  reason: string | null;
  targetType: string;
  targetId: string;
}

export interface RejectClaimParams {
  requestId: string;
  actorId: string;
  actorType: AuditLogEntry['actorType'];
  resolvedAt: string;
  fromStatus: string;
  workflowId: string;
  existingWf: boolean;
  reason: string | null;
  targetType: string;
  targetId: string;
}

export interface RevokeSeatParams {
  /** The seat to revoke (`profiles.id`). */
  userId: string;
  /** The vendor the seat is on — the revoke is scoped to it so a stray seat can't
   *  be un-granted by targeting the wrong vendor. */
  vendorId: string;
  actorId: string;
  actorType: AuditLogEntry['actorType'];
  now: string;
  profileBefore: SeatProfileBefore | null;
  reason?: string | null;
}

/** The statements + audit entry a seat revoke produces (no workflow transition —
 *  a revoke is a seat operation, not a claim state change). */
export interface RevokeBatch {
  stmts: BatchStmt[];
  auditEntry: AuditLogEntry;
}

/** Shared audit metadata for a claim moderation. */
function claimMetadata(
  p: Pick<GrantSeatParams, 'targetType' | 'targetId' | 'reason'>,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  return {
    source: CLAIM_AUDIT_SOURCE,
    kind: 'claim',
    target_type: p.targetType,
    target_id: p.targetId,
    ...extra,
    ...(p.reason ? { reason: p.reason } : {}),
  };
}

/**
 * The grant batch (§3): (1) no-clobber seat upsert → `vendor_admin` + `vendor_id`,
 * (2) guarded `vendors.verified = true` (+ `updated_at`), (3) guarded request
 * resolve, (4) `vendor_claim` workflow completion + transition, (5) audit.
 *
 * The seat upsert sets ONLY `role`/`vendor_id` (+ `updated_at`) on conflict, so a
 * grant landing before the claimant's first sign-in — or after — never clobbers
 * `display_name`, `theme_preference`, `work_email_verified`, `trust_tier`, or the
 * ban columns (§2 no-clobber contract). The verified flip is guarded on
 * `verified = false`, so a second seat on an already-verified vendor is a no-op
 * there (no redundant flip, no `updated_at` churn), while the seat + audit still
 * land — multi-seat safe. `updated_at` is stamped explicitly (not left to
 * `$onUpdate`) to match `routes/vendor.ts` and guarantee the Algolia watermark
 * (AECI-529) moves.
 */
export function grantSeatStatements(db: Db, p: GrantSeatParams): ClaimBatch {
  const verifiedFlipped = !p.vendorWasVerified;
  const hasEntitlement = p.entitlement && Object.keys(p.entitlement).length > 0;
  const metadata = claimMetadata(p, {
    vendor_id: p.vendorId,
    seat_user_id: p.userId,
    identity_outcome: p.identityOutcome,
    seat_created: p.seatCreated,
    verified_flipped: verifiedFlipped,
    ...(hasEntitlement ? { entitlement: p.entitlement } : {}),
  });

  const auditEntry: AuditLogEntry = {
    actorId: p.actorId,
    actorType: p.actorType,
    action: 'vendor_claim.granted',
    entityType: 'vendor_request',
    entityId: p.requestId,
    beforeState: {
      status: p.fromStatus,
      vendor_verified: p.vendorWasVerified,
      seat_role: p.profileBefore?.role ?? null,
      seat_vendor_id: p.profileBefore?.vendorId ?? null,
    },
    afterState: {
      status: 'resolved',
      vendor_verified: true,
      seat_role: VENDOR_ADMIN_ROLE,
      seat_vendor_id: p.vendorId,
    },
    metadata,
  };

  const workflowEntry: WorkflowTransitionEntry = {
    workflowId: p.workflowId,
    fromState: p.fromStatus,
    toState: 'resolved',
    actorId: p.actorId,
    reason: p.reason,
    metadata,
  };

  const stmts: BatchStmt[] = [
    db
      .insert(profiles)
      .values({ id: p.userId, role: VENDOR_ADMIN_ROLE, vendorId: p.vendorId })
      .onConflictDoUpdate({
        target: profiles.id,
        set: { role: VENDOR_ADMIN_ROLE, vendorId: p.vendorId, updatedAt: p.resolvedAt },
      }),
    db
      .update(vendors)
      .set({ verified: true, updatedAt: p.resolvedAt })
      .where(and(eq(vendors.id, p.vendorId), eq(vendors.verified, false))),
    db
      .update(vendorRequests)
      .set({ status: 'resolved', resolvedById: p.actorId, resolvedAt: p.resolvedAt })
      .where(
        and(
          eq(vendorRequests.id, p.requestId),
          inArray(vendorRequests.status, ['open', 'in_review']),
        ),
      ),
    p.existingWf
      ? db
          .update(workflowInstances)
          .set({
            currentState: 'resolved',
            completedAt: p.resolvedAt,
            finalOutcome: CLAIM_TERMINAL_OUTCOME.resolved,
          })
          .where(eq(workflowInstances.id, p.workflowId))
      : db.insert(workflowInstances).values({
          id: p.workflowId,
          workflowType: 'vendor_claim',
          entityId: p.requestId,
          currentState: 'resolved',
          completedAt: p.resolvedAt,
          finalOutcome: CLAIM_TERMINAL_OUTCOME.resolved,
        }),
    workflowTransitionInsert(db, workflowEntry),
    auditInsert(db, auditEntry),
  ];

  return { stmts, auditEntry, workflowEntry };
}

/**
 * The reject batch (§3 reject path): resolve the request to `rejected`, advance
 * the `vendor_claim` workflow, audit. No vendor mutation, no seat write, no cache
 * purge, no identity resolution — a rejected claim provisions nothing.
 */
export function rejectClaimStatements(db: Db, p: RejectClaimParams): ClaimBatch {
  const metadata = claimMetadata(p, {});

  const auditEntry: AuditLogEntry = {
    actorId: p.actorId,
    actorType: p.actorType,
    action: 'vendor_claim.rejected',
    entityType: 'vendor_request',
    entityId: p.requestId,
    beforeState: { status: p.fromStatus },
    afterState: { status: 'rejected' },
    metadata,
  };

  const workflowEntry: WorkflowTransitionEntry = {
    workflowId: p.workflowId,
    fromState: p.fromStatus,
    toState: 'rejected',
    actorId: p.actorId,
    reason: p.reason,
    metadata,
  };

  const stmts: BatchStmt[] = [
    db
      .update(vendorRequests)
      .set({ status: 'rejected', resolvedById: p.actorId, resolvedAt: p.resolvedAt })
      .where(
        and(
          eq(vendorRequests.id, p.requestId),
          inArray(vendorRequests.status, ['open', 'in_review']),
        ),
      ),
    p.existingWf
      ? db
          .update(workflowInstances)
          .set({
            currentState: 'rejected',
            completedAt: p.resolvedAt,
            finalOutcome: CLAIM_TERMINAL_OUTCOME.rejected,
          })
          .where(eq(workflowInstances.id, p.workflowId))
      : db.insert(workflowInstances).values({
          id: p.workflowId,
          workflowType: 'vendor_claim',
          entityId: p.requestId,
          currentState: 'rejected',
          completedAt: p.resolvedAt,
          finalOutcome: CLAIM_TERMINAL_OUTCOME.rejected,
        }),
    workflowTransitionInsert(db, workflowEntry),
    auditInsert(db, auditEntry),
  ];

  return { stmts, auditEntry, workflowEntry };
}

/**
 * The seat-revoke batch (AC / §3 reversibility): drop the seat back to `reviewer`
 * and unlink `vendor_id`, audited. **Never touches `vendors.verified`** —
 * `verified` is a vendor-level paid state, not a seat property, so revoking one of
 * several seats must not un-verify the vendor (`STAGE_2_SPEC.md` §8.3(2)); the
 * vendor-level un-verify is a separate entitlement action (AECI-515), unowned
 * today. The `WHERE` is scoped to an ACTIVE `vendor_admin` seat on this vendor, so
 * revoking a non-seat is a safe no-op that still records its audit row.
 *
 * A mechanic only in this issue — AECI-524 (moderation surface) wires the HTTP
 * endpoint. Exported + tested so the batch shape is pinned now.
 */
export function revokeSeatStatements(db: Db, p: RevokeSeatParams): RevokeBatch {
  const metadata = {
    source: CLAIM_AUDIT_SOURCE,
    vendor_id: p.vendorId,
    seat_user_id: p.userId,
    // Explicit in the trail: a seat revoke deliberately leaves the vendor verified.
    verified_untouched: true,
    ...(p.reason ? { reason: p.reason } : {}),
  };

  const auditEntry: AuditLogEntry = {
    actorId: p.actorId,
    actorType: p.actorType,
    action: 'vendor_claim.seat_revoked',
    entityType: 'profile',
    entityId: p.userId,
    beforeState: {
      role: p.profileBefore?.role ?? null,
      vendor_id: p.profileBefore?.vendorId ?? null,
    },
    afterState: { role: REVIEWER_ROLE, vendor_id: null },
    metadata,
  };

  const stmts: BatchStmt[] = [
    db
      .update(profiles)
      .set({ role: REVIEWER_ROLE, vendorId: null, updatedAt: p.now })
      .where(
        and(
          eq(profiles.id, p.userId),
          eq(profiles.vendorId, p.vendorId),
          eq(profiles.role, VENDOR_ADMIN_ROLE),
        ),
      ),
    auditInsert(db, auditEntry),
  ];

  return { stmts, auditEntry };
}
