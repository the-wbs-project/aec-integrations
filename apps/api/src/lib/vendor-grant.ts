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
 * Since AECI-1367 `approveClaim` composes no entitlement at all: every approval lands
 * on Free, so the batch is this module's seat statements, the billing account
 * (`lib/billing-account.ts`) and the acceptance link (`lib/agreement-acceptances.ts`).
 * The audit row still records `beforeState.vendor_verified` and
 * `afterState.vendor_verified` (now always equal) and `verified_flipped: false`, so
 * a grant row reads the same shape as the older ones beside it.
 *
 * An ESLint `no-restricted-syntax` rule (`eslint.config.base.mjs`, Guard 1) now
 * covers this file, and `vendor-grant.spec.ts` asserts by generated SQL that no
 * statement here names `vendors` at all — the invariant cannot silently regress.
 */

import { ApiErrorCode, DISPLAY_NAME_MAX_LENGTH, vendorVisibleReasonMetadata } from '@aeci/shared';
import type { AuditLogEntry } from '@aeci/shared/audit-log';
import type { VendorPlanSnapshot } from '@aeci/shared/entitlements';
import type { WorkflowTransitionEntry } from '@aeci/shared/workflow-transition';
import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { profiles, vendorRequests, workflowInstances } from '../db/schema';
import { ApiError } from '../errors';
import { auditInsert, workflowTransitionInsert, type BatchStmt } from './audit';
import { VENDOR_ADMIN_ROLE } from './claimed-vendors';
import { ONE_ROW } from './integration-claims';
import { ownerSeatExistsSql } from './owner-seat';

/** The role a granted seat drops back to on revoke — the `profiles` default. */
const REVIEWER_ROLE = 'reviewer';

/**
 * `metadata.source` on every audit row this module writes. Matches the admin
 * moderation surfaces (`admin-requests.ts` / `admin-reviews.ts`): the actor is an
 * `admin` acting on `/api/admin/*`, so the trail reads alongside the other
 * moderation actions, not the vendor-portal self-service edits (`vendor-portal`).
 *
 * EXPORTED for `routes/admin-claims.ts`, which passes it to the billing-account and
 * acceptance-link builders so every audit row of one grant carries the same `source`
 * tag and reads as one action in the trail.
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
  /** The account's current name. Read by the grant only, to report whether it
   *  filled an empty name (AECI-1280); the revoke never looks at it. */
  displayName?: string | null;
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
  /** The vendor's plan BEFORE this write (AECI-1193), from `loadEntitlement` +
   *  `vendorPlanSnapshot`, or the vendor session's on the owner-side revoke. */
  vendorPlan: VendorPlanSnapshot;
  requestId: string;
  /** The acting admin. */
  actorId: string;
  actorType: AuditLogEntry['actorType'];
  /** ISO timestamp used for `resolved_at` / the seat + vendor `updated_at` stamp. */
  resolvedAt: string;
  /** The request's real prior state — `'open' | 'in_review'`. */
  fromStatus: string;
  /** Whether the vendor was verified. AUDIT METADATA ONLY: no statement here or
   *  beside it moves the mirror since AECI-1367, so the before and after
   *  `vendor_verified` snapshots both carry this value. */
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
  /** The claim's `submitter_name`. Fills the seat's `display_name` only when that
   *  is null or blank (AECI-1280). */
  submitterName: string | null;
  /**
   * Whether the same batch creates the vendor's billing account (AECI-1367,
   * `ensureBillingAccountStatements` returned statements). Lands as
   * `metadata.billing_account_created`, so the grant row says it on its own.
   */
  billingAccountCreated: boolean;
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
  /**
   * `metadata.source` on the audit row and the transition. Defaults to
   * {@link CLAIM_AUDIT_SOURCE}. An owner's decline from the Seats section (AECI-1368)
   * passes `'vendor-portal'`, so the trail tells "AECi rejected" from "the company's
   * owner declined": the actor type is `'user'` for both.
   */
  source?: string;
  /** The vendor the audit row is about, when the caller knows it (the owner decline). */
  vendorId?: string;
  /**
   * The owner decline (AECI-1368) sets this: the batch then also aborts when the
   * claim is no longer routed to the owners, because the 7-day fallback moved it to
   * AECi between the handler's read and the batch (`claimUndecidedSentinel`).
   */
  requireRouted?: boolean;
}

/** An owner accepting a claim routed to their company (AECI-1368, §11a.10). */
export interface OwnerAcceptClaimParams {
  requestId: string;
  /** The owner seat accepting it: the audit actor and `resolved_by_id`. */
  actorId: string;
  actorType: AuditLogEntry['actorType'];
  vendorId: string;
  resolvedAt: string;
  fromStatus: string;
  workflowId: string;
  existingWf: boolean;
  /** The seat invite the accept issued (or the live one it reused) to the claimant. */
  inviteId: string;
  /** `true` when the batch also creates that invite, `false` when it reused one. */
  inviteCreated: boolean;
}

export interface RevokeSeatParams {
  /** The seat to revoke (`profiles.id`). */
  userId: string;
  /** The vendor the seat is on — the revoke is scoped to it so a stray seat can't
   *  be un-granted by targeting the wrong vendor. */
  vendorId: string;
  /** The vendor's plan BEFORE this write (AECI-1193), from `loadEntitlement` +
   *  `vendorPlanSnapshot`, or the vendor session's on the owner-side revoke. */
  vendorPlan: VendorPlanSnapshot;
  actorId: string;
  actorType: AuditLogEntry['actorType'];
  now: string;
  profileBefore: SeatProfileBefore | null;
  /**
   * The admin's reason (AECI-1191). Only the admin revoke passes one, and since
   * AECI-1159 it is written for the vendor: it lands with `reasonVisibility:
   * 'vendor'`, and `internalNote` beside it stays AECi's.
   */
  reason?: string | null;
  internalNote?: string | null;
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
 * The seat upsert sets ONLY `role`/`vendor_id`/`seat_owner` (+ `updated_at`) on
 * conflict, so a grant landing before the claimant's first sign-in — or after —
 * never clobbers `theme_preference`, `work_email_verified`, `trust_tier` (a
 * REVIEWER concept whose CHECK vocabulary happens to contain `'verified'` — not
 * this epic's entitlement tier, R4), or the ban columns (§2 no-clobber contract).
 *
 * ── THE ONE EXCEPTION: AN EMPTY `display_name` (AECI-1280) ──────────────────
 * The claim carries the claimant's name, so the grant fills `display_name` from
 * `submitter_name` when the column is null or blank. It never overwrites a name:
 * the set is `COALESCE(NULLIF(trim(display_name), ''), excluded.display_name)`,
 * so the SQL keeps whatever non-blank name the row holds at commit time. A name
 * that is blank or longer than `DISPLAY_NAME_MAX_LENGTH` (the account form's own
 * cap) is not filled and not truncated; the column is then absent from the set
 * list entirely. The audit row's `display_name_filled` is computed from the
 * `profileBefore` snapshot, so a user who sets a name between that read and this
 * batch keeps it while the row over-reports a fill. That window is accepted.
 *
 * ── WHO BECOMES AN OWNER (AECI-1367, Portal §11a.4) ─────────────────────────
 * A grant makes the claimant an owner (`seat_owner = 1`) only when the vendor has
 * no unbanned owner seat at commit time. The test is SQL, not a TS pre-read: the
 * INSERT's `seat_owner` is a `NOT EXISTS` over `profiles`, evaluated inside the
 * batch. D1 runs batches one at a time, so of two first approvals on the same
 * vendor the second sees the first's owner and lands as a non-owner. A later
 * claimant on a seated vendor joins as a colleague, the same rank an invite gives.
 *
 * The conflict path never demotes: an existing row that is already an owner seat of
 * this vendor keeps `seat_owner = 1` whatever the subquery says. A row that is an
 * owner of nothing here (a reviewer, a revoked seat) takes the computed value.
 *
 * The `vendors.verified` flip that used to be statement (2) left this module in
 * AECI-612, and since AECI-1367 no claim grant composes an entitlement at all.
 */
export function grantSeatStatements(db: Db, p: GrantSeatParams): ClaimBatch {
  // No grant moves the mirror since AECI-1367: every approval lands on Free.
  const fillName = usableSubmitterName(p.submitterName);
  const nameBefore = p.profileBefore?.displayName ?? null;
  const nameFilled = fillName !== null && !nameBefore?.trim();
  const metadata = claimMetadata(p, {
    vendorId: p.vendorId,
    seat_user_id: p.userId,
    identity_outcome: p.identityOutcome,
    seat_created: p.seatCreated,
    verified_flipped: false,
    billing_account_created: p.billingAccountCreated,
    display_name_filled: nameFilled,
  });

  const auditEntry: AuditLogEntry = {
    actorId: p.actorId,
    actorType: p.actorType,
    action: 'vendor_claim.granted',
    vendorId: p.vendorId,
    vendorPlan: p.vendorPlan,
    entityType: 'vendor_request',
    entityId: p.requestId,
    beforeState: {
      status: p.fromStatus,
      vendor_verified: p.vendorWasVerified,
      seat_role: p.profileBefore?.role ?? null,
      seat_vendor_id: p.profileBefore?.vendorId ?? null,
      seat_display_name: nameBefore,
    },
    afterState: {
      status: 'resolved',
      vendor_verified: p.vendorWasVerified,
      seat_role: VENDOR_ADMIN_ROLE,
      seat_vendor_id: p.vendorId,
      seat_display_name: nameFilled ? fillName : nameBefore,
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
    // AECI-1333: first, so a claim decided since the handler's read writes nothing.
    claimUndecidedSentinel(db, p.requestId),
    // `seatOwner` (AECI-664 / §11a, narrowed by AECI-1367): the first reviewed
    // claimant on a vendor is its owner. Later ones join as colleagues. Both halves
    // are SQL so the decision is made at commit time (see the docblock above). A
    // seat created by ACCEPTING an invite is always `false`
    // (`lib/vendor-seat-invites.ts`), which is what bounds the invite chain.
    db
      .insert(profiles)
      .values({
        id: p.userId,
        role: VENDOR_ADMIN_ROLE,
        vendorId: p.vendorId,
        seatOwner: firstOwnerSql(p.vendorId),
        ...(fillName !== null ? { displayName: fillName } : {}),
      })
      .onConflictDoUpdate({
        target: profiles.id,
        set: {
          role: VENDOR_ADMIN_ROLE,
          vendorId: p.vendorId,
          seatOwner: keepOwnerSql(p.vendorId),
          // Fill-if-empty, never overwrite (AECI-1280). Absent when there is no
          // usable name, so the statement is then exactly the pre-AECI-1280 one.
          ...(fillName !== null
            ? {
                displayName: sql`COALESCE(NULLIF(trim(${profiles.displayName}), ''), excluded.display_name)`,
              }
            : {}),
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
 * `1` when the vendor has no unbanned owner seat, else `0` (AECI-1367). The one
 * owner predicate: `seat_owner = 1 AND banned_at IS NULL AND vendor_id = <vendor>`.
 * Aliased so the subquery's columns can never bind to the row being upserted.
 */
function firstOwnerSql(vendorId: string) {
  // AECI-1368: the predicate lives in `lib/owner-seat.ts`, shared with claim routing
  // and `has_seats`, so the three can never disagree about who is an owner.
  return sql<boolean>`NOT ${ownerSeatExistsSql(vendorId)}`;
}

/**
 * The conflict half of the owner rule: never demote. A row that is already an owner
 * seat of THIS vendor stays one. Any other row takes the value the INSERT computed
 * (`excluded.seat_owner`). SQLite evaluates every `SET` expression against the old
 * row, so `role` and `vendor_id` here are the values before this upsert.
 */
function keepOwnerSql(vendorId: string) {
  return sql<boolean>`CASE WHEN "profiles"."role" = ${VENDOR_ADMIN_ROLE} AND "profiles"."vendor_id" = ${vendorId} AND "profiles"."seat_owner" = 1 THEN 1 ELSE excluded.seat_owner END`;
}

/** The claim's name as the grant may write it: trimmed, non-empty, and within the
 *  account form's own cap. Anything else is `null` — not filled, never truncated. */
function usableSubmitterName(name: string | null): string | null {
  const trimmed = name?.trim() ?? '';
  return trimmed.length > 0 && trimmed.length <= DISPLAY_NAME_MAX_LENGTH ? trimmed : null;
}

// ─── The decision-race sentinel (AECI-1333) ──────────────────────────────────

/** The token the sentinel raises with. `json()` on it is malformed JSON. */
const CLAIM_DECIDED_TOKEN = 'vendor-claim-decided';

/**
 * The FIRST statement of every claim decision batch: AECi's approve and reject, and
 * an owner's accept and decline. It ABORTS the whole batch when the claim is no
 * longer undecided (`open` or `in_review`), and with `requireRouted` also when it
 * is no longer routed to the owners (`routed_to_owners_at IS NULL`).
 *
 * Why it exists: D1 has no interactive transactions, so a batch cannot branch on
 * whether its guarded `vendor_requests` UPDATE matched. Before this, the loser of a
 * decision race (an admin and an owner, two admins, an owner and the fallback cron)
 * kept its UPDATE a no-op but still committed the seat upsert, the invite, the
 * workflow write, the transition, the billing account, the acceptance link and the
 * audit row. The claim then read `rejected` with a granted seat behind it.
 *
 * How: the same `json()` abort as `contestStillOpenSentinel`
 * (`lib/integration-contests.ts`). The CASE reads the claim's own state, not
 * `changes()`, because it runs first, before any write. It selects FROM a one-row
 * constant, so a missing claim row also raises rather than passing silently.
 * {@link isClaimDecidedAbort} recognises the error. The handler re-reads the claim
 * to tell this abort from any other `json()` sentinel in the same batch.
 */
export function claimUndecidedSentinel(
  db: Db,
  requestId: string,
  opts: { requireRouted?: boolean } = {},
): BatchStmt {
  const routed = opts.requireRouted
    ? sql` AND ${vendorRequests.routedToOwnersAt} IS NOT NULL`
    : sql``;
  return db
    .select({
      guard: sql`CASE WHEN NOT EXISTS (SELECT 1 FROM ${vendorRequests}
          WHERE ${vendorRequests.id} = ${requestId}
            AND ${vendorRequests.status} IN ('open', 'in_review')${routed})
        THEN json(${CLAIM_DECIDED_TOKEN}) END`,
    })
    .from(ONE_ROW);
}

/** True for the error {@link claimUndecidedSentinel} raises, in D1 or SQLite. Any
 *  `json()` sentinel raises the same "malformed JSON", so a batch that carries
 *  another one must re-read the claim to know which fired. */
export function isClaimDecidedAbort(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    const text = String((current as { message?: unknown }).message ?? current);
    if (/malformed JSON/i.test(text) || text.includes(CLAIM_DECIDED_TOKEN)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * The `409 CLAIM_ALREADY_DECIDED` for a decision batch that rolled back, or `null`
 * when the `json()` abort was some other sentinel's. The one read on this module's
 * error path: it re-reads the claim, because D1's error does not carry the token.
 * The claim is lost to this decision when it is no longer undecided, or, with
 * `requireRouted`, no longer routed to the owners. `details.status` is what the
 * re-read found (`null` when the row is gone).
 */
export async function claimDecisionRaceError(
  db: Db,
  requestId: string,
  opts: { requireRouted?: boolean } = {},
): Promise<ApiError | null> {
  const row = await db.query.vendorRequests.findFirst({
    columns: { status: true, routedToOwnersAt: true },
    where: eq(vendorRequests.id, requestId),
  });
  const undecided = row?.status === 'open' || row?.status === 'in_review';
  const lost = !undecided || (opts.requireRouted === true && row?.routedToOwnersAt == null);
  if (!lost) return null;
  return new ApiError(
    409,
    ApiErrorCode.CLAIM_ALREADY_DECIDED,
    'This claim changed while you were deciding it, so nothing was saved. Reload to see where it stands.',
    { details: { status: row?.status ?? null } },
  );
}

/**
 * The reject batch (§3 reject path): resolve the request to `rejected`, advance
 * the `vendor_claim` workflow, audit. No vendor mutation, no seat write, no cache
 * purge, no identity resolution — a rejected claim provisions nothing.
 */
export function rejectClaimStatements(db: Db, p: RejectClaimParams): ClaimBatch {
  const metadata = claimMetadata(p, p.source ? { source: p.source } : {});

  const auditEntry: AuditLogEntry = {
    actorId: p.actorId,
    actorType: p.actorType,
    ...(p.vendorId ? { vendorId: p.vendorId } : {}),
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
    // AECI-1333: first, so a claim decided (or, for an owner decline, taken back by
    // the fallback) since the handler's read writes nothing.
    claimUndecidedSentinel(db, p.requestId, { requireRouted: p.requireRouted }),
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
 * An owner accepts a claim routed to their company (AECI-1368,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11a.10): resolve the request with the OWNER as
 * `resolved_by_id`, complete the `vendor_claim` workflow, audit. The caller puts the
 * seat invite (`createInviteStatements`) in the same batch, AFTER these statements.
 *
 * **No seat is written here, and no `vendor_admin` row anywhere.** The claimant gets
 * a seat only by redeeming the invite (`acceptInviteStatements`), which proves they
 * control the address and makes them a member seat, never an owner (§11a.4). That is
 * why the status is `resolved` while no seat exists yet: the claim is decided, and
 * the invite is the grant. `AdminClaim.granted` reads `true` for it, because the
 * owner is a non-null `resolved_by_id`.
 *
 * The batch opens with {@link claimUndecidedSentinel} on still-undecided AND
 * still-routed (AECI-1333), so an AECi decision or the 7-day fallback landing first
 * aborts the whole batch, the caller's invite included. The UPDATE keeps its own
 * guard as a second line.
 */
export function ownerAcceptClaimStatements(db: Db, p: OwnerAcceptClaimParams): ClaimBatch {
  const metadata = {
    source: 'vendor-portal',
    kind: 'claim',
    target_type: 'vendor',
    target_id: p.vendorId,
    decided_by: 'owner',
    invite_id: p.inviteId,
    invite_created: p.inviteCreated,
  };

  const auditEntry: AuditLogEntry = {
    actorId: p.actorId,
    actorType: p.actorType,
    vendorId: p.vendorId,
    action: 'vendor_claim.owner_accepted',
    entityType: 'vendor_request',
    entityId: p.requestId,
    beforeState: { status: p.fromStatus },
    afterState: { status: 'resolved' },
    metadata,
  };

  const workflowEntry: WorkflowTransitionEntry = {
    workflowId: p.workflowId,
    fromState: p.fromStatus,
    toState: 'resolved',
    actorId: p.actorId,
    reason: 'accepted by a company owner',
    metadata,
  };

  const stmts: BatchStmt[] = [
    // AECI-1333: first, so the caller's invite statements (pushed after these) never
    // commit for a claim decided or taken back since the handler's read.
    claimUndecidedSentinel(db, p.requestId, { requireRouted: true }),
    db
      .update(vendorRequests)
      .set({ status: 'resolved', resolvedById: p.actorId, resolvedAt: p.resolvedAt })
      .where(
        and(
          eq(vendorRequests.id, p.requestId),
          inArray(vendorRequests.status, ['open', 'in_review']),
          isNotNull(vendorRequests.routedToOwnersAt),
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
 * The seat-revoke batch (AC / §3 reversibility): drop the seat back to `reviewer`
 * and unlink `vendor_id`, audited. **Never touches `vendors.verified`** —
 * `verified` is a vendor-level paid state, not a seat property, so revoking one of
 * several seats must not un-verify the vendor (`STAGE_2_SPEC.md` §8.3(2)); the
 * vendor-level un-verify is the end of the vendor's last live license (the license
 * revoke or lapse, through `reconcileVerifiedMirror` in `lib/license.ts`; AECI-1375
 * retired the entitlement clear) (`STAGE_2_PAID_TIERS_SPEC.md` §5.2 — three
 * orthogonal "take it away" actions).
 * The `WHERE` is scoped to an ACTIVE `vendor_admin` seat on this vendor, so
 * revoking a non-seat is a safe no-op that still records its audit row.
 *
 * Two HTTP endpoints compose it unchanged: `DELETE /api/vendor/seats/:userId`
 * (the owner side, AECI-664, `STAGE_2_VENDOR_PORTAL_SPEC.md` §11a.5) and
 * `DELETE /api/admin/vendors/:id/seats/:userId` (AECI-652, `ADMIN_PANEL_SPEC.md`
 * §5.7). The admin route also adds `planVendorHandback` (`vendor-handback.ts`,
 * AECI-989) to the same batch when this is the vendor's last seat. It shipped
 * unwired at launch because AECI-524 wired the ban gate only (§7), so
 * un-granting stays a separate, explicit revoke action.
 */
export function revokeSeatStatements(db: Db, p: RevokeSeatParams): RevokeBatch {
  const metadata = {
    source: p.source ?? CLAIM_AUDIT_SOURCE,
    vendorId: p.vendorId,
    seat_user_id: p.userId,
    // Explicit in the trail: a seat revoke deliberately leaves the vendor verified.
    verified_untouched: true,
    ...(p.reason
      ? vendorVisibleReasonMetadata({ reason: p.reason, internalNote: p.internalNote })
      : {}),
  };

  const auditEntry: AuditLogEntry = {
    actorId: p.actorId,
    actorType: p.actorType,
    action: 'vendor_claim.seat_revoked',
    vendorId: p.vendorId,
    vendorPlan: p.vendorPlan,
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
 * The seat-provision batch (AECI-740 / `STAGE_2_SPEC.md` §8.9(3)).
 *
 * The exact inverse of {@link revokeSeatStatements}, and the only path that writes
 * `profiles.role = 'vendor_admin'` with neither a claim nor an invite behind it —
 * and, unlike the claim grant it sits beside, without opening a
 * `vendor_entitlements` row. **TWO statements**, and — like everything else in
 * this module — neither of them names `vendors`.
 *
 * ── WHY IT IS NOT `grantSeatStatements` ──────────────────────────────────────
 * That builder emits five statements, three of which are about a CLAIM: it
 * resolves a `vendor_requests` row and advances a `vendor_claim` workflow
 * instance. A connector vendor's seat is handed over out of band
 * (`STAGE_2_VENDOR_PORTAL_SPEC.md` §5.2) and may have no claim row behind it at
 * all — and where one does exist, §5.2 step 4 deliberately leaves it `open`.
 * Reusing the grant would either need a synthetic request id or would stamp a
 * claim `resolved`, which reads as approved in the Resolved tab with a paid
 * account behind it. Neither is true here.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ─────────────────────────────────────────
 * **No entitlement statement.** §8.9(2) is a fence, not a build: `vendors.verified`
 * mirrors off `status = 'active'`, not `tier` (`lib/vendor-entitlement.ts`), so
 * ANY active row flips the public `verified` mirror, and "a seat but no `verified`" is
 * not expressible through the entitlement table. The seat is therefore not an
 * entitlement row at all. `findVendorProfile` (`lib/authz.ts`) uses a `leftJoin`
 * precisely so this shape authenticates: the holder passes `requireVendor()` and
 * resolves to `unclaimed`, the Free capabilities only (AECI-1214).
 *
 * **No `workflow_instances` / `workflow_transitions` row.** `workflow_instances_type_check`
 * is a closed CHECK whose widening is a full SQLite table rebuild, and a seat is
 * not a claim state change — the same reasoning `saveClaimNotesStatements` gives.
 *
 * **It never writes `banned_at`.** `PATCH /api/admin/reviewers/:id` is the sole
 * writer of that column anywhere in the codebase, asserted at source level by
 * `routes/banned-at-writers.spec.ts`. This builder writes `role`, `vendor_id` and
 * `seat_owner`, and nothing else.
 *
 * ── `seatOwner: true` ────────────────────────────────────────────────────────
 * The rule `grantSeatStatements` followed until AECI-1367 narrowed the claim grant to
 * "first unbanned owner only" (AECI-664 / §11a). This builder keeps it: a seat an AECi
 * operator provisioned by hand IS the owner event — a human confirmed this person
 * represents this vendor, which is exactly the authority an invite delegates. It
 * is also what makes the shipped `/api/vendor/seats/invites` flow usable by the
 * connector vendor without a second admin action every time a colleague joins.
 *
 * The upsert's `set` list is `grantSeatStatements`' minus its empty-name fill
 * (AECI-1280), which needs a claim's `submitter_name` this path does not have. So a
 * provision landing before the holder's first sign-in — or after — never clobbers
 * `display_name`, `theme_preference`, `work_email_verified`, `trust_tier`, or the
 * ban columns (§2 no-clobber contract).
 */
export interface ProvisionSeatParams {
  /** Resolved auth-user id (= `profiles.id`, = JWT `sub`). */
  userId: string;
  vendorId: string;
  /** The vendor's plan BEFORE this write (AECI-1193), from `loadEntitlement` +
   *  `vendorPlanSnapshot`, or the vendor session's on the owner-side revoke. */
  vendorPlan: VendorPlanSnapshot;
  /** The acting admin. */
  actorId: string;
  actorType: AuditLogEntry['actorType'];
  now: string;
  /** `linked` (auth user pre-existed) vs `invited` (provisioned) — audit only. */
  identityOutcome: 'linked' | 'invited';
  /** The seat profile before the write; `null` when the account has never signed
   *  in, in which case the upsert inserts. */
  profileBefore: ProvisionProfileBefore | null;
  /**
   * The §8.8(1) payer test as it stood at the moment of the write. Recorded so
   * the trail shows what the operator was looking at — a `product_role` curated
   * upstream can change afterwards, and the audit row must not silently re-read
   * as a different decision. **Never a gate** (§5.2 step 1: the console warns).
   */
  isPureConnectorVendor: boolean;
  reason?: string | null;
}

/** {@link ProvisionSeatParams}'s before-snapshot. Wider than
 *  {@link SeatProfileBefore} because the no-op check and the audit before-state
 *  both need `seat_owner`, which `ClaimantProfileSnapshot` does not carry. */
export interface ProvisionProfileBefore {
  role: string;
  vendorId: string | null;
  seatOwner: boolean;
  bannedAt: string | null;
}

export function provisionSeatStatements(db: Db, p: ProvisionSeatParams): RevokeBatch {
  const auditEntry: AuditLogEntry = {
    actorId: p.actorId,
    actorType: p.actorType,
    action: 'vendor_seat.provisioned',
    vendorId: p.vendorId,
    vendorPlan: p.vendorPlan,
    // Files under the SEAT, matching `vendor_claim.seat_revoked` — the two are a
    // pair and an operator reading one wants the other beside it.
    entityType: 'profile',
    entityId: p.userId,
    beforeState: {
      role: p.profileBefore?.role ?? null,
      vendor_id: p.profileBefore?.vendorId ?? null,
      seat_owner: p.profileBefore?.seatOwner ?? null,
    },
    afterState: { role: VENDOR_ADMIN_ROLE, vendor_id: p.vendorId, seat_owner: true },
    metadata: {
      source: CLAIM_AUDIT_SOURCE,
      // Since AECI-1192 the `vendor_id` COLUMN is what leg 3 of `auditScopeWhere`
      // (`routes/admin-vendors.ts`) matches; `$.vendor_id` is only its legacy
      // fallback for rows written before. New rows spell the key `vendorId`.
      vendorId: p.vendorId,
      seat_user_id: p.userId,
      identity_outcome: p.identityOutcome,
      seat_created: p.profileBefore === null,
      // Said out loud, in the row itself, mirroring `seat_not_granted: true` on
      // AECI-720's `managed_by` flip from the opposite direction. §8.9(2) is a
      // fence somebody will eventually be tempted to step over; the trail should
      // make it obvious that this action never opened a paid account.
      entitlement_granted: false,
      is_pure_connector_vendor: p.isPureConnectorVendor,
      ...(p.profileBefore?.bannedAt ? { seat_banned: true } : {}),
      ...(p.reason ? { reason: p.reason } : {}),
    },
  };

  const stmts: BatchStmt[] = [
    db
      .insert(profiles)
      .values({ id: p.userId, role: VENDOR_ADMIN_ROLE, vendorId: p.vendorId, seatOwner: true })
      .onConflictDoUpdate({
        target: profiles.id,
        set: {
          role: VENDOR_ADMIN_ROLE,
          vendorId: p.vendorId,
          seatOwner: true,
          updatedAt: p.now,
        },
      }),
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
 * closed CHECK whose widening is a full SQLite table rebuild besides.
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
