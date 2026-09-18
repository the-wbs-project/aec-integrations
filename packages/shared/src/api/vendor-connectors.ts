import { z } from 'zod';

import { ProductLinkSchema } from './common';
import { ProductIntegrationItemSchema } from './integrations';

/**
 * The connectors that reach one owned product
 * (`GET /api/vendor/products/:id/connectors`, AECI-1013 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.13), behind `requireVendor()` plus the
 * product-ownership check. Read-only: connector-powered edges are out of scope
 * for vendor editing, creating and retiring.
 *
 * Two tiers, kept apart on the wire so the client can never merge them
 * (`STAGE_1_5_SPEC.md` §13.1):
 *
 * - **`delivered`** — rows of `connector_evidenced_pairs` where this connector
 *   ships a listing covering both sides. The same `ProductIntegrationItem` the
 *   public product page renders, framed against the owned product, with `via`
 *   always equal to the group's `connector`.
 * - **`reachable`** — partner products that sit in the same connector catalogue
 *   as the owned product, so a connector COULD join them with configuration. It
 *   asserts no delivery, and a partner already delivered by ANY path (either
 *   delivered table, either orientation) is left out, which is §13.7's "N more"
 *   rule applied per connector.
 *
 * `catalog_as_of` is the catalogue's latest `connector_catalog_surfaces.
 * last_ingested_at` — §13.1's "as of" label on every reachable claim. `null`
 * when the connector has no catalogue here (delivered rows only) or no surface
 * has been ingested.
 *
 * Nothing here links out to a connector's own pages: most reachable pairs are
 * `derived`, and a `derived` pair has no vendor page to cite (§13.7).
 *
 * i18n note: framework-agnostic package (no `$localize`).
 */
export const VendorProductConnectorSchema = z.object({
  connector: ProductLinkSchema,
  catalog_as_of: z.string().nullable(),
  delivered: z.array(ProductIntegrationItemSchema),
  reachable: z.array(ProductLinkSchema),
});

export type VendorProductConnector = z.infer<typeof VendorProductConnectorSchema>;

export const VendorProductConnectorsResponseSchema = z.object({
  product_id: z.string().uuid(),
  connectors: z.array(VendorProductConnectorSchema),
});

export type VendorProductConnectorsResponse = z.infer<typeof VendorProductConnectorsResponseSchema>;
