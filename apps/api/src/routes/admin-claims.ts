/**
 * Admin claim → vendor-account grant API (AECI-519 /
 * `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §3). The admin action behind
 * `requireAdmin()` that turns an approved vendor CLAIM into a live vendor account
 * on the Free plan:
 *
 *   PATCH /api/admin/claims/:id — approve (grant) / reject a claim.
 *
 * It also owns the claim-review READ surface and the operator note:
 *
 *   GET   /api/admin/claims           — the review queue (AECI-521 / §5).
 *   GET   /api/admin/claims/:id       — one claim (AECI-739).
 *   PATCH /api/admin/claims/:id/notes — write/clear the operator note (AECI-739).
 *   GET   /api/admin/claims/:id/audit — the claim's audit trail (AECI-1276).
 *
 * ── THE OPERATOR NOTE (AECI-739) ──────────────────────────────────────────────
 * One nullable column, admin-authored, NEVER claimant-facing and never emailed,
 * writable at any status, and audited into the same `db.batch` as its write, which
 * is what makes the audit trail the note's history rather than the column. It was
 * built for the parked connector claim. AECI-1367 retired parking (connector vendors
 * are approved like anyone else), and the note stays as the operator's record of
 * whatever was said out of band.
 *
 * A sibling of `PATCH /api/admin/requests/:id` (`admin-requests.ts`), not a
 * replacement: corrections still moderate through the requests endpoint; a claim
 * moderates here so `approve` runs the §3 grant batch (link the `vendor_admin`
 * seat, ensure the billing account, resolve the request — one atomic `db.batch`)
 * instead of a plain resolve. The batch mechanics live in `lib/vendor-grant.ts`;
 * the claimant email→auth-user resolution in `lib/claimant-identity.ts` (AECI-527);
 * this handler owns HTTP, the resolution→status mapping, the idempotency gate, and
 * the post-commit claim-decision email seam.
 *
 * ── EVERY APPROVAL LANDS ON FREE (AECI-1367, `VENDOR_SIGNUP_PROCESS.md` §3 step 2) ──
 * The operator no longer picks a plan. `approveClaim` composes three builders into
 * ONE `db.batch`, and none of them writes a license:
 *
 *  1. `grantSeatStatements` (`lib/vendor-grant.ts`): the seat upsert, the request
 *     resolve, the workflow and the `vendor_claim.granted` audit row. The seat is an
 *     owner seat only when the vendor has no unbanned owner yet, decided in SQL.
 *  2. `ensureBillingAccountStatements` (`lib/billing-account.ts`, AECI-1351): the
 *     vendor's billing account and its `billing_account.created` row, or nothing
 *     when the vendor already has one. A batch that loses the first-account race is
 *     re-planned once against the committed account (AECI-1380).
 *  3. `linkClaimAcceptanceStatements` (`lib/agreement-acceptances.ts`): fills the
 *     seat, vendor and billing account on the claim's terms acceptances, or nothing
 *     when the claim has none.
 *
 * Managed is bought later, as licenses on that billing account (E5, E9). No grant
 * writes a license or moves `vendors.verified`. `vendors.verified` stays a MIRROR
 * whose sole writer is `lib/license.ts` (AECI-1358).
 *
 * The `/admin/claims` LIST + reviewer UI is AECI-521. The claim-decision email
 * SENDER is AECI-528: the send-site is an injectable seam (cf. `noopSyncToLinear`
 * in `admin-requests.ts`) whose default here is a no-op, so this endpoint ships +
 * tests standalone; the real Resend templates (`lib/email.ts` `sendClaim*Email`)
 * are injected at the route registration in `index.ts`.
 *
 * Cache: approve purges nothing. It writes a seat, maybe a billing account and the
 * acceptance link, and no cacheable page renders any of them (the provision-seat
 * route in `admin-vendors.ts` purges nothing for the same reason).
 */

import {
  AdminClaimAuditQuerySchema,
  AdminClaimAuditResponseSchema,
  AdminClaimDetailSchema,
  ApiErrorCode,
  ListVendorClaimsQuerySchema,
  ListVendorClaimsResponseSchema,
  ModerateClaimResponseSchema,
  ModerateClaimSchema,
  SaveClaimNotesSchema,
  type AdminClaimDetail,
  type AdminClaimantSeat,
  type AdminVendorSeat,
  type ClaimDuplicateSibling,
  type ClaimGrantSummary,
  type LinkRef,
  type ListVendorClaimsResponse,
  type ModerateClaimResponse,
  type RelatedRequestRef,
  type VendorOwnedIntegrations,
  type VendorProductRoles,
} from '@aeci/shared';
import { licensePlanSnapshot, type EntitlementTier } from '@aeci/shared/entitlements';
import { and, asc, count, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb, type Db } from '../db/client';
import {
  auditLog,
  productVendors,
  profiles,
  vendorRequests,
  vendors,
  workflowInstances,
} from '../db/schema';
import { readAdminAuditPage, type FetchAuthEmails } from '../lib/admin-audit-page';
import { loadVendorLicenses, type LicenseBefore } from '../lib/license';
import { forwardAuditBatch } from '../lib/moderation-forward';
import { logToPosthog, submitCount } from '../posthog';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { type BatchStmt, type BatchTuple } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import {
  linkClaimAcceptanceStatements,
  loadClaimAcceptanceIds,
} from '../lib/agreement-acceptances';
import {
  BILLING_ACCOUNT_ATTEMPTS,
  ensureBillingAccountStatements,
  isBillingAccountRaceError,
  loadBillingAccount,
  type BillingAccountBefore,
} from '../lib/billing-account';
import { blankLast, textAsc } from '../lib/collation';
import { classifyClaimantConflict, resolveClaimantIdentity } from '../lib/claimant-identity';
import {
  loadVendorOwnedAt,
  stampOwnershipStatement,
  VENDOR_ADMIN_ROLE,
} from '../lib/claimed-vendors';
import { dispatchOwnershipSync } from '../lib/ownership-sync';
import {
  adminVendorRequestConfig,
  resolveRequestTargets,
  toAdminClaim,
  toAdminVendorRequest,
  type RawAdminVendorRequestRow,
} from '../lib/drizzle-helpers';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import {
  fetchAuthAccountsByEmail,
  fetchAuthUserEmailsResult,
  type AuthAccountRef,
  type AuthEmailLookup,
} from '../lib/supabase-admin';
import {
  EMPTY_PRODUCT_ROLES,
  foldProductRoleGroups,
  isPureConnectorVendor,
  productRolesForVendors,
  selectProductRoleGroups,
} from '../lib/vendor-product-roles';
import { EMPTY_OWNED_INTEGRATIONS, loadOwnedIntegrations } from '../lib/vendor-owned-integrations';
import {
  isSeatsChangedError,
  planSeatGrantReturn,
  seatsChangedError,
  vendorBannedFlagsRaceSentinel,
} from '../lib/vendor-handback';
import { scheduleStripeBanCancelClear, type StripeClientFor } from '../lib/stripe-licenses';
import { stripeClientFromEnv } from '../lib/stripe';
import {
  CLAIM_AUDIT_SOURCE,
  claimDecisionRaceError,
  grantSeatStatements,
  isClaimDecidedAbort,
  rejectClaimStatements,
  saveClaimNotesStatements,
} from '../lib/vendor-grant';

type ClaimContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/**
 * Claim-decision email seam (§9 / AECI-528). Fired post-commit after an
 * approve/reject so the claimant learns the outcome (and, on approve, how to sign
 * in — no GoTrue invite email is sent, see `createAuthUser`). The Resend template
 * internals are owned by AECI-528 (`lib/email.ts` `sendClaimDecisionEmail`); the
 * default here is a safe no-op so this endpoint ships standalone and tests can
 * inject a spy. Best-effort — a send failure is logged, never surfaced to the admin.
 *
 * `targetName` is the claimed target's display name (the vendor's `companyName`, or
 * the product's `name` for a product claim) — resolved via `resolveRequestTargets`.
 * `vendorName` (AECI-1367, set on approve) is the granted vendor's company name, which
 * the approval email names: the account belongs to the vendor even when the claim
 * named one of its products. `identityOutcome` is set only on approve (`invited` →
 * account just provisioned, so the copy says the account exists; `linked` → an
 * existing account).
 */
export type SendClaimDecisionEmail = (
  c: ClaimContext,
  input: {
    decision: 'approved' | 'rejected';
    to: string;
    requestId: string;
    vendorId: string;
    vendorSlug: string;
    targetName: string;
    vendorName?: string;
    identityOutcome?: 'linked' | 'invited';
  },
) => Promise<void>;

const noopSendClaimEmail: SendClaimDecisionEmail = async () => {};

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Every handler here forwards its audit rows and transitions (§26.5) through
// `forwardAuditBatch`: one request per write, tagged `source: admin-moderation`,
// never one `fetch` per row (AECI-666, AECI-1112).

async function parseJsonBody<T>(c: ClaimContext, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  return schema.parse(raw);
}

/** `aeci.claim.moderation.action` — one per moderation attempt, tagged by action
 *  and outcome. Fire-and-forget; each vendor leg no-ops without its own key.
 *
 *  `action:note` (AECI-739) rides the SAME series rather than opening a second
 *  family: it is the third thing an admin does to a claim from the same console,
 *  and the tag separates it. `outcome:noop` there means the submitted note was
 *  byte-identical to the stored one, so nothing was written. */
function emitClaimModeration(
  c: ClaimContext,
  action: 'approve' | 'reject' | 'note',
  outcome: 'ok' | 'noop' | 'invalid_state' | 'conflict' | 'unavailable',
): void {
  submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.claim.moderation.action', 1, [
    `action:${action}`,
    `outcome:${outcome}`,
  ]);
}

/** The preloaded grant target: the vendor a claim seats against, plus its
 *  licenses and its billing account. */
interface ClaimTarget {
  /** `companyName` names a billing account created by this grant (AECI-1351) and
   *  the vendor in the approval email (AECI-1367). */
  vendor: {
    id: string;
    slug: string;
    verified: boolean;
    companyName: string;
    ownedAt: string | null;
  };
  /** Every license the vendor holds, live and ended. Read, never written: the audit
   *  rows' plan snapshot (AECI-1355) and the response's `tier` (AECI-1358) read them. */
  vendorLicenses: LicenseBefore[];
  /** Preloaded so a vendor that already has an account gets no statement and no
   *  audit row from `ensureBillingAccountStatements` (AECI-1351). */
  billingAccount: BillingAccountBefore | null;
}

/**
 * The vendor a claim grants: for a `target_type='vendor'` claim, the target
 * itself; for a `target_type='product'` claim, the product's PRIMARY vendor (the
 * `is_primary` row wins; any row is the fallback). Resolving this before calling
 * `resolveClaimantIdentity` is mandatory — exclusivity compares against
 * `profiles.vendor_id`, which can only ever hold a vendor id (§2).
 *
 * Also preloads the vendor's licenses and its billing account in one wave, so no
 * caller re-derives either lookup.
 */
async function resolveTargetVendor(
  db: Db,
  existing: RawAdminVendorRequestRow,
): Promise<ClaimTarget> {
  let vendorId: string;
  if (existing.targetType === 'vendor') {
    vendorId = existing.targetId;
  } else {
    const pv = await db.query.productVendors.findFirst({
      columns: { vendorId: true },
      where: eq(productVendors.productId, existing.targetId),
      orderBy: [desc(productVendors.isPrimary)],
    });
    if (!pv) {
      throw new ApiError(
        422,
        ApiErrorCode.INVALID_STATE_TRANSITION,
        `Claimed product ${existing.targetId} has no vendor to grant.`,
      );
    }
    vendorId = pv.vendorId;
  }

  const vendor = await db.query.vendors.findFirst({
    columns: { id: true, slug: true, verified: true, companyName: true, ownedAt: true },
    where: eq(vendors.id, vendorId),
  });
  if (!vendor) throw notFoundError('vendor', { id: vendorId });
  const [billingAccount, vendorLicenses] = await Promise.all([
    loadBillingAccount(db, vendorId),
    loadVendorLicenses(db, vendorId),
  ]);
  return { vendor, billingAccount, vendorLicenses };
}

/** Find-or-derive the `vendor_claim` workflow instance id for a claim (find-or-create
 *  can't be conditional inside a batch, so the id is settled up front). */
async function findClaimWorkflow(
  db: Db,
  requestId: string,
): Promise<{ workflowId: string; existingWf: boolean }> {
  const wf = await db.query.workflowInstances.findFirst({
    columns: { id: true },
    where: and(
      eq(workflowInstances.workflowType, 'vendor_claim'),
      eq(workflowInstances.entityId, requestId),
    ),
  });
  return wf
    ? { workflowId: wf.id, existingWf: true }
    : { workflowId: crypto.randomUUID(), existingWf: false };
}

/** Build the response row from the preloaded claim + the values just committed. */
function claimResponse(
  existing: RawAdminVendorRequestRow,
  patch: Partial<RawAdminVendorRequestRow>,
  target: Parameters<typeof toAdminVendorRequest>[2],
  grant: ClaimGrantSummary | null,
): ModerateClaimResponse {
  return {
    request: toAdminVendorRequest({ ...existing, ...patch }, false, target),
    grant,
  };
}

// ─── Handler ─────────────────────────────────────────────────────────────────

/** `PATCH /api/admin/claims/:id` — approve (grant) / reject a vendor claim. */
export function createModerateClaimHandler(
  dbFor: DbFactory = getDb,
  resolveIdentity: typeof resolveClaimantIdentity = resolveClaimantIdentity,
  sendClaimDecisionEmail: SendClaimDecisionEmail = noopSendClaimEmail,
  stripeFor: StripeClientFor = (env) => stripeClientFromEnv(env),
): (c: ClaimContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const actorId = session.userId;
    const actorType = auditActorType(session);

    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing claim id', { field: 'id' });
    }

    const payload = await parseJsonBody(c, ModerateClaimSchema);
    const { db } = writeDb(c, dbFor);

    // Preload the full claim row — it gates the transition (status) and builds the
    // response (values we set are merged in after commit; no post-commit re-read).
    const existing = (await db.query.vendorRequests.findFirst({
      ...adminVendorRequestConfig,
      where: eq(vendorRequests.id, id),
    })) as RawAdminVendorRequestRow | undefined;
    if (!existing) throw notFoundError('vendor_request', { id });

    // This endpoint grants accounts — a correction has nothing to grant, so it must
    // moderate through /api/admin/requests/:id (which this leaves untouched).
    if (existing.kind !== 'claim') {
      throw new ApiError(
        422,
        ApiErrorCode.INVALID_STATE_TRANSITION,
        `Request ${id} is a ${existing.kind}, not a claim; moderate it via /api/admin/requests/:id.`,
      );
    }

    const reason = payload.reason?.trim() ? payload.reason.trim() : null;

    return payload.action === 'approve'
      ? approveClaim(c, db, resolveIdentity, sendClaimDecisionEmail, {
          existing,
          reason,
          actorId,
          actorType,
          stripeFor,
        })
      : rejectClaim(c, db, sendClaimDecisionEmail, { existing, reason, actorId, actorType });
  };
}

interface ApproveArgs {
  existing: RawAdminVendorRequestRow;
  reason: string | null;
  actorId: string;
  actorType: ReturnType<typeof auditActorType>;
  stripeFor: StripeClientFor;
}

async function approveClaim(
  c: ClaimContext,
  db: Db,
  resolveIdentity: typeof resolveClaimantIdentity,
  sendClaimDecisionEmail: SendClaimDecisionEmail,
  { existing, reason, actorId, actorType, stripeFor }: ApproveArgs,
): Promise<Response> {
  // A `rejected` claim was never granted, so it can never be a valid re-grant or an
  // idempotent no-op — refuse it up front, BEFORE `resolveIdentity`, whose provision
  // branch would otherwise orphan an auth user we'd immediately 422 on.
  if (existing.status === 'rejected') {
    emitClaimModeration(c, 'approve', 'invalid_state');
    throw new ApiError(
      422,
      ApiErrorCode.INVALID_STATE_TRANSITION,
      'Claim is rejected; only open or in-review claims can be granted.',
    );
  }

  const { vendor, billingAccount, vendorLicenses } = await resolveTargetVendor(db, existing);

  // A `resolved` claim is terminal too. Its only valid re-approve is the idempotent
  // same-seat no-op, which needs an EXISTING linked account to recognize — so resolve
  // it LOOKUP-ONLY (`provision: !terminal`). That way a resolved claim whose claimant
  // is gone (e.g. GDPR-deleted) returns `not_found` → 422 WITHOUT provisioning an
  // orphan `auth.users` row (§3).
  const terminal = existing.status === 'resolved';

  // Resolve the claimant's auth-user id (or provision one, unless terminal). Never
  // throws — every failure is an outcome the §2 contract maps to HTTP.
  const resolution = await resolveIdentity(db, c.env, {
    email: existing.submitterEmail,
    vendorId: vendor.id,
    provision: !terminal,
  });

  switch (resolution.outcome) {
    case 'conflict':
      // Exclusivity violation — an explicit error, nothing written (§2 / §8.3(3)).
      emitClaimModeration(c, 'approve', 'conflict');
      throw new ApiError(
        409,
        ApiErrorCode.GRANT_CONFLICT,
        resolution.reason === 'already_admin'
          ? 'Claimant account is a site admin and cannot be granted a vendor seat.'
          : 'Claimant account is already linked to a different vendor.',
        { details: { reason: resolution.reason } },
      );
    case 'unavailable':
    case 'error':
      // Resolution is impossible (Supabase admin creds absent) or upstream failed —
      // refuse rather than half-grant (§2).
      emitClaimModeration(c, 'approve', 'unavailable');
      throw new ApiError(
        503,
        ApiErrorCode.DEPENDENCY_FAILURE,
        'Claimant identity resolution is unavailable; the grant cannot proceed.',
      );
    case 'not_found':
      // Terminal (`resolved`) claim whose claimant auth user no longer exists (e.g.
      // GDPR-deleted): an invalid transition — and because we resolved lookup-only
      // (`provision: false`), no orphan auth user was created. Non-terminal claims
      // never reach this: they provision instead.
      emitClaimModeration(c, 'approve', 'invalid_state');
      throw new ApiError(
        422,
        ApiErrorCode.INVALID_STATE_TRANSITION,
        `Claim is ${existing.status}; only open or in-review claims can be granted.`,
      );
  }

  // `resolution` is now `linked | invited`.
  const { userId, email } = resolution;
  const identityOutcome = resolution.outcome;
  const profileBefore = resolution.outcome === 'linked' ? resolution.profile : null;
  const seatCreated = profileBefore === null;
  const alreadySeated =
    profileBefore?.role === VENDOR_ADMIN_ROLE && profileBefore.vendorId === vendor.id;

  // One pre-batch snapshot for every row this grant writes, from the vendor's
  // licenses (AECI-1355). No second read.
  const resolvedAt = new Date().toISOString();
  const vendorPlan = licensePlanSnapshot(vendorLicenses, resolvedAt);
  // The response's `tier` is the vendor's live state, read from the same licenses
  // (AECI-1358; the entitlement row before). The grant writes no license, so the
  // pre-batch state IS the post-batch state. Stored state only, the session's rule
  // (`sessionPlanFromLicenses`): Managed while any license has `ended_at` NULL.
  // Fails closed: no live license reports `unclaimed` (Free). The snapshot above
  // keeps its clock check, because it is a RECORD rule.
  const tier: EntitlementTier = vendorLicenses.some((l) => l.endedAt === null)
    ? 'verified'
    : 'unclaimed';

  // Terminal-gate + idempotency. A re-grant of a claim already resolved to this
  // exact seat is a no-op (no batch, no audit noise). A resolved claim whose seat
  // is gone is a genuine invalid transition.
  if (terminal) {
    if (existing.status === 'resolved' && alreadySeated) {
      emitClaimModeration(c, 'approve', 'noop');
      const targets = await resolveRequestTargets(db, [existing]);
      // No batch is built on this path (§6.5) — the summary is a pure readout of
      // the preloaded state.
      const body = claimResponse(existing, {}, targets.get(existing.targetId) ?? null, {
        user_id: userId,
        vendor_id: vendor.id,
        verified: vendor.verified,
        identity_outcome: identityOutcome,
        seat_created: false,
        tier,
      });
      validateResponseInDev(c.env, () => ModerateClaimResponseSchema.parse(body));
      return json(body);
    }
    emitClaimModeration(c, 'approve', 'invalid_state');
    throw new ApiError(
      422,
      ApiErrorCode.INVALID_STATE_TRANSITION,
      `Claim is ${existing.status}; only open or in-review claims can be granted.`,
    );
  }

  const [{ workflowId, existingWf }, acceptanceIds] = await Promise.all([
    findClaimWorkflow(db, existing.id),
    loadClaimAcceptanceIds(db, existing.id),
  ]);

  // Every statement of the grant, planned against one read of the vendor's billing
  // account and `owned_at`. Called again, with both re-read, when the batch loses the
  // first-account race (AECI-1380).
  const planGrant = async (
    billingAccountBefore: BillingAccountBefore | null,
    ownedAtBefore: string | null,
  ) => {
    // The billing account (AECI-1351, `VENDOR_SIGNUP_PROCESS.md` §3 step 2). A vendor
    // that already has one gets the frozen no-op: no statement, no audit row, and
    // nothing that names `vendors`, so a second seat leaves `vendors.updated_at` alone.
    const account = ensureBillingAccountStatements(db, {
      vendorId: vendor.id,
      name: vendor.companyName,
      createdBy: actorId,
      actorType,
      existing: billingAccountBefore,
      now: resolvedAt,
      vendorPlan,
      source: CLAIM_AUDIT_SOURCE,
      sourceRequestId: existing.id,
    });
    // Exactly one of the two is set: the account the vendor had, or the one this batch
    // creates. The acceptance link names it.
    const billingAccountId = billingAccountBefore?.id ?? account.billingAccountId;

    const grant = grantSeatStatements(db, {
      userId,
      vendorId: vendor.id,
      vendorPlan,
      requestId: existing.id,
      actorId,
      actorType,
      resolvedAt,
      fromStatus: existing.status,
      vendorWasVerified: vendor.verified,
      workflowId,
      existingWf,
      identityOutcome,
      seatCreated,
      profileBefore,
      submitterName: existing.submitterName,
      billingAccountCreated: account.billingAccountId !== null,
      ownershipStamped: ownedAtBefore === null,
      reason,
      targetType: existing.targetType,
      targetId: existing.targetId,
    });

    // The claim's terms acceptances (E3.3 writes them at claim time) now name the seat,
    // the vendor and the billing account (AECI-1367, `DATABASE_SCHEMA.md` §8.6d). No
    // acceptances → no statement and no audit row.
    const acceptances = billingAccountId
      ? linkClaimAcceptanceStatements(db, {
          vendorRequestId: existing.id,
          acceptanceIds,
          profileId: userId,
          vendorId: vendor.id,
          billingAccountId,
          actorId,
          actorType,
          vendorPlan,
          source: CLAIM_AUDIT_SOURCE,
        })
      : null;

    // AECI-989: a new active seat returns the contests a ban moved to AECi. The claim
    // writes no license, so the return reads the vendor's real licenses, the
    // same as the provision-seat route: a contest on a connector-powered row only
    // returns to an owner that already holds an active plan.
    const returned = await planSeatGrantReturn(
      db,
      {
        vendorId: vendor.id,
        actorId,
        actorType,
        now: resolvedAt,
        source: CLAIM_AUDIT_SOURCE,
        vendorPlan,
      },
      userId,
      { entitledAfterBatch: false },
    );

    const stmts: BatchStmt[] = [
      ...grant.stmts,
      // AECI-1415 (ADR 0042): approval flips ownership to the vendor, in this batch.
      // Guarded on `owned_at IS NULL`, so a second claimant changes nothing here.
      stampOwnershipStatement(db, vendor.id, resolvedAt),
      ...account.stmts,
      ...(acceptances?.stmts ?? []),
      ...(returned?.stmts ?? []),
      vendorBannedFlagsRaceSentinel(db, vendor.id, userId),
    ];
    return { account, grant, acceptances, returned, stmts };
  };

  // ONE batch. The seat, the request resolve, the workflow, the billing account, the
  // acceptance link and every audit row commit or roll back together (§26.1).
  //
  // AECI-1092 reconciliation: a return of a contest on a connector-powered row carries
  // `ownerEntitlementActiveSentinel`. An end of the vendor's last live license that
  // commits first aborts the batch: nothing is written and this handler answers
  // `409 VENDOR_SEATS_CHANGED`. The admin's retry then re-plans against that state.
  //
  // AECI-1374 (E4.5): a last-seat ban that committed after the flag read above left
  // `vendor-banned` flags the return did not plan to clear. `vendorBannedFlagsRaceSentinel`
  // goes LAST, after the seat write and the planned clears, and aborts the same way
  // when any such flag is left beside this unbanned seat.
  //
  // AECI-1380: another first seat on this vendor that committed after the account
  // read above created the account. This batch trips `billing_accounts_vendor_key` and
  // rolls back whole. It is re-planned once against the committed account, so the
  // claimant still lands, and nothing records a creation that did not happen. The
  // rival also stamped `owned_at`, so the re-plan re-reads it too.
  let planned: Awaited<ReturnType<typeof planGrant>>;
  let accountBefore = billingAccount;
  let ownedAtBefore = vendor.ownedAt;
  for (let attempt = 1; ; attempt += 1) {
    planned = await planGrant(accountBefore, ownedAtBefore);
    try {
      await db.batch(planned.stmts as BatchTuple);
      break;
    } catch (error) {
      if (attempt < BILLING_ACCOUNT_ATTEMPTS && isBillingAccountRaceError(error)) {
        [accountBefore, ownedAtBefore] = await Promise.all([
          loadBillingAccount(db, vendor.id),
          loadVendorOwnedAt(db, vendor.id),
        ]);
        continue;
      }
      // AECI-1333: the batch opens with `claimUndecidedSentinel`. Both it and the
      // seat-return sentinels raise "malformed JSON", so a re-read says which fired.
      if (isClaimDecidedAbort(error)) {
        const decided = await claimDecisionRaceError(db, existing.id);
        if (decided) {
          emitClaimModeration(c, 'approve', 'conflict');
          throw decided;
        }
      }
      if (isSeatsChangedError(error)) throw seatsChangedError();
      throw error;
    }
  }
  const { account, grant, acceptances, returned } = planned;
  emitClaimModeration(c, 'approve', 'ok');
  // AECI-1418: tell the review app the vendor owns its records. Post-commit, in
  // `waitUntil`. Every committed approval leaves the vendor owned (stamped here or
  // already), and the record is the whole state, so a re-send is harmless.
  dispatchOwnershipSync(c, vendor.id, 'claim_approved');
  // AECI-1503: the new seat cleared the `vendor-banned` flags, so the ban's Stripe
  // cancel comes off too. Post-commit, best-effort; the daily reconcile backs it up.
  if (returned?.vendorBannedFlagsCleared) {
    scheduleStripeBanCancelClear(c, db, stripeFor, { vendorId: vendor.id, now: resolvedAt });
  }

  // Resolve the claimed target's display name up front — reused by the email
  // (AECI-528) and the response body.
  const targets = await resolveRequestTargets(db, [existing]);
  const targetName = targets.get(existing.targetId)?.name ?? '';

  // Post-commit, best-effort (§3): send the claim-approved email (AECI-528 seam) and
  // forward audit + workflow to PostHog. No cache purge: nothing this batch wrote is
  // rendered by a cacheable page.
  c.executionCtx.waitUntil(
    sendClaimDecisionEmail(c, {
      decision: 'approved',
      to: email,
      requestId: existing.id,
      vendorId: vendor.id,
      vendorSlug: vendor.slug,
      targetName,
      vendorName: vendor.companyName,
      identityOutcome,
    }).catch((error) => {
      try {
        logToPosthog(c.executionCtx, c.env, c.req.raw, {
          level: 'warn',
          message: `claim-approved email failed for ${existing.id}`,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        console.warn('admin-claims: claim-approved email failed', error);
      }
    }),
  );
  // Every audit row and transition forwards (§26.5) in ONE batched request: the
  // seat return adds a row and a transition per contest, so one `fetch` per row
  // would run past the connection limit. The billing-account and acceptance entries
  // are null on their no-op paths, and the batch skips them.
  forwardAuditBatch(
    c,
    [
      grant.auditEntry,
      account.auditEntry,
      acceptances?.auditEntry ?? null,
      ...(returned?.audits ?? []),
    ],
    [grant.workflowEntry, ...(returned?.transitions ?? [])],
  );

  const body = claimResponse(
    existing,
    { status: 'resolved', resolvedById: actorId, resolvedAt },
    targets.get(existing.targetId) ?? null,
    {
      user_id: userId,
      vendor_id: vendor.id,
      // No grant moves the mirror (AECI-1367), so this is what the vendor had.
      verified: vendor.verified,
      identity_outcome: identityOutcome,
      seat_created: seatCreated,
      tier,
    },
  );
  validateResponseInDev(c.env, () => ModerateClaimResponseSchema.parse(body));
  return json(body);
}

interface RejectArgs {
  existing: RawAdminVendorRequestRow;
  reason: string | null;
  actorId: string;
  actorType: ReturnType<typeof auditActorType>;
}

async function rejectClaim(
  c: ClaimContext,
  db: Db,
  sendClaimDecisionEmail: SendClaimDecisionEmail,
  { existing, reason, actorId, actorType }: RejectArgs,
): Promise<Response> {
  // Reject needs no identity resolution and no vendor mutation — a rejected claim
  // provisions nothing, so this works even when Supabase admin creds are absent.
  if (existing.status === 'resolved' || existing.status === 'rejected') {
    emitClaimModeration(c, 'reject', 'invalid_state');
    throw new ApiError(
      422,
      ApiErrorCode.INVALID_STATE_TRANSITION,
      `Claim is ${existing.status}; only open or in-review claims can be rejected.`,
    );
  }

  const resolvedAt = new Date().toISOString();
  const { workflowId, existingWf } = await findClaimWorkflow(db, existing.id);

  const { stmts, auditEntry, workflowEntry } = rejectClaimStatements(db, {
    requestId: existing.id,
    actorId,
    actorType,
    resolvedAt,
    fromStatus: existing.status,
    workflowId,
    existingWf,
    reason,
    targetType: existing.targetType,
    targetId: existing.targetId,
  });

  try {
    await db.batch(stmts as BatchTuple);
  } catch (error) {
    // AECI-1333: another decision committed after the read above. The sentinel
    // rolled the whole batch back, so nothing was written and no email goes out.
    const decided = isClaimDecidedAbort(error)
      ? await claimDecisionRaceError(db, existing.id)
      : null;
    if (decided) {
      emitClaimModeration(c, 'reject', 'conflict');
      throw decided;
    }
    throw error;
  }
  emitClaimModeration(c, 'reject', 'ok');

  // Resolve the claimed target's display name up front — reused by the email
  // (AECI-528) and the response body.
  const targets = await resolveRequestTargets(db, [existing]);
  const targetName = targets.get(existing.targetId)?.name ?? '';

  c.executionCtx.waitUntil(
    sendClaimDecisionEmail(c, {
      decision: 'rejected',
      to: existing.submitterEmail,
      requestId: existing.id,
      vendorId: existing.targetType === 'vendor' ? existing.targetId : '',
      vendorSlug: '',
      targetName,
    }).catch((error) => {
      try {
        logToPosthog(c.executionCtx, c.env, c.req.raw, {
          level: 'warn',
          message: `claim-rejected email failed for ${existing.id}`,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        console.warn('admin-claims: claim-rejected email failed', error);
      }
    }),
  );
  // The audit row and the transition go in ONE request (AECI-1112).
  forwardAuditBatch(c, [auditEntry], [workflowEntry]);

  const body = claimResponse(
    existing,
    { status: 'rejected', resolvedById: actorId, resolvedAt },
    targets.get(existing.targetId) ?? null,
    null,
  );
  validateResponseInDev(c.env, () => ModerateClaimResponseSchema.parse(body));
  return json(body);
}

// ─── Claim-review LIST (AECI-521 / §5) ───────────────────────────────────────

/** Composite key for the duplicate-flag lookup maps (mirrors `admin-requests.ts`).
 *  ` ` can never appear in an email local-part or a UUID, so the parts can't run
 *  together. */
const DUP_SEP = ' ';
function dupKey(head: string, targetType: string, targetId: string): string {
  return `${head}${DUP_SEP}${targetType}${DUP_SEP}${targetId}`;
}

/**
 * The page's rows plus one `(product, context_product_id)` pseudo-target per claim
 * that came from a product page (AECI-1364), so `resolveRequestTargets` hydrates the
 * "Came from" product in the same batched scan as the targets. Product and vendor
 * ids are both UUIDs, so the one map it returns cannot collide.
 */
function withContextProducts(
  rows: RawAdminVendorRequestRow[],
): Array<{ targetType: string; targetId: string }> {
  const extra = rows.flatMap((r) =>
    r.contextProductId ? [{ targetType: 'product', targetId: r.contextProductId }] : [],
  );
  return [...rows, ...extra];
}

/** The hydrated "Came from" product for one claim, or `null` (AECI-1364). */
function contextProductFor(
  row: RawAdminVendorRequestRow,
  targets: ReadonlyMap<string, LinkRef>,
): LinkRef | null {
  return row.contextProductId ? (targets.get(row.contextProductId) ?? null) : null;
}

/**
 * Each claim's TARGET VENDOR id, keyed by REQUEST id — the page-wide batched form of
 * `resolveTargetVendor`: a `vendor` claim resolves to its target, a `product` claim to
 * that product's PRIMARY vendor. One `IN (...)` scan, no per-row N+1. A claim whose
 * product has no `product_vendors` row is simply absent from the map (there is no
 * vendor to seat and none to entitle).
 *
 * Hoisted out of `loadExistingSeats` by AECI-532: the vendor link needs the
 * same resolution, and two copies of "which vendor does this claim mean" is exactly how
 * a queue ends up showing one vendor's seats beside another vendor's badge.
 */
async function resolveClaimVendorIds(
  db: Db,
  rows: RawAdminVendorRequestRow[],
): Promise<Map<string, string>> {
  const productTargetIds = [
    ...new Set(rows.filter((r) => r.targetType === 'product').map((r) => r.targetId)),
  ];
  const productVendorId = new Map<string, string>();
  if (productTargetIds.length > 0) {
    const pvRows = await db
      .select({
        productId: productVendors.productId,
        vendorId: productVendors.vendorId,
        isPrimary: productVendors.isPrimary,
      })
      .from(productVendors)
      .where(inArray(productVendors.productId, productTargetIds))
      .orderBy(desc(productVendors.isPrimary));
    // `desc(is_primary)` lists the primary row first; first write wins.
    for (const pv of pvRows) {
      if (!productVendorId.has(pv.productId)) productVendorId.set(pv.productId, pv.vendorId);
    }
  }

  const vendorByRow = new Map<string, string>();
  for (const row of rows) {
    const vendorId = row.targetType === 'vendor' ? row.targetId : productVendorId.get(row.targetId);
    if (vendorId) vendorByRow.set(row.id, vendorId);
  }
  return vendorByRow;
}

/** One claimant's `profiles` row, with the vendor its seat is on (AECI-1420). */
interface ClaimantSeatProfile {
  role: string;
  vendorId: string | null;
  vendorSlug: string | null;
  vendorName: string | null;
}

/**
 * The claimants' `profiles` rows, keyed by auth user id, for the `claimant_seat`
 * signal (AECI-1420). ONE statement for the page: the ids the GoTrue lookup
 * returned, left-joined to `vendors` for the seat's name and slug. An account
 * with no row here has never signed in, so it holds no seat.
 *
 * `profiles` has no email column, so this read can only follow the GoTrue
 * fan-out. The page caps at 100 claims, so the id list stays inside D1's bound
 * parameter limit.
 */
async function loadClaimantSeatProfiles(
  db: Db,
  accounts: ReadonlyMap<string, AuthAccountRef | null>,
): Promise<Map<string, ClaimantSeatProfile>> {
  const ids = [
    ...new Set([...accounts.values()].flatMap((account) => (account ? [account.userId] : []))),
  ];
  const byUser = new Map<string, ClaimantSeatProfile>();
  if (ids.length === 0) return byUser;

  const rows = await db
    .select({
      id: profiles.id,
      role: profiles.role,
      vendorId: profiles.vendorId,
      vendorSlug: vendors.slug,
      vendorName: vendors.companyName,
    })
    .from(profiles)
    .leftJoin(vendors, eq(vendors.id, profiles.vendorId))
    .where(inArray(profiles.id, ids));

  for (const row of rows) {
    byUser.set(row.id, {
      role: row.role,
      vendorId: row.vendorId,
      vendorSlug: row.vendorSlug,
      vendorName: row.vendorName,
    });
  }
  return byUser;
}

/**
 * Classify one claim's `claimant_seat` (AECI-1420) with the same pure rule the
 * grant runs, `classifyClaimantConflict`, against the claim's RESOLVED vendor (a
 * product claim's primary vendor, as `resolveTargetVendor` does).
 *
 * `null` (unknown) when the address has no account or its lookup failed, when the
 * profile read degraded, or when there is no resolved vendor to compare with. An
 * account with no `profiles` row has never signed in, so it is `none`.
 */
function classifyClaimantSeat(
  email: string,
  vendorId: string | undefined,
  accounts: ReadonlyMap<string, AuthAccountRef | null>,
  profilesByUser: ReadonlyMap<string, ClaimantSeatProfile> | null,
): AdminClaimantSeat | null {
  const account = accounts.get(email);
  if (!account || !profilesByUser || !vendorId) return null;
  const profile = profilesByUser.get(account.userId) ?? null;
  const conflict = classifyClaimantConflict(profile, vendorId);
  if (conflict === 'already_admin') return { kind: 'admin' };
  if (conflict === 'other_vendor' && profile?.vendorId) {
    // `profiles.vendor_id` is a foreign key, so the join always finds the vendor.
    // The id stands in for a missing name rather than dropping the flag.
    return {
      kind: 'other_vendor',
      vendor: {
        id: profile.vendorId,
        slug: profile.vendorSlug ?? profile.vendorId,
        name: profile.vendorName ?? profile.vendorId,
      },
    };
  }
  return { kind: 'none' };
}

/**
 * The claimed vendors' `LinkRef`s, keyed by VENDOR id: the `entitlement_vendor` the
 * queue's "Manage billing" and audit-trail links address. ONE scan over the page's
 * vendor ids. AECI-1375 dropped the old entitlement join and the readout it fed.
 */
async function loadClaimVendors(db: Db, vendorIds: string[]): Promise<Map<string, LinkRef>> {
  const byVendor = new Map<string, LinkRef>();
  if (vendorIds.length === 0) return byVendor;

  const rows = await db
    .select({ id: vendors.id, name: vendors.companyName, slug: vendors.slug })
    .from(vendors)
    .where(inArray(vendors.id, vendorIds));

  for (const row of rows) byVendor.set(row.id, { id: row.id, name: row.name, slug: row.slug });
  return byVendor;
}

/**
 * The claimed vendors' product-role breakdowns, keyed by VENDOR id — the §5.2
 * payer test as a queue signal (AECI-738). ONE grouped scan over the page's
 * vendor ids, no per-row N+1, shaped and folded by `lib/vendor-product-roles.ts`
 * so `/admin/vendors/:id` cannot compute it differently.
 *
 * Scoped to the SAME resolved vendor as `entitlement_vendor`: the question
 * "may this claim be granted" and the question "which vendor would the grant
 * touch" have to be answered about one vendor, or the card shows one vendor's
 * roles beside another vendor's badge.
 */
async function loadVendorProductRoles(
  db: Db,
  vendorIds: string[],
): Promise<Map<string, VendorProductRoles>> {
  if (vendorIds.length === 0) return new Map();
  return foldProductRoleGroups(
    await selectProductRoleGroups(db, productRolesForVendors(vendorIds)),
  );
}

/** Injected seat-email seam (AECI-1277), in the availability-reporting form —
 *  the same seam and the same reason as the vendor roster's (`admin-vendors.ts`). */
export type FetchSeatEmails = (env: Env, ids: readonly string[]) => Promise<AuthEmailLookup>;

/** A seat before its email is attached: the `profiles` id is what the GoTrue
 *  lookup keys on, and it never reaches the wire. */
type SeatWithoutEmail = Omit<AdminVendorSeat, 'email'> & { userId: string };

/**
 * The claimed vendor's active seats, keyed by REQUEST id (§5 "existing seats"). ONE
 * grouped `profiles` scan over the page's vendor ids (`role='vendor_admin' AND
 * banned_at IS NULL`) — no per-row N+1. A claim whose product has no vendor is absent
 * from `vendorByRow` and maps to `[]` (there is no vendor to seat). Ordered A to Z by
 * display name, unnamed seats last, then id (AECI-1243). Emails are attached
 * afterwards by `attachSeatEmails`.
 */
async function loadExistingSeats(
  db: Db,
  vendorByRow: Map<string, string>,
): Promise<Map<string, SeatWithoutEmail[]>> {
  const vendorIds = [...new Set(vendorByRow.values())];
  const seatsByVendor = new Map<string, SeatWithoutEmail[]>();
  if (vendorIds.length > 0) {
    const seatRows = await db
      .select({
        id: profiles.id,
        vendorId: profiles.vendorId,
        displayName: profiles.displayName,
        workEmailVerified: profiles.workEmailVerified,
        createdAt: profiles.createdAt,
      })
      .from(profiles)
      .where(
        and(
          eq(profiles.role, VENDOR_ADMIN_ROLE),
          isNull(profiles.bannedAt),
          inArray(profiles.vendorId, vendorIds),
        ),
      )
      // A to Z by display name, unnamed seats last, then id (AECI-1243).
      .orderBy(blankLast(profiles.displayName), textAsc(profiles.displayName), asc(profiles.id));
    for (const s of seatRows) {
      if (!s.vendorId) continue;
      const list = seatsByVendor.get(s.vendorId) ?? [];
      list.push({
        userId: s.id,
        display_name: s.displayName,
        work_email_verified: s.workEmailVerified,
        created_at: s.createdAt,
      });
      seatsByVendor.set(s.vendorId, list);
    }
  }

  const byRow = new Map<string, SeatWithoutEmail[]>();
  for (const [rowId, vendorId] of vendorByRow) {
    byRow.set(rowId, seatsByVendor.get(vendorId) ?? []);
  }
  return byRow;
}

/**
 * Attach each seat's sign-in email (AECI-1277): ONE bounded GoTrue fan-out over the
 * page's distinct seat ids, never one per claim. The caller runs it AFTER its
 * `Promise.all`, so it never shares the Worker's connection budget with the
 * `has_auth_account` fan-out (ADR 0021, 2026-08-27 amendment).
 *
 * `available` mirrors `AdminVendorDetail.seat_emails_available`: `false` means the
 * seam could not answer and every `email` is `null` for that reason. With no seats
 * to look up there is nothing to fail, so it is `true` and GoTrue is not called.
 */
async function attachSeatEmails(
  env: Env,
  seatsByRow: Map<string, SeatWithoutEmail[]> | null,
  fetchEmails: FetchSeatEmails,
): Promise<{ seatsByRow: Map<string, AdminVendorSeat[]> | null; available: boolean }> {
  if (!seatsByRow) return { seatsByRow: null, available: true };
  const ids = [...new Set([...seatsByRow.values()].flat().map((s) => s.userId))];
  const lookup: AuthEmailLookup =
    ids.length > 0
      ? await fetchEmails(env, ids)
      : { available: true, emails: new Map(), reason: 'ok' };
  const out = new Map<string, AdminVendorSeat[]>();
  for (const [rowId, seats] of seatsByRow) {
    out.set(
      rowId,
      seats.map(({ userId, ...seat }) => ({ ...seat, email: lookup.emails.get(userId) ?? null })),
    );
  }
  return { seatsByRow: out, available: lookup.available };
}

/**
 * Prior/sibling requests from each claim's `submitter_email`, keyed by REQUEST id
 * and EXCLUDING the claim itself (§5 "duplicate/prior-request context"). One
 * `IN (...)` scan over the page's claim emails — any kind/status, newest first.
 */
async function loadRelatedRequests(
  db: Db,
  rows: RawAdminVendorRequestRow[],
  claimEmails: string[],
): Promise<Map<string, RelatedRequestRef[]>> {
  const byRow = new Map<string, RelatedRequestRef[]>();
  if (claimEmails.length === 0) return byRow;

  const related = await db
    .select({
      id: vendorRequests.id,
      kind: vendorRequests.kind,
      status: vendorRequests.status,
      targetType: vendorRequests.targetType,
      submitterEmail: vendorRequests.submitterEmail,
      createdAt: vendorRequests.createdAt,
    })
    .from(vendorRequests)
    .where(inArray(vendorRequests.submitterEmail, [...new Set(claimEmails)]))
    .orderBy(desc(vendorRequests.createdAt), desc(vendorRequests.id));

  const byEmail = new Map<string, RelatedRequestRef[]>();
  for (const r of related) {
    const list = byEmail.get(r.submitterEmail) ?? [];
    list.push({
      id: r.id,
      kind: r.kind as RelatedRequestRef['kind'],
      status: r.status as RelatedRequestRef['status'],
      target_type: r.targetType as RelatedRequestRef['target_type'],
      created_at: r.createdAt,
    });
    byEmail.set(r.submitterEmail, list);
  }

  for (const row of rows) {
    const all = byEmail.get(row.submitterEmail) ?? [];
    byRow.set(
      row.id,
      all.filter((r) => r.id !== row.id),
    );
  }
  return byRow;
}

/**
 * `GET /api/admin/claims` — the claim-review queue (AECI-521 / §5). Clones the
 * requests LIST envelope + the `is_duplicate` / `has_auth_account` machinery,
 * filtered to `kind='claim'`, and layers the §5 reviewer signals (existing seats,
 * prior requests) onto each row. Read-only — no audit, no cache tag.
 *
 * The two enrichment queries are FAIL-SOFT: a thrown seats/related query degrades
 * that signal to `null` (the UI renders "unavailable") while the rest of the row
 * still returns, so a signal failure never blocks the review (AC). The
 * `has_auth_account` seam already degrades to `null` on absent creds / lookup error.
 */
export function createAdminClaimsListHandler(
  dbFor: DbFactory = getDb,
  /** Reviewer signal seam (#4a batched, AECI-527). Default hits the GoTrue Admin
   *  API; degrades to an empty map → `has_auth_account: null`. */
  fetchAuthAccounts: typeof fetchAuthAccountsByEmail = fetchAuthAccountsByEmail,
  /** Seat-email seam (AECI-1277). Default hits the GoTrue Admin API by id. */
  fetchEmails: FetchSeatEmails = fetchAuthUserEmailsResult,
): (c: ClaimContext) => Promise<Response> {
  return async (c) => {
    const query = ListVendorClaimsQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const { db } = dbFor(c.env);
    const where = and(eq(vendorRequests.kind, 'claim'), eq(vendorRequests.status, query.status));
    // `is_duplicate` groupBy is scoped to OPEN CLAIMS (an open claim sibling is the
    // signal a reviewer wants), reusing the requests handler's thresholds.
    const openClaims = and(eq(vendorRequests.kind, 'claim'), eq(vendorRequests.status, 'open'));

    const [rows, countRows, targetGroups, emailGroups] = await Promise.all([
      db.query.vendorRequests.findMany({
        ...adminVendorRequestConfig,
        where,
        orderBy: [desc(vendorRequests.createdAt), asc(vendorRequests.id)],
        limit: query.perPage,
        offset: (query.page - 1) * query.perPage,
      }),
      db.select({ value: count() }).from(vendorRequests).where(where),
      db
        .select({
          targetType: vendorRequests.targetType,
          targetId: vendorRequests.targetId,
          n: count(),
        })
        .from(vendorRequests)
        .where(openClaims)
        .groupBy(vendorRequests.targetType, vendorRequests.targetId),
      db
        .select({
          submitterEmail: vendorRequests.submitterEmail,
          targetType: vendorRequests.targetType,
          targetId: vendorRequests.targetId,
          n: count(),
        })
        .from(vendorRequests)
        .where(openClaims)
        .groupBy(vendorRequests.submitterEmail, vendorRequests.targetType, vendorRequests.targetId),
    ]);

    const targetCounts = new Map<string, number>();
    for (const g of targetGroups) targetCounts.set(dupKey('claim', g.targetType, g.targetId), g.n);
    const emailCounts = new Map<string, number>();
    for (const g of emailGroups) {
      emailCounts.set(dupKey(g.submitterEmail, g.targetType, g.targetId), g.n);
    }
    // A claim is a likely duplicate if an OPEN claim sibling shares its target or
    // its `(submitter_email, target)`; subtract the row itself when it's open.
    const isDuplicate = (row: RawAdminVendorRequestRow): boolean => {
      const self = row.status === 'open' ? 1 : 0;
      const tc = targetCounts.get(dupKey('claim', row.targetType, row.targetId)) ?? 0;
      const ec = emailCounts.get(dupKey(row.submitterEmail, row.targetType, row.targetId)) ?? 0;
      return tc - self >= 1 || ec - self >= 1;
    };

    // Every row is a claim, so every submitter feeds the auth + related lookups.
    const claimEmails = rows.map((r) => r.submitterEmail);
    // Resolved ONCE and shared by the seats + vendor-link enrichments (AECI-532): both
    // answer "which vendor does this claim mean", and two copies of that resolution is
    // how a queue shows one vendor's seats beside another vendor's badge. Fail-soft
    // like the signals it feeds — a rejected resolution degrades BOTH to `null`.
    const vendorByRow = await resolveClaimVendorIds(db, rows).catch(() => null);
    // FAIL-SOFT enrichment: a rejected seats/related/vendor query becomes a `null`
    // signal (UI: "unavailable"), never a failed response.
    const [
      targets,
      authAccountByEmail,
      seatsWithoutEmail,
      relatedByRow,
      linkByVendor,
      productRolesByVendor,
      ownedIntegrationsByVendor,
    ] = await Promise.all([
      // AECI-1364: the context products ride the same batched lookup as the targets.
      resolveRequestTargets(db, withContextProducts(rows)),
      fetchAuthAccounts(c.env, claimEmails),
      vendorByRow ? loadExistingSeats(db, vendorByRow).catch(() => null) : null,
      loadRelatedRequests(db, rows, claimEmails).catch(() => null),
      vendorByRow
        ? loadClaimVendors(db, [...new Set(vendorByRow.values())]).catch(() => null)
        : null,
      vendorByRow
        ? loadVendorProductRoles(db, [...new Set(vendorByRow.values())]).catch(() => null)
        : null,
      // The owner half of the payer test (AECI-1041 / §5.2 step 1a), over both
      // delivered-tier tables. Fail-soft like the role signal.
      vendorByRow
        ? loadOwnedIntegrations(db, [...new Set(vendorByRow.values())]).catch(() => null)
        : null,
    ]);
    // After the `Promise.all`, so the two GoTrue fan-outs never run at once. The
    // claimant profile read (AECI-1420) needs the ids the first fan-out returned,
    // so it runs here too. Fail-soft: a failed read makes every `claimant_seat`
    // null.
    const [{ seatsByRow, available: seatEmailsAvailable }, claimantProfiles] = await Promise.all([
      attachSeatEmails(c.env, seatsWithoutEmail, fetchEmails),
      loadClaimantSeatProfiles(db, authAccountByEmail).catch(() => null),
    ]);

    /** The claim's resolved vendor, or `null` when there is no vendor to act on (a
     *  product with no `product_vendors` row) or the enrichment degraded, so the UI
     *  never offers a link it cannot address. */
    const vendorFor = (row: RawAdminVendorRequestRow): LinkRef | null => {
      const vendorId = vendorByRow?.get(row.id);
      return (vendorId ? linkByVendor?.get(vendorId) : undefined) ?? null;
    };

    /** The §5.2 payer test for this claim's resolved vendor (AECI-738).
     *
     *  `[null, null]` ONLY when we could not look — the vendor resolution or the
     *  role query degraded. A resolved vendor that simply owns nothing gets a
     *  ZEROED breakdown and `false`, because "no products on record" is a real
     *  answer the operator must see and act on (it is unknown, NOT exempt), and
     *  collapsing it into "unavailable" would hide it. */
    const productRolesFor = (
      row: RawAdminVendorRequestRow,
    ): [VendorProductRoles | null, boolean | null] => {
      const vendorId = vendorByRow?.get(row.id);
      if (!vendorId || !productRolesByVendor) return [null, null];
      const roles = productRolesByVendor.get(vendorId) ?? { ...EMPTY_PRODUCT_ROLES };
      return [roles, isPureConnectorVendor(roles)];
    };

    /** The owner test for the same resolved vendor. Same null convention as
     *  `productRolesFor`: zeroed when it owns nothing, `null` only when we could
     *  not look. */
    const ownedIntegrationsFor = (
      row: RawAdminVendorRequestRow,
    ): VendorOwnedIntegrations | null => {
      const vendorId = vendorByRow?.get(row.id);
      if (!vendorId || !ownedIntegrationsByVendor) return null;
      return ownedIntegrationsByVendor.get(vendorId) ?? { ...EMPTY_OWNED_INTEGRATIONS };
    };

    const body: ListVendorClaimsResponse = {
      data: rows.map((row) =>
        toAdminClaim(
          row,
          isDuplicate(row),
          targets.get(row.targetId) ?? null,
          authAccountByEmail,
          seatsByRow ? (seatsByRow.get(row.id) ?? []) : null,
          seatEmailsAvailable,
          relatedByRow ? (relatedByRow.get(row.id) ?? []) : null,
          vendorFor(row),
          ...productRolesFor(row),
          ownedIntegrationsFor(row),
          contextProductFor(row, targets),
          classifyClaimantSeat(
            row.submitterEmail,
            vendorByRow?.get(row.id),
            authAccountByEmail,
            claimantProfiles,
          ),
        ),
      ),
      page: query.page,
      perPage: query.perPage,
      total: countRows[0]?.value ?? 0,
    };

    validateResponseInDev(c.env, () => {
      ListVendorClaimsResponseSchema.parse(body);
    });

    return json(body);
  };
}

// ─── Claim DETAIL + operator note (AECI-739 / §5.2 step 6) ───────────────────

/**
 * Preload one claim by id, for both new handlers.
 *
 * `404` on an unknown id. A `kind='correction'` row gets the **same 422 and the
 * same redirect message** `createModerateClaimHandler` already returns for it —
 * deliberately, so the id and the path tell one story regardless of the verb. A
 * 404 here would say "no such thing" about a row the PATCH sibling is willing to
 * describe and redirect.
 */
async function loadClaimRow(db: Db, id: string): Promise<RawAdminVendorRequestRow> {
  const row = (await db.query.vendorRequests.findFirst({
    ...adminVendorRequestConfig,
    where: eq(vendorRequests.id, id),
  })) as RawAdminVendorRequestRow | undefined;
  if (!row) throw notFoundError('vendor_request', { id });
  if (row.kind !== 'claim') {
    throw new ApiError(
      422,
      ApiErrorCode.INVALID_STATE_TRANSITION,
      `Request ${id} is a ${row.kind}, not a claim; view it via /api/admin/requests.`,
    );
  }
  return row;
}

/**
 * The open claims that make this one read as a duplicate (AECI-739 / §5.2 step 5).
 *
 * ONE scan, expressing the LIST's rule directly rather than re-deriving it: the
 * queue computes `is_duplicate` from two `groupBy` counts over OPEN claims — same
 * `(target_type, target_id)`, or same `(submitter_email, target_type, target_id)` —
 * and subtracts the row itself. Selecting those very siblings and excluding self by
 * id is the same predicate without the arithmetic, so the detail page's
 * `is_duplicate` (`siblings.length > 0`) cannot disagree with the queue's.
 *
 * The email rule is a strict subset of the target rule for claims (both are scoped
 * to the same target), so a row matching both reports the broader `target` reason;
 * `submitter` is reported only when the target predicate did not already cover it —
 * which, given the scoping, means never in practice. It is computed rather than
 * hardcoded so the label stays correct if either rule is ever widened.
 *
 * `has_notes` is what makes the section actionable: it separates a claim someone
 * DELIBERATELY parked (§5.2 says park an `open` pure-connector claim and route it
 * out of band) from one nobody has looked at.
 */
async function loadDuplicateSiblings(
  db: Db,
  row: RawAdminVendorRequestRow,
): Promise<ClaimDuplicateSibling[]> {
  const siblings = await db
    .select({
      id: vendorRequests.id,
      submitterEmail: vendorRequests.submitterEmail,
      submitterName: vendorRequests.submitterName,
      status: vendorRequests.status,
      createdAt: vendorRequests.createdAt,
      targetType: vendorRequests.targetType,
      targetId: vendorRequests.targetId,
      adminNotes: vendorRequests.adminNotes,
    })
    .from(vendorRequests)
    .where(
      and(
        eq(vendorRequests.kind, 'claim'),
        eq(vendorRequests.status, 'open'),
        ne(vendorRequests.id, row.id),
        or(
          and(
            eq(vendorRequests.targetType, row.targetType),
            eq(vendorRequests.targetId, row.targetId),
          ),
          and(
            eq(vendorRequests.submitterEmail, row.submitterEmail),
            eq(vendorRequests.targetType, row.targetType),
            eq(vendorRequests.targetId, row.targetId),
          ),
        ),
      ),
    )
    .orderBy(desc(vendorRequests.createdAt), asc(vendorRequests.id));

  return siblings.map((s) => ({
    id: s.id,
    submitter_email: s.submitterEmail,
    submitter_name: s.submitterName,
    status: s.status as ClaimDuplicateSibling['status'],
    created_at: s.createdAt,
    match_reason:
      s.targetType === row.targetType && s.targetId === row.targetId
        ? ('target' as const)
        : ('submitter' as const),
    has_notes: Boolean(s.adminNotes?.trim()),
  }));
}

/**
 * Build the `AdminClaimDetail` body for one claim: every signal the queue card
 * carries, computed through the SAME helpers the LIST uses (passed a one-row
 * array), plus the duplicate explanation.
 *
 * The enrichment stays fail-soft here exactly as it is on the list — `null` means
 * "we could not look", not "empty" — so a degraded signal never 500s a page the
 * operator opened to make a decision. `duplicate_siblings` is the exception and is
 * NOT caught: it is the arithmetic behind `is_duplicate`, and a detail page that
 * silently claimed "no duplicates" because a query failed would be worse than an
 * error.
 */
async function buildClaimDetail(
  c: ClaimContext,
  db: Db,
  row: RawAdminVendorRequestRow,
  fetchAuthAccounts: typeof fetchAuthAccountsByEmail,
  fetchEmails: FetchSeatEmails,
): Promise<AdminClaimDetail> {
  const rows = [row];
  const vendorByRow = await resolveClaimVendorIds(db, rows).catch(() => null);
  const vendorIds = vendorByRow ? [...new Set(vendorByRow.values())] : [];

  const [
    targets,
    authAccountByEmail,
    seatsWithoutEmail,
    relatedByRow,
    linkByVendor,
    productRolesByVendor,
    ownedIntegrationsByVendor,
    duplicateSiblings,
  ] = await Promise.all([
    resolveRequestTargets(db, withContextProducts(rows)),
    fetchAuthAccounts(c.env, [row.submitterEmail]),
    vendorByRow ? loadExistingSeats(db, vendorByRow).catch(() => null) : null,
    loadRelatedRequests(db, rows, [row.submitterEmail]).catch(() => null),
    vendorByRow ? loadClaimVendors(db, vendorIds).catch(() => null) : null,
    vendorByRow ? loadVendorProductRoles(db, vendorIds).catch(() => null) : null,
    vendorByRow ? loadOwnedIntegrations(db, vendorIds).catch(() => null) : null,
    loadDuplicateSiblings(db, row),
  ]);
  // After the `Promise.all`, as on the LIST: one GoTrue fan-out at a time. The
  // claimant profile read (AECI-1420) follows the lookup it depends on.
  const [{ seatsByRow, available: seatEmailsAvailable }, claimantProfiles] = await Promise.all([
    attachSeatEmails(c.env, seatsWithoutEmail, fetchEmails),
    loadClaimantSeatProfiles(db, authAccountByEmail).catch(() => null),
  ]);

  const vendorId = vendorByRow?.get(row.id);
  const vendorLink = (vendorId ? linkByVendor?.get(vendorId) : undefined) ?? null;
  // Same asymmetry the LIST documents: `[null, null]` ONLY when we could not look.
  // A resolved vendor owning nothing is a ZEROED breakdown + `false` — unknown is
  // not exempt (§5.2 step 1 / AECI-738).
  const roles =
    vendorId && productRolesByVendor
      ? (productRolesByVendor.get(vendorId) ?? { ...EMPTY_PRODUCT_ROLES })
      : null;
  const owned =
    vendorId && ownedIntegrationsByVendor
      ? (ownedIntegrationsByVendor.get(vendorId) ?? { ...EMPTY_OWNED_INTEGRATIONS })
      : null;

  return {
    ...toAdminClaim(
      row,
      // `is_duplicate` IS the sibling count — see `loadDuplicateSiblings`.
      duplicateSiblings.length > 0,
      targets.get(row.targetId) ?? null,
      authAccountByEmail,
      seatsByRow ? (seatsByRow.get(row.id) ?? []) : null,
      seatEmailsAvailable,
      relatedByRow ? (relatedByRow.get(row.id) ?? []) : null,
      vendorLink,
      roles,
      roles ? isPureConnectorVendor(roles) : null,
      owned,
      contextProductFor(row, targets),
      classifyClaimantSeat(row.submitterEmail, vendorId, authAccountByEmail, claimantProfiles),
    ),
    duplicate_siblings: duplicateSiblings,
  };
}

/**
 * `GET /api/admin/claims/:id` — one claim (AECI-739 / §5.2 step 6). The detail
 * route the §5.2 procedure needed and did not have: a claim parked `open` for the
 * partnership track has to have somewhere to say WHY, and somewhere the reviewer
 * of the NEXT claim on that vendor can read it.
 *
 * Read-only, so **no `audit_log` row** (§9.3 / ADR 0022). Addressable at any of
 * the four statuses, including `in_review` — which the LIST can now filter for
 * too (AECI-739 widened its enum), so this page can never show a status the queue
 * cannot find.
 */
export function createAdminClaimDetailHandler(
  dbFor: DbFactory = getDb,
  fetchAuthAccounts: typeof fetchAuthAccountsByEmail = fetchAuthAccountsByEmail,
  fetchEmails: FetchSeatEmails = fetchAuthUserEmailsResult,
): (c: ClaimContext) => Promise<Response> {
  return async (c) => {
    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing claim id', { field: 'id' });
    }

    const { db } = dbFor(c.env);
    const row = await loadClaimRow(db, id);
    const body = await buildClaimDetail(c, db, row, fetchAuthAccounts, fetchEmails);

    validateResponseInDev(c.env, () => {
      AdminClaimDetailSchema.parse(body);
    });

    return json(body);
  };
}

/**
 * `PATCH /api/admin/claims/:id/notes` — write or clear the operator note
 * (AECI-739 / §5.2 step 6).
 *
 * A SUB-RESOURCE rather than a third `ModerateClaimSchema.action`: moderation is a one-way status
 * transition that grants a paid account or declines one by email, and a note is
 * neither. Keeping them apart is also what lets the note be writable at every
 * status — a resolved or rejected claim is exactly where "why we parked it, and
 * what happened next" is worth having.
 *
 * Follows the admin-write template (preload gate, idempotency gate, one batch with
 * its audit row), minus the moves a note does not need:
 *   - preload gate (404 / 422-not-a-claim) — `loadClaimRow`
 *   - NO status gate: every status is writable, deliberately
 *   - 200 NO-OP when the note is unchanged: nothing written, no audit row. This
 *     follows the claims resource's own idempotency rule (re-granting an
 *     already-granted claim is a documented 200 no-op), not a 422
 *     state gate — that gate rejects invalid STATE TRANSITIONS, and text that
 *     did not change is not one. A trail of identical audit states is not a
 *     history, so writing one would degrade the very record this endpoint exists
 *     to keep.
 *   - ONE `db.batch`: the UPDATE + its `audit_log` row (§26.1)
 *   - metric, then post-commit `waitUntil` forward
 *   - NO cache purge: `/admin/*` is uncacheable and no public surface renders a
 *     claim, let alone an admin-only note (contrast the grant, which flips
 *     `vendors.verified` and does purge)
 *   - NO workflow row: see `saveClaimNotesStatements`
 */
export function createSaveClaimNotesHandler(
  dbFor: DbFactory = getDb,
  fetchAuthAccounts: typeof fetchAuthAccountsByEmail = fetchAuthAccountsByEmail,
  fetchEmails: FetchSeatEmails = fetchAuthUserEmailsResult,
): (c: ClaimContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const actorId = session.userId;
    const actorType = auditActorType(session);

    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing claim id', { field: 'id' });
    }

    const payload = await parseJsonBody(c, SaveClaimNotesSchema);
    const { db } = writeDb(c, dbFor);
    const row = await loadClaimRow(db, id);

    // Whitespace-only is a cleared note, not a note made of spaces — so "clear the
    // box and save" and "send null" are the same action, and neither can produce a
    // row that renders as an empty operator note.
    const next = payload.notes?.trim() ? payload.notes.trim() : null;
    const unchanged = next === row.adminNotes;

    if (!unchanged) {
      const batch = saveClaimNotesStatements(db, {
        requestId: row.id,
        actorId,
        actorType,
        before: row.adminNotes,
        after: next,
        status: row.status,
        targetType: row.targetType,
        targetId: row.targetId,
      });
      await db.batch(batch.stmts as BatchTuple);
      forwardAuditBatch(c, [batch.auditEntry], []);
    }

    emitClaimModeration(c, 'note', unchanged ? 'noop' : 'ok');

    // Rebuild off the committed value rather than re-reading the row: the note is
    // the only thing this endpoint changed, and every other signal is unaffected.
    const body = await buildClaimDetail(
      c,
      db,
      { ...row, adminNotes: next },
      fetchAuthAccounts,
      fetchEmails,
    );

    validateResponseInDev(c.env, () => {
      AdminClaimDetailSchema.parse(body);
    });

    return json(body);
  };
}

/**
 * `GET /api/admin/claims/:id/audit` — the claim's audit trail (AECI-1276).
 *
 * The note's help text on `/admin/claims/:id` says every version is kept in the
 * audit trail. This is where an admin reads it without leaving the claim.
 *
 * Gated by `loadClaimRow`, so an unknown id is 404 and a correction is 422, the
 * same answers the detail GET gives. Without the gate an unknown id would return
 * an empty page, which reads as "no history" rather than "no such claim".
 *
 * ONE disjunct: `entity_type = 'vendor_request'` and the claim id. Every claim
 * writer files there (`vendor_request.created`, `vendor_claim.note_updated`,
 * `vendor_claim.granted`, `vendor_claim.rejected`), and so does the Linear
 * webhook's `vendor_request.status_changed` and the link-back's
 * `vendor_request.linear_linked` (both actor `null`). A Managed grant's
 * `vendor_entitlement.granted` row is filed against the vendor and stays on the
 * vendor's audit tab.
 *
 * Read-only, so no `audit_log` row and no rate limit.
 */
export function createAdminClaimAuditHandler(
  dbFor: DbFactory = getDb,
  fetchEmails: FetchAuthEmails = fetchAuthUserEmailsResult,
): (c: ClaimContext) => Promise<Response> {
  return async (c) => {
    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing claim id', { field: 'id' });
    }
    const query = AdminClaimAuditQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const { db } = dbFor(c.env);
    await loadClaimRow(db, id);

    const where = and(eq(auditLog.entityType, 'vendor_request'), eq(auditLog.entityId, id));
    const body = await readAdminAuditPage(db, c.env, where, query, fetchEmails);

    validateResponseInDev(c.env, () => {
      AdminClaimAuditResponseSchema.parse(body);
    });
    return json(body);
  };
}
