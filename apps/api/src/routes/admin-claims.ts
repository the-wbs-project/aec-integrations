/**
 * Admin claim → verified-account grant API (AECI-519 /
 * `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §3). The admin action behind
 * `requireAdmin()` that turns an approved vendor CLAIM into a live verified
 * vendor account:
 *
 *   PATCH /api/admin/claims/:id — approve (grant) / reject a claim.
 *
 * A sibling of `PATCH /api/admin/requests/:id` (`admin-requests.ts`), not a
 * replacement: corrections still moderate through the requests endpoint; a claim
 * moderates here so `approve` runs the §3 grant batch (link the `vendor_admin`
 * seat, open the entitlement, resolve the request — one atomic `db.batch`)
 * instead of a plain resolve. The batch mechanics live in `lib/vendor-grant.ts`;
 * the claimant email→auth-user resolution in `lib/claimant-identity.ts` (AECI-527);
 * this handler owns HTTP, the resolution→status mapping, the idempotency gate, and
 * the post-commit cache purge + claim-decision email seam.
 *
 * ── THE GRANT IS TWO COMPOSED BUILDERS (AECI-612 / §6) ────────────────────────
 * `approveClaim` concatenates `grantSeatStatements(...)` (seat, request resolve,
 * workflow, claim audit) with `activateEntitlementStatements(...)` (the
 * `vendor_entitlements` row, the guarded `vendors.verified` flip, the entitlement
 * audit) into ONE `db.batch([...grant.stmts, ...ent.stmts])`. D1 has no
 * interactive transactions, so composition-into-one-batch is the only way the
 * seat and the entitlement can be atomic with each other.
 *
 * Why two modules and not one: `vendors.verified` is a denormalized MIRROR of
 * `vendor_entitlements` (§2.1) and `lib/vendor-entitlement.ts` is its SOLE writer
 * — enforced by an ESLint rule. `grantSeatStatements` no longer names `vendors`
 * at all. The §2.3 second-seat row is what makes this safe: when the vendor
 * already has an `active` entitlement, `ent.stmts` is `[]` and `ent.auditEntry` is
 * `null`, so the batch is exactly today's minus the no-op guarded UPDATE. An
 * unconditional INSERT there would violate `vendor_entitlements_vendor_key` and
 * roll back the entire seat grant.
 *
 * The `/admin/claims` LIST + reviewer UI is AECI-521. The claim-decision email
 * SENDER is AECI-528: the send-site is an injectable seam (cf. `noopSyncToLinear`
 * in `admin-requests.ts`) whose default here is a no-op, so this endpoint ships +
 * tests standalone; the real Resend templates (`lib/email.ts` `sendClaim*Email`)
 * are injected at the route registration in `index.ts`.
 *
 * Cache: unlike request-moderation (which purges nothing — a `vendor_request`
 * renders on no cacheable page), a grant flips `vendors.verified` and creates a
 * seat, so it purges the vendor + its products' `Cache-Tag`s post-commit (§3).
 */

import {
  ApiErrorCode,
  ListVendorClaimsQuerySchema,
  ListVendorClaimsResponseSchema,
  ModerateClaimResponseSchema,
  ModerateClaimSchema,
  type AdminVendorSeat,
  type ClaimGrantSummary,
  type ListVendorClaimsResponse,
  type ModerateClaimResponse,
  type RelatedRequestRef,
} from '@aeci/shared';
import { forwardAuditLog, type AuditLogForwarder } from '@aeci/shared/audit-log';
import { tierFor, type EntitlementTier } from '@aeci/shared/entitlements';
import {
  forwardWorkflowTransition,
  type WorkflowTransitionForwarder,
} from '@aeci/shared/workflow-transition';
import { and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb, type Db } from '../db/client';
import { productVendors, profiles, vendorRequests, vendors, workflowInstances } from '../db/schema';
import { logToDatadog, submitCount } from '../datadog';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { type BatchTuple } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { resolveClaimantIdentity } from '../lib/claimant-identity';
import { VENDOR_ADMIN_ROLE } from '../lib/claimed-vendors';
import {
  adminVendorRequestConfig,
  resolveRequestTargets,
  toAdminClaim,
  toAdminVendorRequest,
  type RawAdminVendorRequestRow,
} from '../lib/drizzle-helpers';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { fetchAuthAccountsByEmail } from '../lib/supabase-admin';
import { vendorPurgeTags, type TargetVendor } from '../lib/vendor-cache-tags';
import {
  activateEntitlementStatements,
  loadEntitlement,
  type EntitlementBefore,
} from '../lib/vendor-entitlement';
import {
  CLAIM_AUDIT_SOURCE,
  grantSeatStatements,
  rejectClaimStatements,
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
 * `identityOutcome` is set only on approve (`invited` → account just provisioned,
 * so the copy explains first-time sign-in; `linked` → an existing account).
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
    identityOutcome?: 'linked' | 'invited';
  },
) => Promise<void>;

const noopSendClaimEmail: SendClaimDecisionEmail = async () => {};

/**
 * The tier a claim approval grants (AECI-612 / §6.3). `verified` is the paid ENTRY
 * rung (§3.1) and the only one this flow mints — moving a vendor up a future ladder
 * is the admin `PATCH /api/admin/vendors/:id/entitlement` action (§5), not a claim
 * decision. Typed as `EntitlementTier`, so adding a rung to `TIERS` cannot silently
 * turn this into a free-form string.
 */
const GRANT_TIER: EntitlementTier = 'verified';

/**
 * `audit_log.action` for the entitlement row a claim approval opens. Distinct from
 * `ENTITLEMENT_ACTION.set` (the §5 admin action) so the `entity_type='vendor_entitlement',
 * entity_id=<vendor_id>` history ledger (§2.1) shows at a glance which grants came
 * from a claim and which an admin recorded by hand. It shares `metadata.source` with
 * the sibling `vendor_claim.granted` row, so the two read as one action.
 */
const ENTITLEMENT_GRANT_ACTION = 'vendor_entitlement.granted';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Datadog forwarder for the audit write; no-op without `DD_API_KEY`. Tagged
 *  `source: admin-moderation`, matching `admin-requests.ts`. */
function makeForwarder(c: ClaimContext): AuditLogForwarder | undefined {
  if (!c.env.DD_API_KEY) return undefined;
  return (entry) => {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source: 'admin-moderation',
    });
  };
}

/** Datadog forwarder for the workflow-transition write; no-op without `DD_API_KEY`. */
function makeWorkflowForwarder(c: ClaimContext): WorkflowTransitionForwarder | undefined {
  if (!c.env.DD_API_KEY) return undefined;
  return (entry) => {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `workflow ${entry.fromState ?? '∅'}→${entry.toState} ${entry.workflowId}`.trim(),
      from_state: entry.fromState ?? undefined,
      to_state: entry.toState,
      workflow_id: entry.workflowId,
      source: 'admin-moderation',
    });
  };
}

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
 *  and outcome. Fire-and-forget; no-op without `DD_API_KEY`. */
function emitClaimModeration(
  c: ClaimContext,
  action: 'approve' | 'reject',
  outcome: 'ok' | 'noop' | 'invalid_state' | 'conflict' | 'unavailable',
): void {
  submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.claim.moderation.action', 1, [
    `action:${action}`,
    `outcome:${outcome}`,
  ]);
}

/** The preloaded grant target: the vendor a claim seats against, plus its
 *  entitlement row (`null` = never entitled). */
interface ClaimTarget {
  vendor: TargetVendor;
  /** Preloaded so `activateEntitlementStatements` can branch the §2.3 matrix in TS
   *  rather than with `onConflictDoUpdate` — that branch is what makes the
   *  second-seat case emit genuinely nothing. */
  entitlement: EntitlementBefore | null;
}

/**
 * The vendor a claim grants: for a `target_type='vendor'` claim, the target
 * itself; for a `target_type='product'` claim, the product's PRIMARY vendor (the
 * `is_primary` row wins; any row is the fallback). Resolving this before calling
 * `resolveClaimantIdentity` is mandatory — exclusivity compares against
 * `profiles.vendor_id`, which can only ever hold a vendor id (§2).
 *
 * Also preloads the vendor's `vendor_entitlements` row (AECI-612 / §6.4) — one
 * extra single-row lookup on `vendor_entitlements_vendor_key`, on a path that
 * already does five reads. It feeds both the §2.3 activate branch and the
 * idempotent re-grant's `tier` readout, so no caller re-derives the `findFirst`.
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
    columns: { id: true, slug: true, verified: true },
    where: eq(vendors.id, vendorId),
  });
  if (!vendor) throw notFoundError('vendor', { id: vendorId });
  return { vendor, entitlement: await loadEntitlement(db, vendorId) };
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

/** Enqueue the vendor + product Cache-Tag purge for a grant (§3). Best-effort:
 *  no-ops without the queue binding; a `queue.send` rejection is logged and
 *  swallowed — a cache miss must never fail a committed grant. */
async function purgeGrantTags(c: ClaimContext, tags: readonly string[]): Promise<void> {
  const queue = c.env.CACHE_PURGE_QUEUE;
  if (!queue || tags.length === 0) return;
  try {
    await queue.send({ tags: [...tags], source: 'moderation' });
  } catch (error) {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'warn',
      message: `Cache purge enqueue failed for ${tags.join(',')}`,
      outcome: error instanceof Error ? error.message : String(error),
    });
  }
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
          entitlement: payload.entitlement,
          actorId,
          actorType,
        })
      : rejectClaim(c, db, sendClaimDecisionEmail, { existing, reason, actorId, actorType });
  };
}

interface ApproveArgs {
  existing: RawAdminVendorRequestRow;
  reason: string | null;
  entitlement: ReturnType<typeof ModerateClaimSchema.parse>['entitlement'];
  actorId: string;
  actorType: ReturnType<typeof auditActorType>;
}

async function approveClaim(
  c: ClaimContext,
  db: Db,
  resolveIdentity: typeof resolveClaimantIdentity,
  sendClaimDecisionEmail: SendClaimDecisionEmail,
  { existing, reason, entitlement, actorId, actorType }: ApproveArgs,
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

  const { vendor, entitlement: entitlementBefore } = await resolveTargetVendor(db, existing);

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

  // Terminal-gate + idempotency. A re-grant of a claim already resolved to this
  // exact seat is a no-op (no batch, no audit noise). A resolved claim whose seat
  // is gone is a genuine invalid transition.
  if (terminal) {
    if (existing.status === 'resolved' && alreadySeated) {
      emitClaimModeration(c, 'approve', 'noop');
      const targets = await resolveRequestTargets(db, [existing]);
      // No batch is built on this path (§6.5) — the summary is a pure readout of
      // the preloaded state. `tierFor` fails closed, so a vendor whose entitlement
      // was cleared (or never backfilled) reports `unclaimed`, not a flattering
      // `verified` derived from the mirror.
      const body = claimResponse(existing, {}, targets.get(existing.targetId) ?? null, {
        user_id: userId,
        vendor_id: vendor.id,
        verified: vendor.verified,
        identity_outcome: identityOutcome,
        seat_created: false,
        tier: tierFor(entitlementBefore),
        entitlement_created: false,
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

  const resolvedAt = new Date().toISOString();
  const { workflowId, existingWf } = await findClaimWorkflow(db, existing.id);

  const grant = grantSeatStatements(db, {
    userId,
    vendorId: vendor.id,
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
    entitlement,
    reason,
    targetType: existing.targetType,
    targetId: existing.targetId,
  });

  // The entitlement half of the same grant (§6.3). `tier: 'verified'` is the paid
  // entry rung (§3.1) — the claim flow grants no other. The claim body's
  // arrangement blob lands in BOTH places on purpose (§6.6): verbatim in the claim
  // audit metadata (the history ledger) and as columns on the row (the state).
  //
  // Per the §2.3 matrix this returns the frozen no-op — zero statements, `null`
  // audit entry — whenever the vendor already has an `active` row, which is the
  // second-seat case.
  const ent = activateEntitlementStatements(db, {
    vendorId: vendor.id,
    tier: GRANT_TIER,
    now: resolvedAt,
    actorId,
    actorType,
    existing: entitlementBefore,
    vendorWasVerified: vendor.verified,
    grantedBy: actorId,
    sourceRequestId: existing.id,
    arrangement: entitlement,
    action: ENTITLEMENT_GRANT_ACTION,
    source: CLAIM_AUDIT_SOURCE,
    reason,
  });

  // ONE batch. The seat, the request resolve, the workflow, the entitlement row,
  // the mirror flip and both audit rows commit or roll back together (§26.1).
  await db.batch([...grant.stmts, ...ent.stmts] as BatchTuple);
  emitClaimModeration(c, 'approve', 'ok');

  // Resolve the claimed target's display name up front — reused by the email
  // (AECI-528) and the response body.
  const targets = await resolveRequestTargets(db, [existing]);
  const targetName = targets.get(existing.targetId)?.name ?? '';

  // Post-commit, best-effort (§3): purge the vendor + its products, send the
  // claim-approved email (AECI-528 seam), forward audit + workflow to Datadog.
  const purgeTags = await vendorPurgeTags(db, vendor);
  c.executionCtx.waitUntil(purgeGrantTags(c, purgeTags));
  c.executionCtx.waitUntil(
    sendClaimDecisionEmail(c, {
      decision: 'approved',
      to: email,
      requestId: existing.id,
      vendorId: vendor.id,
      vendorSlug: vendor.slug,
      targetName,
      identityOutcome,
    }).catch((error) => {
      try {
        logToDatadog(c.executionCtx, c.env, c.req.raw, {
          level: 'warn',
          message: `claim-approved email failed for ${existing.id}`,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        console.warn('admin-claims: claim-approved email failed', error);
      }
    }),
  );
  // Both audit rows forward (§26.5). `ent.auditEntry` is null on the second-seat
  // path, and `forwardAuditLog` is a no-op for it.
  c.executionCtx.waitUntil(
    Promise.all([
      forwardAuditLog(grant.auditEntry, makeForwarder(c)),
      ent.auditEntry ? forwardAuditLog(ent.auditEntry, makeForwarder(c)) : Promise.resolve(),
      forwardWorkflowTransition(grant.workflowEntry, makeWorkflowForwarder(c)),
    ]),
  );

  const body = claimResponse(
    existing,
    { status: 'resolved', resolvedById: actorId, resolvedAt },
    targets.get(existing.targetId) ?? null,
    {
      user_id: userId,
      vendor_id: vendor.id,
      // Where the MIRROR actually landed, not an assumption. True on a first grant
      // (the guarded flip fired) and on a second seat (already true). It is only
      // false in the one drifted state this grant cannot repair — an `active`
      // entitlement row over `verified = 0`, where the §2.3 matrix emits nothing
      // and `ops:backfill-entitlements` (Guard 2's remedy) owns the fix.
      verified: vendor.verified || ent.verifiedFlipped,
      identity_outcome: identityOutcome,
      seat_created: seatCreated,
      // The tier this grant WROTE, or — on the second-seat no-op, where nothing was
      // written — the tier the pre-existing active row already carries, resolved
      // fail-closed. Today `TIERS` is binary so both arms say `verified`; the
      // distinction is what keeps the readout honest once a rung is added (§3.1
      // makes that a data-only edit).
      tier: ent.stmts.length > 0 ? GRANT_TIER : tierFor(entitlementBefore),
      entitlement_created: ent.entitlementCreated,
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

  await db.batch(stmts as BatchTuple);
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
        logToDatadog(c.executionCtx, c.env, c.req.raw, {
          level: 'warn',
          message: `claim-rejected email failed for ${existing.id}`,
          error: error instanceof Error ? error.message : String(error),
        });
      } catch {
        console.warn('admin-claims: claim-rejected email failed', error);
      }
    }),
  );
  c.executionCtx.waitUntil(
    Promise.all([
      forwardAuditLog(auditEntry, makeForwarder(c)),
      forwardWorkflowTransition(workflowEntry, makeWorkflowForwarder(c)),
    ]),
  );

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
 * The claimed vendor's active seats, keyed by REQUEST id (§5 "existing seats").
 * Resolves each claim's target vendor first (a `product` claim → its PRIMARY
 * vendor, mirroring `resolveTargetVendor`), then ONE grouped `profiles` scan over
 * the page's vendor ids (`role='vendor_admin' AND banned_at IS NULL`) — no per-row
 * N+1. A claim whose product has no vendor maps to `[]` (there is no vendor to
 * seat). Ordered oldest-first so the roster is stable.
 */
async function loadExistingSeats(
  db: Db,
  rows: RawAdminVendorRequestRow[],
): Promise<Map<string, AdminVendorSeat[]>> {
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

  const vendorIds = [...new Set(vendorByRow.values())];
  const seatsByVendor = new Map<string, AdminVendorSeat[]>();
  if (vendorIds.length > 0) {
    const seatRows = await db
      .select({
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
      .orderBy(asc(profiles.createdAt));
    for (const s of seatRows) {
      if (!s.vendorId) continue;
      const list = seatsByVendor.get(s.vendorId) ?? [];
      list.push({
        display_name: s.displayName,
        work_email_verified: s.workEmailVerified,
        created_at: s.createdAt,
      });
      seatsByVendor.set(s.vendorId, list);
    }
  }

  const byRow = new Map<string, AdminVendorSeat[]>();
  for (const [rowId, vendorId] of vendorByRow) {
    byRow.set(rowId, seatsByVendor.get(vendorId) ?? []);
  }
  return byRow;
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
    .orderBy(desc(vendorRequests.createdAt));

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
    // FAIL-SOFT enrichment: a rejected seats/related query becomes a `null` signal
    // (UI: "unavailable"), never a failed response.
    const [targets, authAccountByEmail, seatsByRow, relatedByRow] = await Promise.all([
      resolveRequestTargets(db, rows),
      fetchAuthAccounts(c.env, claimEmails),
      loadExistingSeats(db, rows).catch(() => null),
      loadRelatedRequests(db, rows, claimEmails).catch(() => null),
    ]);

    const body: ListVendorClaimsResponse = {
      data: rows.map((row) =>
        toAdminClaim(
          row,
          isDuplicate(row),
          targets.get(row.targetId) ?? null,
          authAccountByEmail,
          seatsByRow ? (seatsByRow.get(row.id) ?? []) : null,
          relatedByRow ? (relatedByRow.get(row.id) ?? []) : null,
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
