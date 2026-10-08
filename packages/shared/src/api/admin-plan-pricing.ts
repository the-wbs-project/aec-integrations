import { z } from 'zod';

import { MANAGED_PRICE_CENTS_MAX, PLAN_PRICE_MESSAGE_MAX } from '../entitlements';

/**
 * Per-vendor plan price overrides (ruling 2026-10-08,
 * `docs/STAGE_2_PAID_TIERS_SPEC.md` §13.13).
 *
 *   PUT /api/admin/vendors/:id/plan-pricing, behind `requireAdmin()`.
 *
 * DISPLAY ONLY. The override changes what the vendor portal's plan panel says
 * Managed costs, and nothing else: no billing, no payment, no entitlement,
 * capability or ranking effect. Precedence on the panel is message, then price,
 * then the default sentence (`planPriceDisplay`, `@aeci/shared/entitlements`).
 *
 * The bounds live in the zod-free registry so the admin control can show them
 * without pulling zod into the lazy route.
 */

/** Matches something shaped like an HTML tag or comment. The message is plain
 *  text: it renders through interpolation, never `innerHTML`, but markup in it
 *  is always a paste mistake, so it is refused at the door. */
const MARKUP = /<[a-zA-Z/!]/;
/** ASCII control characters. Whitespace runs (newlines included) are folded to
 *  one space before this check, so only the stray ones remain. */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * The message override. Whitespace runs fold to one space and the ends are
 * trimmed. An empty result is `null` ("no message"), so a blank textarea clears
 * it rather than failing.
 */
export const PlanPriceMessageSchema = z.preprocess(
  (raw) => {
    if (typeof raw !== 'string') return raw;
    const folded = raw.replace(/\s+/g, ' ').trim();
    return folded === '' ? null : folded;
  },
  z
    .string()
    .min(1)
    .max(PLAN_PRICE_MESSAGE_MAX)
    .refine((s) => !CONTROL.test(s), { message: 'Message must be plain text' })
    .refine((s) => !MARKUP.test(s), { message: 'Message must be plain text, not markup' })
    .nullable(),
);

/** The price override: whole US cents, 0 to $100,000. `null` = the default. */
export const ManagedPriceCentsSchema = z
  .number()
  .int()
  .min(0)
  .max(MANAGED_PRICE_CENTS_MAX)
  .nullable();

/**
 * Body for `PUT /api/admin/vendors/:id/plan-pricing`. A full replacement: both
 * keys are required, and both `null` resets the vendor to the default (the row
 * is deleted).
 */
export const SetVendorPlanPricingSchema = z.object({
  managed_price_cents: ManagedPriceCentsSchema,
  message: PlanPriceMessageSchema,
});
export type SetVendorPlanPricingInput = z.infer<typeof SetVendorPlanPricingSchema>;

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
 * The admin readout: the PUT's response and `AdminVendorDetail.plan_pricing`.
 * A vendor with no override reads all-null, not absent.
 */
export const VendorPlanPricingResponseSchema = PlanPriceSchema.extend({
  vendor_id: z.string().uuid(),
  /** `profiles.id` of the admin who last changed it. Admin-only. */
  updated_by: z.string().nullable(),
  updated_at: z.string().nullable(),
});
export type VendorPlanPricingResponse = z.infer<typeof VendorPlanPricingResponseSchema>;
