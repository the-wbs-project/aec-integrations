import { z } from 'zod';

import { AdminReasonSchema } from './admin-reason';
import { ProductLinkSchema } from './common';
import { ConnectorKindSchema } from './connector-kind-schema';
import { ContestVendorRefSchema } from './integration-contests';
import { IntegrationRetiredBySchema } from './integration-retire';
import { OWNED_INTEGRATION_ANCHORS } from './vendor-attestations';

/**
 * The pairs a connector product delivers, read without a catalogue row (AECI-2045).
 *
 * "Delivered" means the connector product is the row's connector: `connector_product_id`
 * on a `connector_evidenced_pairs` row, or `powered_by_product_id` on an `integrations`
 * row. Two readers:
 *
 * - **The vendor portal** (`GET /api/vendor/products/:id/delivered-pairs`,
 *   `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.13a). On a Sync Service product, the live pairs
 *   recorded as delivered through it whose owner is NOT the caller, read-only, so the
 *   vendor can ask AEC Integrations to record it as the owner (§11b.2).
 * - **The admin console** (`GET /api/admin/products/:id/delivered-pairs`,
 *   `ADMIN_PANEL_SPEC.md` §5.7). Every pair, live and retired, with its owner and
 *   claimed state, and the owner write `PUT /api/admin/integrations/:id/owner`.
 */

/** Which table a delivered pair lives in. The same vocabulary as `OwnedIntegration`. */
export const DeliveredPairAnchorSchema = z.enum(OWNED_INTEGRATION_ANCHORS);

// ─── Vendor portal ───────────────────────────────────────────────────────────

/**
 * One pair the caller's Sync Service product delivers and does not own. Live rows
 * only: a retired row is off the public record and takes no new contest.
 */
export const VendorDeliveredPairSchema = z.object({
  id: z.string().uuid(),
  anchor: DeliveredPairAnchorSchema,
  name: z.string().nullable(),
  product_a: ProductLinkSchema,
  product_b: ProductLinkSchema,
  /** The owner on file, or `null` when nobody is recorded. Never the caller. */
  owner: ContestVendorRefSchema.nullable(),
  /** The owner on file has claimed the row. */
  claimed: z.boolean(),
  /** The caller's own open `owner` contest on this row, when it has one. */
  open_request_id: z.string().uuid().nullable(),
});
export type VendorDeliveredPair = z.infer<typeof VendorDeliveredPairSchema>;

/** A bare object, never paginated: bounded by one connector's pairs. */
export const ListVendorDeliveredPairsResponseSchema = z.object({
  pairs: z.array(VendorDeliveredPairSchema),
});
export type ListVendorDeliveredPairsResponse = z.infer<
  typeof ListVendorDeliveredPairsResponseSchema
>;

// ─── Admin console ───────────────────────────────────────────────────────────

export const AdminDeliveredPairSchema = z.object({
  id: z.string().uuid(),
  anchor: DeliveredPairAnchorSchema,
  name: z.string().nullable(),
  product_a: ProductLinkSchema,
  product_b: ProductLinkSchema,
  /** `built_by_vendor_id`, named. `null` when nobody is on file. */
  owner: ContestVendorRefSchema.nullable(),
  claimed_at: z.string().nullable(),
  retired_at: z.string().nullable(),
  retired_by: IntegrationRetiredBySchema.nullable(),
  /** The vendors of either endpoint product, by name: owner choices beside the
   *  connector's own vendors. The write accepts any vendor; these are what the
   *  console offers. */
  endpoint_vendors: z.array(ContestVendorRefSchema),
});
export type AdminDeliveredPair = z.infer<typeof AdminDeliveredPairSchema>;

export const AdminDeliveredPairsResponseSchema = z.object({
  connector: z.object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    connector_kind: ConnectorKindSchema.nullable(),
  }),
  /** The vendors of the connector product (`product_vendors`), by name. */
  connector_vendors: z.array(ContestVendorRefSchema),
  /** Both tables, ordered by name case-insensitively then id. At most 500 rows. */
  pairs: z.array(AdminDeliveredPairSchema),
});
export type AdminDeliveredPairsResponse = z.infer<typeof AdminDeliveredPairsResponseSchema>;

/**
 * `PUT /api/admin/integrations/:id/owner`. `owner_vendor_id: null` records that no
 * company offers it. The reason is required and lands in the audit row.
 */
export const AdminSetIntegrationOwnerSchema = z
  .object({
    owner_vendor_id: z.string().uuid().nullable(),
    reason: AdminReasonSchema,
  })
  .strict();
export type AdminSetIntegrationOwnerBody = z.infer<typeof AdminSetIntegrationOwnerSchema>;

export const AdminSetIntegrationOwnerResponseSchema = z.object({
  /** `false` when the owner on file already was the one asked for. Nothing was written. */
  changed: z.boolean(),
  pair: AdminDeliveredPairSchema,
});
export type AdminSetIntegrationOwnerResponse = z.infer<
  typeof AdminSetIntegrationOwnerResponseSchema
>;
