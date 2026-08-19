/**
 * Admin entitlement action — set / renew / clear (AECI-532 /
 * `docs/STAGE_2_PAID_TIERS_SPEC.md` §5).
 *
 *   PATCH /api/admin/vendors/:id/entitlement — behind `requireAdmin()`.
 *
 * `vendors.verified` has had **no clearing writer at all** since AECI-520 dropped it
 * from the promote payload, and `STAGE_2_VENDOR_PORTAL_SPEC.md` §3 closed that epic
 * with the un-verify half explicitly unowned. This file is its owner — and it clears
 * the bit through the entitlement row, never by writing the mirror directly.
 *
 * ── `verified` IS NEVER IN THE PAYLOAD ──────────────────────────────────────────
 * It follows in the same batch, emitted by `lib/vendor-entitlement.ts` (§2.1). The
 * original AECI-532 shape — a `PATCH /api/admin/vendors/:id` that set `verified`
 * directly — would create a SECOND direct writer and break the mirror invariant; an
 * ESLint rule (Guard 1) now rejects that write anywhere but the sole-writer module.
 * `verified` appears on the RESPONSE only, as a read-only readout of where the mirror
 * landed.
 *
 * ── THE NINE MOVES ──────────────────────────────────────────────────────────────
 * Cloned from `createBanReviewerHandler` (`admin-reviewers.ts`), the canonical
 * reversible-flag admin handler: preload gate (404) → guardrail (403) → 422
 * idempotency gate → derive from/to → build the audit entry → ONE `db.batch` with the
 * guarded UPDATEs → metric → post-commit `waitUntil` forwards + purge →
 * `validateResponseInDev`.
 *
 * ── NO WORKFLOW ROW ─────────────────────────────────────────────────────────────
 * Deliberate and permanent (§1.2 / R1). `workflow_instances_type_check` is a CLOSED
 * CHECK and opening it on SQLite is a full table rebuild; §2.1 settles that
 * `audit_log` IS the entitlement ledger — `audit_log_entity_idx` is
 * `(entity_type, entity_id, created_at)`, so `entity_type='vendor_entitlement',
 * entity_id=<vendor_id>` yields the whole grant/renew/lapse trail with no new index
 * and no new read path.
 *
 * ── PURGE ───────────────────────────────────────────────────────────────────────
 * The FULL grant tag set via the shared `lib/vendor-cache-tags.ts`, not just
 * `vendor:{slug}`: the verified badge renders on the vendor hero, the product-detail
 * vendor card and both pair rails, so a vendor-only purge leaves a stale badge on
 * every cached product page (§5.3).
 *
 * ── THE THREE ORTHOGONAL "TAKE IT AWAY" ACTIONS (§5.2) ──────────────────────────
 * Clearing an entitlement is NOT a seat revoke and NOT a ban. Seats, logins and the
 * dashboard all survive — read-only, because the §4 gate 403s the writes. Confusing
 * the three is a foreseeable incident, which is why the audit metadata says
 * `seats_untouched` out loud and the admin UI copy spells it out.
 */

import {
  ApiErrorCode,
  SetVendorEntitlementSchema,
  VendorEntitlementResponseSchema,
  type SetVendorEntitlementInput,
  type VendorEntitlementResponse,
} from '@aeci/shared';
import { forwardAuditLog, type AuditLogForwarder } from '@aeci/shared/audit-log';
import { capabilitiesFor } from '@aeci/shared/entitlements';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { vendorEntitlements, vendors } from '../db/schema';
import { logToDatadog, submitCount } from '../datadog';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { type BatchTuple } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { vendorPurgeTags } from '../lib/vendor-cache-tags';
import {
  activateEntitlementStatements,
  deactivateEntitlementStatements,
  loadEntitlement,
  renewEntitlementStatements,
  type EntitlementBatch,
} from '../lib/vendor-entitlement';

type EntitlementContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

type EntitlementAction = SetVendorEntitlementInput['action'];

/** The paid entry rung (§3.1). `set` defaults to it, so the common admin call is
 *  `{ action: 'set', period_end }`. */
const DEFAULT_TIER = 'verified';

/**
 * The terminal status a `clear` writes. `'revoked'` = pulled for cause;
 * `'expired'` = term lapsed amicably. The admin action is always a deliberate act
 * ("un-verify stays a deliberate admin act", §7), so it records `revoked` — the §7
 * cron is the only thing that would ever have grounds to write `expired`, and per
 * §7.3 it never writes `status` at all. Both clear the mirror identically.
 */
const CLEAR_TERMINAL = 'revoked';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Datadog forwarder for the audit write; no-op without `DD_API_KEY`. Tagged
 *  `source: admin-entitlement`, matching the audit metadata the builders emit. */
function makeForwarder(c: EntitlementContext): AuditLogForwarder | undefined {
  if (!c.env.DD_API_KEY) return undefined;
  return (entry) => {
    logToDatadog(c.executionCtx, c.env, c.req.raw, {
      level: 'info',
      message: `audit ${entry.action} ${entry.entityId ?? ''}`.trim(),
      action: entry.action,
      entity_type: entry.entityType ?? undefined,
      entity_id: entry.entityId ?? undefined,
      source: 'admin-entitlement',
    });
  };
}

/** `aeci.entitlement.action` (§5) — one per attempt, tagged by action + outcome.
 *  Fire-and-forget; no-op without `DD_API_KEY`. */
function emitEntitlementAction(
  c: EntitlementContext,
  action: EntitlementAction,
  outcome: 'ok' | 'invalid_state' | 'forbidden',
): void {
  submitCount(c.executionCtx, c.env, c.req.raw, 'aeci.entitlement.action', 1, [
    `action:${action}`,
    `outcome:${outcome}`,
  ]);
}

/**
 * Enqueue the vendor + owned-product Cache-Tag purge. Best-effort, exactly like the
 * claim grant's `purgeGrantTags`: no-ops without the queue binding, and a `queue.send`
 * rejection is logged and swallowed — a cache miss must never fail a committed write.
 */
async function purgeEntitlementTags(c: EntitlementContext, tags: readonly string[]): Promise<void> {
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

/** Parse the body, mapping a non-JSON payload to the canonical 400 (cf. the sibling
 *  admin routes, which each carry this three-liner). */
async function parseJsonBody(c: EntitlementContext): Promise<SetVendorEntitlementInput> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  return SetVendorEntitlementSchema.parse(raw);
}

/**
 * The arrangement half of the body — everything except the action verb and the
 * routing/audit fields. Passed through to the builders verbatim (they take the WIRE
 * snake_case shape), so adding an arrangement column is a two-file change, not five.
 */
function arrangementOf(payload: SetVendorEntitlementInput) {
  const { action: _action, tier: _tier, reason: _reason, ...arrangement } = payload;
  return arrangement;
}

/**
 * Map the committed row → the wire readout. `verified` is NOT re-read: the mirror's
 * post-state is known exactly from the action (§2.1's *iff*) — `set` leaves it true,
 * `clear` leaves it false, and `renew` provably cannot move it (the renew builder
 * emits no `vendors` statement at all), so it reports the preloaded value. That is one
 * fewer round-trip than a re-read and it cannot disagree with the batch that just ran.
 */
function toEntitlementResponse(
  vendorId: string,
  row: typeof vendorEntitlements.$inferSelect,
  verified: boolean,
): VendorEntitlementResponse {
  return {
    vendor_id: vendorId,
    tier: row.tier as VendorEntitlementResponse['tier'],
    status: row.status as VendorEntitlementResponse['status'],
    period_start: row.periodStart,
    period_end: row.periodEnd,
    granted_at: row.grantedAt,
    ended_at: row.endedAt,
    verified,
    payer: row.payer,
    amount: row.amount,
    terms: row.terms,
    arranged_by: row.arrangedBy,
    invoice_ref: row.invoiceRef,
    notes: row.notes,
  };
}

// ─── PATCH /api/admin/vendors/:id/entitlement ────────────────────────────────

export function createSetVendorEntitlementHandler(
  dbFor: DbFactory = getDb,
): (c: EntitlementContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const actorId = session.userId;
    const actorType = auditActorType(session);

    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing vendor id', { field: 'id' });
    }

    const payload = await parseJsonBody(c);
    const { action } = payload;
    const { db } = writeDb(c, dbFor);

    // ── 1. Preload gate ──────────────────────────────────────────────────────
    // `verified` comes back here and NOWHERE else: it is the guarded UPDATE's WHERE
    // input and the response readout, never a value the caller supplied.
    const vendor = await db.query.vendors.findFirst({
      columns: { id: true, slug: true, verified: true },
      where: eq(vendors.id, id),
    });
    if (!vendor) throw notFoundError('vendor', { id });

    const existing = await loadEntitlement(db, vendor.id);

    // ── 2. Guardrails ────────────────────────────────────────────────────────
    // Never sell a tier that unlocks nothing. An `active` row at a zero-capability
    // tier flips the `vendors.verified` mirror and lights the badge (§2.1) while
    // `tierFor` resolves it to no capabilities at all — a vendor billed for a badge
    // that unlocks nothing.
    //
    // `unclaimed` — the ABSENCE of an entitlement (§3.1) — is the case that made this
    // concrete, and it is now unreachable here: `SetVendorEntitlementSchema.tier`
    // derives from `PAID_TIERS`, not `TIERS`, so Zod rejects it with a 400 first (the
    // allow-list IS the guard-rail — `api/vendor.ts`'s header invariant). This stays
    // as the semantic rule rather than a restatement of that one tier id, so it keeps
    // biting if a future rung is added to `PAID_TIERS` before its capabilities are.
    if (payload.tier && capabilitiesFor(payload.tier).length === 0) {
      emitEntitlementAction(c, action, 'forbidden');
      throw new ApiError(
        403,
        ApiErrorCode.FORBIDDEN,
        `The ${payload.tier} tier grants no capabilities; clear the entitlement instead of granting it.`,
        { field: 'tier' },
      );
    }
    // A term that ends before it starts arms the §7 expiry cron immediately and is
    // always a data-entry slip. Cross-field, so it cannot live in the Zod schema
    // without reshaping a contract two other issues already consume. Compared as
    // INSTANTS, not strings: the wire type accepts date-only (`2027-09-01`, what a date
    // picker submits) alongside a full timestamp, and the two forms do not sort
    // lexicographically against each other.
    if (payload.period_start !== undefined && payload.period_end !== undefined) {
      if (Date.parse(payload.period_end) <= Date.parse(payload.period_start)) {
        throw new ApiError(
          400,
          ApiErrorCode.VALIDATION_FAILED,
          'period_end must be after period_start.',
          { field: 'period_end' },
        );
      }
    }

    // ── 3. The 422 idempotency gate ──────────────────────────────────────────
    // Every branch below is a state the builders would answer with a silent no-op
    // (zero statements, null audit entry). Silence is right for the claim path — a
    // second seat must not churn the mirror — but wrong for a deliberate admin
    // action, where "nothing happened" has to be visible.
    const isActive = existing?.status === 'active';
    if (action === 'set' && isActive) {
      emitEntitlementAction(c, action, 'invalid_state');
      throw new ApiError(
        422,
        ApiErrorCode.INVALID_STATE_TRANSITION,
        'Vendor already has an active entitlement; renew it to extend the term, or clear it first.',
      );
    }
    if ((action === 'renew' || action === 'clear') && !isActive) {
      emitEntitlementAction(c, action, 'invalid_state');
      throw new ApiError(
        422,
        ApiErrorCode.INVALID_STATE_TRANSITION,
        existing === null
          ? 'Vendor has no entitlement on record.'
          : `Entitlement is ${existing.status}, not active.`,
      );
    }

    // ── 4/5. Derive from/to + build the audit entry ──────────────────────────
    // Both live inside `lib/vendor-entitlement.ts`, the SOLE writer of either side of
    // the mirror. The handler chooses a builder; it never assembles a `vendors`
    // statement, and Guard 1 makes that structural rather than a convention.
    const now = new Date().toISOString();
    const arrangement = arrangementOf(payload);
    let batch: EntitlementBatch;
    if (action === 'set') {
      batch = activateEntitlementStatements(db, {
        vendorId: vendor.id,
        tier: payload.tier ?? DEFAULT_TIER,
        now,
        actorId,
        actorType,
        existing,
        vendorWasVerified: vendor.verified,
        grantedBy: actorId,
        arrangement,
        reason: payload.reason ?? null,
      });
    } else if (action === 'renew') {
      batch = renewEntitlementStatements(db, {
        vendorId: vendor.id,
        now,
        actorId,
        actorType,
        existing,
        arrangement,
        reason: payload.reason ?? null,
      });
    } else {
      batch = deactivateEntitlementStatements(db, {
        vendorId: vendor.id,
        terminal: CLEAR_TERMINAL,
        now,
        actorId,
        actorType,
        existing,
        vendorWasVerified: vendor.verified,
        reason: payload.reason ?? null,
      });
    }

    // The 422 gate above rules out every no-op branch, so a builder returning nothing
    // here means the gate and the builders have drifted apart. Fail loudly rather than
    // committing an empty batch and returning 200 on a write that never happened.
    if (batch.stmts.length === 0 || batch.auditEntry === null) {
      throw new ApiError(
        422,
        ApiErrorCode.INVALID_STATE_TRANSITION,
        'Entitlement is already in the requested state.',
      );
    }

    // ── 6. ONE batch ─────────────────────────────────────────────────────────
    // The entitlement row, the guarded `vendors.verified` + `updated_at` flip and the
    // `audit_log` row commit or roll back together (§26.1). D1 has no interactive
    // transactions; `db.batch` is the only atomic unit there is.
    await db.batch(batch.stmts as BatchTuple);

    // ── 7. Metric ────────────────────────────────────────────────────────────
    emitEntitlementAction(c, action, 'ok');

    // Read the committed row back for the response. Deliberate: `renew` PATCHES the
    // arrangement columns (only the keys supplied), so reconstructing the row in the
    // handler would duplicate the builder's column mapping and drift from it. One
    // single-row lookup on `vendor_entitlements_vendor_key`, on an admin-only action.
    const committed = await db.query.vendorEntitlements.findFirst({
      where: eq(vendorEntitlements.vendorId, vendor.id),
    });
    if (!committed) {
      throw new ApiError(
        500,
        ApiErrorCode.INTERNAL_ERROR,
        'Entitlement row missing immediately after commit.',
      );
    }

    // ── 8. Post-commit, best-effort ──────────────────────────────────────────
    // Purge on `set` / `clear` — the two actions whose batch carries a `vendors`
    // statement and can therefore change a rendered badge. `renew` is skipped because
    // it provably cannot: its builder emits no `vendors` statement at all. Not gated
    // on `verifiedFlipped`: on a drifted vendor a redundant purge costs one cache
    // miss, while a missed purge leaves a wrong badge on every cached product page.
    if (action !== 'renew') {
      const tags = await vendorPurgeTags(db, vendor);
      c.executionCtx.waitUntil(purgeEntitlementTags(c, tags));
    }
    c.executionCtx.waitUntil(forwardAuditLog(batch.auditEntry, makeForwarder(c)));

    // ── 9. Response ──────────────────────────────────────────────────────────
    const verified = action === 'set' ? true : action === 'clear' ? false : vendor.verified;
    const body = toEntitlementResponse(vendor.id, committed, verified);
    validateResponseInDev(c.env, () => {
      VendorEntitlementResponseSchema.parse(body);
    });
    return json(body);
  };
}
