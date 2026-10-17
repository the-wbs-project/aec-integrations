/**
 * Reads of `vendor_plan_pricing` (ruling 2026-10-08,
 * `docs/STAGE_2_PAID_TIERS_SPEC.md` §13.13). Display only: the plan panel's price
 * line. Nothing here bills, gates a capability or touches ranking.
 *
 * No writer is left: decision 8 retired the override, and AECI-1375 removed its admin
 * route (`PUT /api/admin/vendors/:id/plan-pricing`). Rows already written still show
 * on the vendor plan panel until E1.8 removes this module with the table.
 */

import type { PlanPrice, VendorPlanPricingResponse } from '@aeci/shared';
import { eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { vendorPlanPricing } from '../db/schema';

export type VendorPlanPricingRow = typeof vendorPlanPricing.$inferSelect;

/** The single-row lookup on the primary key. */
export function selectPlanPricing(db: Db, vendorId: string) {
  return db.select().from(vendorPlanPricing).where(eq(vendorPlanPricing.vendorId, vendorId));
}

/** The vendor-facing block. No row is the default. Never carries `updated_by`. */
export function toPlanPrice(row: VendorPlanPricingRow | null | undefined): PlanPrice {
  return {
    managed_price_cents: row?.managedPriceCents ?? null,
    message: row?.priceMessage ?? null,
  };
}

/** The admin readout. No row reads all-null, never absent. */
export function toPlanPricingResponse(
  vendorId: string,
  row: VendorPlanPricingRow | null | undefined,
): VendorPlanPricingResponse {
  return {
    vendor_id: vendorId,
    ...toPlanPrice(row),
    updated_by: row?.updatedBy ?? null,
    updated_at: row?.updatedAt ?? null,
  };
}

/**
 * The vendor's price block, for every product's `plan` (§13.7). One primary-key
 * read. Until per-product plans exist, the same block goes on every product.
 */
export async function loadPlanPrice(db: Db, vendorId: string): Promise<PlanPrice> {
  const [row] = await selectPlanPricing(db, vendorId);
  return toPlanPrice(row);
}
