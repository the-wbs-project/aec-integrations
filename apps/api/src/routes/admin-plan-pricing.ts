/**
 * Admin plan price overrides (ruling 2026-10-08, `docs/STAGE_2_PAID_TIERS_SPEC.md`
 * §13.13).
 *
 *   PUT /api/admin/vendors/:id/plan-pricing, behind `requireAdmin()` and the
 *   `write` rate limit.
 *
 * ── DISPLAY ONLY ────────────────────────────────────────────────────────────────
 * The override changes the price line on the vendor portal's plan panel and
 * nothing else. No billing, no payment, no entitlement, capability or ranking
 * effect. That is why this is not a column on `vendor_entitlements` and not part
 * of the entitlement PATCH: a Free vendor with no entitlement row can carry an
 * override, and clearing an entitlement leaves it alone.
 *
 * ── THE BODY IS A FULL REPLACEMENT ──────────────────────────────────────────────
 * `{ managed_price_cents, message }`, both keys required, either `null`. Both
 * `null` is "reset to default", which deletes the row, so a row always carries at
 * least one override. Precedence on the panel is message, then price, then the
 * default sentence.
 *
 * ── AUDIT ───────────────────────────────────────────────────────────────────────
 * Vendor commercial data is domain state, so the write and its `audit_log` row go
 * in ONE `db.batch` (§26.1). `entity_type = 'vendor_plan_pricing'`,
 * `entity_id = <vendor_id>`, the same keying as `vendor_entitlement`, so the trail
 * reads off `audit_log_entity_idx`. A request that changes nothing writes nothing
 * and answers 200 with the current state, because there is no state change to
 * record.
 *
 * ── NO PURGE ────────────────────────────────────────────────────────────────────
 * Nothing public renders the override. The vendor portal is authenticated and
 * never edge-cached, so the next `GET /api/vendor/me` carries the new price.
 */

import {
  SetVendorPlanPricingSchema,
  VendorPlanPricingResponseSchema,
  type PlanPrice,
  type SetVendorPlanPricingInput,
  type VendorPlanPricingResponse,
} from '@aeci/shared';
import { type AuditLogEntry } from '@aeci/shared/audit-log';
import { vendorPlanSnapshot } from '@aeci/shared/entitlements';
import { eq } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { vendorPlanPricing, vendors } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { auditInsert, type BatchTuple } from '../lib/audit';
import { auditActorType, type AuthzVariables } from '../lib/authz';
import { validateResponseInDev, writeDb, type DbFactory } from '../lib/handler-utils';
import { forwardAuditBatch } from '../lib/moderation-forward';
import { loadEntitlement } from '../lib/vendor-entitlement';
import { selectPlanPricing, toPlanPrice, toPlanPricingResponse } from '../lib/vendor-plan-pricing';

type PlanPricingContext = Context<{ Bindings: Env; Variables: AuthzVariables }>;

/** The two audit actions. Registered in `@aeci/shared/audit-vendor-actions`. */
export const PLAN_PRICING_AUDIT_ACTIONS = {
  set: 'vendor_plan_pricing.set',
  cleared: 'vendor_plan_pricing.cleared',
} as const;

async function parseJsonBody(c: PlanPricingContext): Promise<SetVendorPlanPricingInput> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, 'MALFORMED_REQUEST', 'Request body is not valid JSON');
  }
  return SetVendorPlanPricingSchema.parse(raw);
}

function samePrice(a: PlanPrice, b: PlanPrice): boolean {
  return a.managed_price_cents === b.managed_price_cents && a.message === b.message;
}

// ─── PUT /api/admin/vendors/:id/plan-pricing ─────────────────────────────────

export function createSetVendorPlanPricingHandler(
  dbFor: DbFactory = getDb,
): (c: PlanPricingContext) => Promise<Response> {
  return async (c) => {
    const session = c.get('auth');
    const actorId = session.userId;
    const actorType = auditActorType(session);

    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing vendor id', { field: 'id' });
    }

    const payload = await parseJsonBody(c);
    const { db } = writeDb(c, dbFor);

    const vendor = await db.query.vendors.findFirst({
      columns: { id: true },
      where: eq(vendors.id, id),
    });
    if (!vendor) throw notFoundError('vendor', { id });

    const [[existingRow], entitlement] = await Promise.all([
      selectPlanPricing(db, vendor.id),
      loadEntitlement(db, vendor.id),
    ]);

    const before = toPlanPrice(existingRow);
    const next: PlanPrice = {
      managed_price_cents: payload.managed_price_cents,
      message: payload.message,
    };
    const clearing = next.managed_price_cents === null && next.message === null;

    // Nothing to change: no write, no audit row. The response is the stored state.
    if ((clearing && !existingRow) || (existingRow && samePrice(before, next))) {
      const body = toPlanPricingResponse(vendor.id, existingRow);
      validateResponseInDev(c.env, () => VendorPlanPricingResponseSchema.parse(body));
      return json(body);
    }

    const now = new Date().toISOString();
    const auditEntry: AuditLogEntry = {
      actorId,
      actorType,
      action: clearing ? PLAN_PRICING_AUDIT_ACTIONS.cleared : PLAN_PRICING_AUDIT_ACTIONS.set,
      entityType: 'vendor_plan_pricing',
      entityId: vendor.id,
      vendorId: vendor.id,
      vendorPlan: vendorPlanSnapshot(entitlement, now),
      beforeState: existingRow ? before : null,
      afterState: clearing ? null : next,
      metadata: { display_only: true },
    };

    const write = clearing
      ? db.delete(vendorPlanPricing).where(eq(vendorPlanPricing.vendorId, vendor.id))
      : db
          .insert(vendorPlanPricing)
          .values({
            vendorId: vendor.id,
            managedPriceCents: next.managed_price_cents,
            priceMessage: next.message,
            updatedBy: actorId,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: vendorPlanPricing.vendorId,
            set: {
              managedPriceCents: next.managed_price_cents,
              priceMessage: next.message,
              updatedBy: actorId,
              updatedAt: now,
            },
          });

    // ONE batch: the override and its audit row commit or roll back together.
    await db.batch([write, auditInsert(db, auditEntry)] as BatchTuple);

    forwardAuditBatch(c, [auditEntry], [], 'admin-plan-pricing');

    const body: VendorPlanPricingResponse = clearing
      ? toPlanPricingResponse(vendor.id, null)
      : { vendor_id: vendor.id, ...next, updated_by: actorId, updated_at: now };
    validateResponseInDev(c.env, () => VendorPlanPricingResponseSchema.parse(body));
    return json(body);
  };
}
