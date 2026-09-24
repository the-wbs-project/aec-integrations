import { z } from 'zod';

import { ConnectorManagedBySchema } from './admin-connector-catalogs';
import {
  AdminConnectorStubStateSchema,
  ConnectorMappingConfidenceSchema,
  ConnectorMappingStatusSchema,
  type AdminConnectorMapping,
} from './admin-connectors';
import { LinkRefSchema, PageQuerySchema, paginatedResponseSchema } from './common';
import { CONNECTOR_AUTO_DECIDER } from './promote-connector';

/**
 * The connector catalogue seat's own catalogue, as the vendor portal reads it
 * (AECI-1083 — `docs/STAGE_2_VENDOR_PORTAL_SPEC.md` §6.16, `docs/STAGE_2_SPEC.md`
 * §8.9(1)).
 *
 *   GET /api/vendor/products/:id/connector-catalog — behind `requireVendor()`, not
 *     rate-limited (a read), not entitlement-gated (the §8.9 seat has no entitlement).
 *
 * The screen it feeds edits mappings through AECI-724's
 * `PATCH /api/vendor/connector-stub-mappings/:id`, whose contract is unchanged.
 *
 * ── WHY IT IS NOT THE ADMIN SHAPE ───────────────────────────────────────────
 * The admin triage row (`AdminConnectorStubRow`) carries two things a vendor should
 * not read:
 *
 *   - `notes`, the review app's curation note on a mapping. It is internal working
 *     text, the same class of field as `attestations.note` (AECI-779), and nothing
 *     on this screen needs it.
 *   - `decided_by` verbatim. Before AECI-724 the review app wrote a reviewer's name
 *     there. The vendor needs to know what kind of decider stands behind a row, not
 *     which AECi person. So the read ships {@link VendorConnectorDecider} instead.
 *
 * It also drops the admin row's action-inventory and tombstone fields: removed
 * listings are not returned at all, and the inventory is review-side.
 *
 * ── THE SAME `publishable`, NEVER RE-DERIVED ────────────────────────────────
 * `publishable` is §9a.4's provenance gate, computed server-side by the one
 * predicate the admin screen and the public reach line use. The UI reads it; it
 * never re-implements it.
 */

/**
 * Who stands behind a mapping, in the words a vendor needs.
 *
 *   - `vendor` — a seat on the catalogue's own vendor saved it (`vendor:{slug}`).
 *   - `aeci` — an AECi reviewer or operator decided it. Publishable.
 *   - `automatic` — the review app's name-match pass proposed it
 *     (`auto-name-match`). Never publishable until someone confirms it.
 *   - `null` — no decider recorded.
 */
export const VENDOR_CONNECTOR_DECIDERS = ['vendor', 'aeci', 'automatic'] as const;
export const VendorConnectorDeciderSchema = z.enum(VENDOR_CONNECTOR_DECIDERS);
export type VendorConnectorDecider = z.infer<typeof VendorConnectorDeciderSchema>;

/** `connector_stub_mappings.decided_by` → {@link VendorConnectorDecider}. */
export function connectorDeciderKind(decidedBy: string | null): VendorConnectorDecider | null {
  if (decidedBy === null || decidedBy === '') return null;
  if (decidedBy === CONNECTOR_AUTO_DECIDER) return 'automatic';
  if (decidedBy.startsWith('vendor:')) return 'vendor';
  return 'aeci';
}

export const VendorConnectorMappingSchema = z.object({
  id: z.string().min(1).max(64),
  status: ConnectorMappingStatusSchema,
  /** `null` on the three decision statuses, and on a `mapped` row whose product
   *  was deleted (§9a.4 keeps that visible). */
  product: LinkRefSchema.nullable(),
  confidence: ConnectorMappingConfidenceSchema.nullable(),
  evidence_url: z.string().nullable(),
  decided_by: VendorConnectorDeciderSchema.nullable(),
  decided_at: z.string().nullable(),
  /** §9a.4's publication gate, for this row alone. */
  publishable: z.boolean(),
});
export type VendorConnectorMapping = z.infer<typeof VendorConnectorMappingSchema>;

/**
 * The admin mapping shape → the vendor one. The PATCH answers in the admin shape
 * (its contract is AECI-724's and does not change), so the screen converts its
 * echo through this before splicing it into the list.
 */
export function toVendorConnectorMapping(m: AdminConnectorMapping): VendorConnectorMapping {
  return {
    id: m.id,
    status: m.status,
    product: m.product,
    confidence: m.confidence,
    evidence_url: m.evidence_url,
    decided_by: connectorDeciderKind(m.decided_by),
    decided_at: m.decided_at,
    publishable: m.publishable,
  };
}

/** One listing on the vendor's catalogue, with every mapping on it. */
export const VendorConnectorListingSchema = z.object({
  id: z.string().min(1).max(64),
  slug: z.string().min(1),
  label: z.string().nullable(),
  /** The vendor's own listing page, when the ingest recorded one. */
  url: z.string().nullable(),
  mappings: z.array(VendorConnectorMappingSchema),
});
export type VendorConnectorListing = z.infer<typeof VendorConnectorListingSchema>;

/**
 * The catalogue's header facts.
 *
 * `managed_by` decides whether the screen can edit: `vendor` means the review lane
 * is frozen and the seat maintains the catalogue; `review` means AECi's sync still
 * writes it and every PATCH would be `409 CATALOG_REVIEW_MANAGED`.
 */
export const VendorConnectorCatalogSummarySchema = z.object({
  id: z.string().min(1).max(64),
  managed_by: ConnectorManagedBySchema,
  /** MAX(`connector_catalog_surfaces.last_ingested_at`), the "as of" stamp. */
  last_ingested_at: z.string().nullable(),
  /** Listings not removed from the vendor's index. */
  listings: z.number().int().min(0),
  /** Listings with no mapping row at all (§9a.4: absence is pending). */
  unmatched: z.number().int().min(0),
  /** Mapping rows that clear the publication gate. */
  publishable: z.number().int().min(0),
});
export type VendorConnectorCatalogSummary = z.infer<typeof VendorConnectorCatalogSummarySchema>;

export const VendorConnectorCatalogQuerySchema = PageQuerySchema.extend({
  perPage: z.coerce.number().int().min(1).max(50).default(25),
  /** `undecided` is the anti-join; the rest are an EXISTS on that status. */
  state: AdminConnectorStubStateSchema.optional(),
  /** Substring over the listing's slug or label. */
  search: z.string().max(200).optional(),
});
export type VendorConnectorCatalogQuery = z.infer<typeof VendorConnectorCatalogQuerySchema>;

/**
 * `catalog: null` when AECi holds no catalogue for this connector product. The page
 * is then empty, and `total` is 0.
 */
export const VendorConnectorCatalogResponseSchema = paginatedResponseSchema(
  VendorConnectorListingSchema,
).extend({
  product_id: z.string().uuid(),
  catalog: VendorConnectorCatalogSummarySchema.nullable(),
});
export type VendorConnectorCatalogResponse = z.infer<typeof VendorConnectorCatalogResponseSchema>;
