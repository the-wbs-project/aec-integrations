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
 * seat, flip `vendors.verified`, resolve the request — one atomic `db.batch`)
 * instead of a plain resolve. The batch mechanics live in `lib/vendor-grant.ts`;
 * the claimant email→auth-user resolution in `lib/claimant-identity.ts` (AECI-527);
 * this handler owns HTTP, the resolution→status mapping, the idempotency gate, and
 * the post-commit cache purge + claim-decision email seam.
 *
 * The `/admin/claims` LIST + reviewer UI is AECI-521. The claim-decision email
 * SENDER is AECI-528 — wired here as an injectable no-op seam (cf.
 * `noopSyncToLinear` in `admin-requests.ts`), so this endpoint ships standalone
 * and the send-site is already in place.
 *
 * Cache: unlike request-moderation (which purges nothing — a `vendor_request`
 * renders on no cacheable page), a grant flips `vendors.verified` and creates a
 * seat, so it purges the vendor + its products' `Cache-Tag`s post-commit (§3).
 */

import {
  ApiErrorCode,
  ModerateClaimResponseSchema,
  ModerateClaimSchema,
  type ClaimGrantSummary,
  type ModerateClaimResponse,
} from '@aeci/shared';
import { forwardAuditLog, type AuditLogForwarder } from '@aeci/shared/audit-log';
import {
  forwardWorkflowTransition,
  type WorkflowTransitionForwarder,
} from '@aeci/shared/workflow-transition';
import { and, desc, eq } from 'drizzle-orm';
import type { Context } from 'hono';
import type { ZodType } from 'zod';

import { getDb, type Db } from '../db/client';
import { products, productVendors, vendorRequests, vendors, workflowInstances } from '../db/schema';
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
  toAdminVendorRequest,
  type RawAdminVendorRequestRow,
} from '../lib/drizzle-helpers';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { grantSeatStatements, rejectClaimStatements } from '../lib/vendor-grant';

type ClaimContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** The target vendor of a claim — the row the grant flips + purges. */
interface TargetVendor {
  id: string;
  slug: string;
  verified: boolean;
}

/**
 * Claim-decision email seam (§9 / AECI-528). Fired post-commit after an
 * approve/reject so the claimant learns the outcome (and, on approve, how to sign
 * in — no GoTrue invite email is sent, see `createAuthUser`). The Resend template
 * internals are owned by AECI-528; the default here is a safe no-op so this
 * endpoint ships standalone and tests can inject a spy. Best-effort — a send
 * failure is logged, never surfaced to the admin.
 */
export type SendClaimDecisionEmail = (
  c: ClaimContext,
  input: {
    decision: 'approved' | 'rejected';
    to: string;
    requestId: string;
    vendorId: string;
    vendorSlug: string;
    reason: string | null;
  },
) => Promise<void>;

const noopSendClaimEmail: SendClaimDecisionEmail = async () => {};

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

/**
 * The vendor a claim grants: for a `target_type='vendor'` claim, the target
 * itself; for a `target_type='product'` claim, the product's PRIMARY vendor (the
 * `is_primary` row wins; any row is the fallback). Resolving this before calling
 * `resolveClaimantIdentity` is mandatory — exclusivity compares against
 * `profiles.vendor_id`, which can only ever hold a vendor id (§2).
 */
async function resolveTargetVendor(
  db: Db,
  existing: RawAdminVendorRequestRow,
): Promise<TargetVendor> {
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
  return vendor;
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

/** The `vendor:<slug>` + `product:<slug>` (+ `index:products`) tag set a grant
 *  invalidates: the vendor detail page and every product page that embeds it. */
async function grantPurgeTags(db: Db, vendor: TargetVendor): Promise<string[]> {
  const productRows = await db
    .select({ slug: products.slug })
    .from(productVendors)
    .innerJoin(products, eq(products.id, productVendors.productId))
    .where(eq(productVendors.vendorId, vendor.id));
  const tags = [`vendor:${vendor.slug}`, ...productRows.map((r) => `product:${r.slug}`)];
  if (productRows.length > 0) tags.push('index:products');
  return tags;
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
  // idempotent no-op — refuse it up front, BEFORE `resolveIdentity`, whose `invited`
  // branch would otherwise provision an orphan auth user we'd immediately 422 on.
  // (`resolved` is handled after resolution: it may be the idempotent same-seat
  // no-op, which needs the resolved profile to recognize — see the terminal gate.)
  if (existing.status === 'rejected') {
    emitClaimModeration(c, 'approve', 'invalid_state');
    throw new ApiError(
      422,
      ApiErrorCode.INVALID_STATE_TRANSITION,
      'Claim is rejected; only open or in-review claims can be granted.',
    );
  }

  const vendor = await resolveTargetVendor(db, existing);

  // Resolve the claimant's auth-user id (or provision one). Never throws — every
  // failure is an outcome the §2 contract maps to HTTP.
  const resolution = await resolveIdentity(db, c.env, {
    email: existing.submitterEmail,
    vendorId: vendor.id,
  });

  // `rejected` was already refused above; `resolved` is the only terminal state
  // that reaches here (it may be the idempotent same-seat re-grant).
  const terminal = existing.status === 'resolved';

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
      const body = claimResponse(existing, {}, targets.get(existing.targetId) ?? null, {
        user_id: userId,
        vendor_id: vendor.id,
        verified: vendor.verified,
        identity_outcome: identityOutcome,
        seat_created: false,
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

  const { stmts, auditEntry, workflowEntry } = grantSeatStatements(db, {
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

  await db.batch(stmts as BatchTuple);
  emitClaimModeration(c, 'approve', 'ok');

  // Post-commit, best-effort (§3): purge the vendor + its products, send the
  // claim-approved email (AECI-528 seam), forward audit + workflow to Datadog.
  const purgeTags = await grantPurgeTags(db, vendor);
  c.executionCtx.waitUntil(purgeGrantTags(c, purgeTags));
  c.executionCtx.waitUntil(
    sendClaimDecisionEmail(c, {
      decision: 'approved',
      to: email,
      requestId: existing.id,
      vendorId: vendor.id,
      vendorSlug: vendor.slug,
      reason,
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
  c.executionCtx.waitUntil(
    Promise.all([
      forwardAuditLog(auditEntry, makeForwarder(c)),
      forwardWorkflowTransition(workflowEntry, makeWorkflowForwarder(c)),
    ]),
  );

  const targets = await resolveRequestTargets(db, [existing]);
  const body = claimResponse(
    existing,
    { status: 'resolved', resolvedById: actorId, resolvedAt },
    targets.get(existing.targetId) ?? null,
    {
      user_id: userId,
      vendor_id: vendor.id,
      verified: true,
      identity_outcome: identityOutcome,
      seat_created: seatCreated,
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

  c.executionCtx.waitUntil(
    sendClaimDecisionEmail(c, {
      decision: 'rejected',
      to: existing.submitterEmail,
      requestId: existing.id,
      vendorId: existing.targetType === 'vendor' ? existing.targetId : '',
      vendorSlug: '',
      reason,
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

  const targets = await resolveRequestTargets(db, [existing]);
  const body = claimResponse(
    existing,
    { status: 'rejected', resolvedById: actorId, resolvedAt },
    targets.get(existing.targetId) ?? null,
    null,
  );
  validateResponseInDev(c.env, () => ModerateClaimResponseSchema.parse(body));
  return json(body);
}
