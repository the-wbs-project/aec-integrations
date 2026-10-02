import { z } from 'zod';

import { VendorEntitlementBlockSchema } from './admin-entitlements';

/**
 * The checklist reads (AECI-1217 / `STAGE_2_PAID_TIERS_SPEC.md` §13.10):
 *
 *   GET /api/vendor/checklist               — the vendor-level steps, plus one
 *                                             score per owned product for the
 *                                             Products list.
 *   GET /api/vendor/products/:id/checklist  — one owned product's steps.
 *
 * Every step derives from records that already exist, plus
 * `products.integrations_reviewed_at`. There is no progress table, so nothing here
 * is ever written by a client.
 *
 * ── How a step reads ─────────────────────────────────────────────────────────
 * `counts` says whether the step is in the score. `status` says where it stands:
 *
 *   - `done`     — finished. A done step keeps `done` whether or not it counts.
 *   - `todo`     — not finished, and it counts.
 *   - `optional` — not finished, and it does not count. "Invite a colleague"
 *                  always; "Confirm data flows" on a product whose plan lacks
 *                  `attestation.author` (a Free product, §13.1 decision 6).
 *
 * `done` / `total` count the counted steps only. So a Free product reads "3 of 3"
 * when finished, and a Managed product reads "x of 4". A step with nothing to do
 * is `done` (§13.10 "a step with nothing to do counts as done").
 *
 * i18n note: keys are stable identifiers, never copy. The portal maps each key to
 * its own `$localize` label.
 */

/** The four product steps, in display order (§13.10). */
export const PRODUCT_CHECKLIST_STEP_KEYS = [
  'product_details',
  'integration_list',
  'claim_integrations',
  'confirm_data_flows',
] as const;
export const ProductChecklistStepKeySchema = z.enum(PRODUCT_CHECKLIST_STEP_KEYS);
export type ProductChecklistStepKey = z.infer<typeof ProductChecklistStepKeySchema>;

/** The three vendor steps, in display order (§13.10). */
export const VENDOR_CHECKLIST_STEP_KEYS = [
  'company_details',
  'finish_products',
  'invite_colleague',
] as const;
export const VendorChecklistStepKeySchema = z.enum(VENDOR_CHECKLIST_STEP_KEYS);
export type VendorChecklistStepKey = z.infer<typeof VendorChecklistStepKeySchema>;

export const ChecklistStepStatusSchema = z.enum(['done', 'todo', 'optional']);
export type ChecklistStepStatus = z.infer<typeof ChecklistStepStatusSchema>;

function stepSchema<K extends z.ZodTypeAny>(key: K) {
  return z.object({
    key,
    status: ChecklistStepStatusSchema,
    /** Whether the step is in `done` / `total`. */
    counts: z.boolean(),
  });
}

export const ProductChecklistStepSchema = stepSchema(ProductChecklistStepKeySchema);
export type ProductChecklistStep = z.infer<typeof ProductChecklistStepSchema>;

export const VendorChecklistStepSchema = stepSchema(VendorChecklistStepKeySchema);
export type VendorChecklistStep = z.infer<typeof VendorChecklistStepSchema>;

/** The score fields every checklist carries. `complete` is `done === total`. */
const scoreShape = {
  done: z.number().int().min(0),
  total: z.number().int().min(0),
  complete: z.boolean(),
};

/**
 * One product's score, as the Products list shows it. `plan` is this product's
 * plan block (§13.7), the same value `GET /api/vendor/me` puts on the product.
 */
export const VendorProductChecklistSummarySchema = z.object({
  product_id: z.string().uuid(),
  product_slug: z.string(),
  plan: VendorEntitlementBlockSchema,
  ...scoreShape,
});
export type VendorProductChecklistSummary = z.infer<typeof VendorProductChecklistSummarySchema>;

/** `GET /api/vendor/products/:id/checklist`. */
export const VendorProductChecklistResponseSchema = VendorProductChecklistSummarySchema.extend({
  steps: z.array(ProductChecklistStepSchema),
});
export type VendorProductChecklistResponse = z.infer<typeof VendorProductChecklistResponseSchema>;

/**
 * `GET /api/vendor/checklist`. `products` is in the order `GET /api/vendor/me`
 * lists them: by name, case-insensitive, then id.
 */
export const VendorChecklistResponseSchema = z.object({
  steps: z.array(VendorChecklistStepSchema),
  ...scoreShape,
  products: z.array(VendorProductChecklistSummarySchema),
});
export type VendorChecklistResponse = z.infer<typeof VendorChecklistResponseSchema>;
