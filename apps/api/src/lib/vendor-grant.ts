/**
 * Vendor claim → verified-account grant batch-builders (AECI-519 /
 * `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §3).
 *
 * D1 has no interactive transactions — only atomic `db.batch([...])`. Like
 * `lib/audit.ts`, each function RETURNS the Drizzle statements (plus the audit /
 * workflow entries the caller forwards post-commit — §26.5, PostHog beside
 * Datadog for the AECI-639 dual-run) rather than
 * executing them, so the seat write, the request resolution, and the `audit_log`
 * row all commit or roll back as one unit (§26.1 — no state change without an
 * audit row). The route handler (`routes/admin-claims.ts`) owns HTTP, identity
 * resolution, and the post-commit cache purge / email; this module is pure so the
 * batch shape is unit-testable without a live Supabase or the D1 harness.
 *
 * The pieces are split out (rather than inlined in the handler) so the grant,
 * reject, and revoke batches share one no-drift definition and AECI-524 can wire
 * an endpoint onto `revokeSeatStatements` later without re-deriving the shape.
 *
 * ── THIS MODULE NEVER TOUCHES `vendors` (AECI-612 / §6 step 1) ─────────────────
 * `grantSeatStatements` used to emit `UPDATE vendors SET verified = 1` itself. It
 * does not any more: `vendors.verified` is a denormalized MIRROR of
 * `vendor_entitlements` (§2.1) and `lib/vendor-entitlement.ts` is its SOLE writer.
 * `approveClaim` now composes the two builders —
 * `db.batch([...grant.stmts, ...ent.stmts])` — so the seat, the entitlement row,
 * the mirror flip and both audit rows still commit or roll back as ONE unit. What
 * did NOT change is the audit shape: `vendorWasVerified` is still a parameter and
 * `verified_flipped` / `beforeState.vendor_verified` / `afterState.vendor_verified`
 * are still written. They are pure metadata with no statement behind them, which is
 * why the refactor is invisible to every shipped claim assertion.
 *
 * An ESLint `no-restricted-syntax` rule (`eslint.config.base.mjs`, Guard 1) now
 * covers this file, and `vendor-grant.spec.ts` asserts by generated SQL that no
 * statement here names `vendors` at all — the invariant cannot silently regress.
 */

import type { ClaimEntitlement } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import type { WorkflowTransitionEntry } from '@aeci/shared/workflow-transition';
import { and, eq, inArray } from 'drizzle-orm';

import type { Db } from '../db/client';
import { profiles, vendorRequests, workflowInstances } from '../db/schema';
import { auditInsert, workflowTransitionInsert, type BatchStmt } from './audit';
import { VENDOR_ADMIN_ROLE } from './claimed-vendors';

/** The role a granted seat drops back to on revoke — the `profiles` default. */
const REVIEWER_ROLE = 'reviewer';

/**
 * `metadata.source` on every audit row this module writes. Matches the admin
 * moderation surfaces (`admin-requests.ts` / `admin-reviews.ts`): the actor is an
 * `admin` acting on `/api/admin/*`, so the trail reads alongside the other
 * moderation actions, not the vendor-portal self-service edits (`vendor-portal`).
 *
 * EXPORTED for `routes/admin-claims.ts`, which passes it to
 * `activateEntitlementStatements` so the grant's TWO audit rows —
 * `vendor_claim.granted` here and `vendor_entitlement.granted` there — carry the
 * same `source` tag and read as one action in the trail (§6.3).
 */
export const CLAIM_AUDIT_SOURCE = 'admin-moderation';

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
  /** Whether the vendor was ALREADY verified. AUDIT METADATA ONLY since AECI-612 —
   *  there is no `vendors` statement behind it here any more; the flip itself is
   *  emitted by `activateEntitlementStatements` in the same batch (§2.1 / §6). It is
   *  kept because `verified_flipped` and the before/after `vendor_verified` snapshots
   *  are what make the claim's audit row self-contained. */
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
  /**
   * `metadata.source` on the audit row. Defaults to the admin-moderation tag this
   * module was written for; AECI-664's vendor-side revoke passes `'vendor-portal'`
   * so the trail distinguishes "AECi un-granted a seat" from "the vendor removed
   * a colleague" — the actor_type is `'user'` for both a reviewer and a vendor
   * admin, so the tag is the only thing that separates them.
   */
  source?: string;
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
 * (2) guarded request resolve, (3) `vendor_claim` workflow completion +
 * transition, (4) audit. **FIVE statements, none of them on `vendors`.**
 *
 * The seat upsert sets ONLY `role`/`vendor_id` (+ `updated_at`) on conflict, so a
 * grant landing before the claimant's first sign-in — or after — never clobbers
 * `display_name`, `theme_preference`, `work_email_verified`, `trust_tier` (a
 * REVIEWER concept whose CHECK vocabulary happens to contain `'verified'` — not
 * this epic's entitlement tier, R4), or the ban columns (§2 no-clobber contract).
 *
 * The `vendors.verified` flip that used to be statement (2) moved to
 * `activateEntitlementStatements` (AECI-612 / §6 step 1), which the caller
 * concatenates into the SAME batch. Multi-seat safety is unchanged and now comes
 * from the §2.3 matrix: a second seat on a vendor with an `active` entitlement
 * emits ZERO entitlement statements and ZERO `vendors` statements, so there is no
 * redundant flip and no `updated_at` churn, while the seat + audit still land.
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
    // `seatOwner: true` (AECI-664 / §11a) — a seat granted through the §5 admin
    // claim review IS the owner event: a human reviewer confirmed this person
    // represents this vendor, which is exactly the authority an invite delegates.
    // A seat created by ACCEPTING an invite gets `false` instead
    // (`lib/vendor-seat-invites.ts`), which is what bounds the invite chain.
    db
      .insert(profiles)
      .values({ id: p.userId, role: VENDOR_ADMIN_ROLE, vendorId: p.vendorId, seatOwner: true })
      .onConflictDoUpdate({
        target: profiles.id,
        set: {
          role: VENDOR_ADMIN_ROLE,
          vendorId: p.vendorId,
          seatOwner: true,
          updatedAt: p.resolvedAt,
        },
      }),
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
 * vendor-level un-verify is a separate entitlement action, owned by
 * `deactivateEntitlementStatements` (`STAGE_2_PAID_TIERS_SPEC.md` §5.2 — three
 * orthogonal "take it away" actions).
 * The `WHERE` is scoped to an ACTIVE `vendor_admin` seat on this vendor, so
 * revoking a non-seat is a safe no-op that still records its audit row.
 *
 * A mechanic with **no HTTP endpoint** at launch. AECI-524 (moderation) scoped
 * revoke OUT — it wired the ban gate only (`STAGE_2_VENDOR_PORTAL_SPEC.md` §7);
 * un-granting stays the separate, explicit revoke action, and self-serve
 * invite/revoke is deferred (`STAGE_2_SPEC.md` §8.2 / §11). Exported + tested so
 * the batch shape is pinned now for whichever issue eventually wires it.
 */
export function revokeSeatStatements(db: Db, p: RevokeSeatParams): RevokeBatch {
  const metadata = {
    source: p.source ?? CLAIM_AUDIT_SOURCE,
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
    afterState: { role: REVIEWER_ROLE, vendor_id: null, seat_owner: false },
    metadata,
  };

  const stmts: BatchStmt[] = [
    // `seatOwner: false` rides along (AECI-664): the column is meaningless off a
    // `vendor_admin` row, and leaving a stale `true` behind would silently make
    // the account an owner again the moment any future grant re-links it.
    db
      .update(profiles)
      .set({ role: REVIEWER_ROLE, vendorId: null, seatOwner: false, updatedAt: p.now })
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

/**
 * The operator note write (AECI-739 / §5.2 step 6). One column, one audit row.
 */
export interface SaveClaimNotesParams {
  requestId: string;
  actorId: string;
  actorType: AuditLogEntry['actorType'];
  /** The note as it stands on the row — `null` for "no note yet". */
  before: string | null;
  /** The note to store; `null` clears it. */
  after: string | null;
  status: string;
  targetType: string;
  targetId: string;
}

/** The statements + audit entry a note write produces. No workflow transition —
 *  see `saveClaimNotesStatements`. */
export interface ClaimNotesBatch {
  stmts: BatchStmt[];
  auditEntry: AuditLogEntry;
}

/**
 * The operator-note batch (AECI-739 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §5.2 step 6):
 * write `vendor_requests.admin_notes`, audit. **TWO statements**, and the audit row
 * is in the same batch because a note is domain state (§26.1) — the note IS the
 * record of why a claim was parked, so losing it while keeping the write would be
 * exactly the failure the invariant exists to prevent.
 *
 * **No `workflow_transitions` / `workflow_instances` row, deliberately.** The
 * `vendor_claim` workflow tracks the claim's STATUS (`open → resolved|rejected`), and
 * a note changes no status — it is writable at any of the four, including the two
 * terminal ones. A note is not a transition, and `workflow_instances_type_check` is a
 * closed CHECK whose widening is a full SQLite table rebuild besides
 * (`routes/admin-entitlements.ts`).
 *
 * **The audit rows ARE the note's history.** The column holds only the current text;
 * `before_state`/`after_state` carry the full old and new note on every write, so the
 * conversation §5.2 step 6 used to keep in Linear comments is reconstructable from the
 * trail — the same arrangement §2.1 uses for the entitlement ledger. That is also why
 * the caller must skip this builder entirely on an unchanged note rather than writing
 * a no-op row: a trail of identical states is not a history.
 *
 * The `WHERE` is unguarded on status (every status is writable) but scoped to the id,
 * and the caller has already established that the row is a `kind='claim'`.
 */
export function saveClaimNotesStatements(db: Db, p: SaveClaimNotesParams): ClaimNotesBatch {
  const auditEntry: AuditLogEntry = {
    actorId: p.actorId,
    actorType: p.actorType,
    action: 'vendor_claim.note_updated',
    entityType: 'vendor_request',
    entityId: p.requestId,
    beforeState: { admin_notes: p.before },
    afterState: { admin_notes: p.after },
    metadata: {
      source: CLAIM_AUDIT_SOURCE,
      kind: 'claim',
      target_type: p.targetType,
      target_id: p.targetId,
      // The claim's status is UNCHANGED by this write; recorded so the trail shows
      // at which point in the claim's life the note was taken.
      status: p.status,
      cleared: p.after === null,
    },
  };

  const stmts: BatchStmt[] = [
    db
      .update(vendorRequests)
      .set({ adminNotes: p.after })
      .where(eq(vendorRequests.id, p.requestId)),
    auditInsert(db, auditEntry),
  ];

  return { stmts, auditEntry };
}
