import { z } from 'zod';

/**
 * Per-vendor plan price overrides, read side (ruling 2026-10-08,
 * `docs/STAGE_2_PAID_TIERS_SPEC.md` §13.13).
 *
 * WHAT IS LEFT. Decision 8 retired the override, and AECI-1375 removed its admin
 * write (`PUT /api/admin/vendors/:id/plan-pricing`) with the write-only shapes
 * (`SetVendorPlanPricingSchema`, `PlanPriceMessageSchema`,
 * `ManagedPriceCentsSchema`). Rows already written still display on the vendor
 * portal's plan panel, so {@link PlanPriceSchema} stays, and
 * {@link VendorPlanPricingResponseSchema} stays while `lib/vendor-plan-pricing.ts`
 * reads it. E1.8 removes this file with the `vendor_plan_pricing` table.
 *
 * DISPLAY ONLY: no billing, payment, entitlement, capability or ranking effect.
 */

/**
 * The override as the vendor sees it, on every product's plan block
 * (`VendorEntitlementBlock.price`). Never carries who set it.
 */
export const PlanPriceSchema = z.object({
  managed_price_cents: z.number().int().min(0).nullable(),
  message: z.string().nullable(),
});
export type PlanPrice = z.infer<typeof PlanPriceSchema>;

/**
 * A vendor's override row as `lib/vendor-plan-pricing.ts` reads it. A vendor with
 * no override reads all-null, not absent.
 */
export const VendorPlanPricingResponseSchema = PlanPriceSchema.extend({
  vendor_id: z.string().uuid(),
  /** `profiles.id` of the admin who last changed it. Admin-only. */
  updated_by: z.string().nullable(),
  updated_at: z.string().nullable(),
});
export type VendorPlanPricingResponse = z.infer<typeof VendorPlanPricingResponseSchema>;
