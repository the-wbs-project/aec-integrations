import { z } from 'zod';

import { HttpsUrlSchema } from './https-url';

/**
 * Per-side integration links (AECI-1007 / ADR 0035 decision 6 /
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.7).
 *
 *   PUT    /api/vendor/integrations/:id/links/:productId/:kind — set one link (200).
 *   DELETE /api/vendor/integrations/:id/links/:productId/:kind — remove it (200).
 *
 * Each endpoint vendor stores its OWN listing and docs links on an integration,
 * beside the other side's. Four rules the shapes encode:
 *
 * 1. **A side is an endpoint PRODUCT, never a position.** The path names the
 *    product the link speaks for, not `a`/`b` or source/target. Promote swaps
 *    source and target in bulk (AECI-920's direction corrections), so a positional
 *    key would silently hand one vendor's link to the other. A product id cannot.
 * 2. **The caller must own that product** (`product_vendors`). Ownership of the
 *    integration is not required, and a claim is not required either.
 * 3. **Web links, never routes, never permissions.** A stored URL is rendered as an
 *    external `href` and nothing reads it to decide anything.
 * 4. **A seat is the whole gate** (decision 15). No capability, no entitlement.
 *
 * i18n note: framework-agnostic package (no `$localize`).
 */

export const INTEGRATION_LINK_KINDS = ['listing', 'docs'] as const;
export const IntegrationLinkKindSchema = z.enum(INTEGRATION_LINK_KINDS);
export type IntegrationLinkKind = z.infer<typeof IntegrationLinkKindSchema>;

/** The `PUT` body. `.strict()` so a stray field is a 400 rather than ignored. */
export const PutIntegrationLinkSchema = z.object({ url: HttpsUrlSchema }).strict();
export type PutIntegrationLinkInput = z.infer<typeof PutIntegrationLinkSchema>;

/** One endpoint's two links. `null` means that side has not set that kind. */
export const IntegrationSideLinksSchema = z.object({
  listing_url: z.string().url().nullable(),
  docs_url: z.string().url().nullable(),
});
export type IntegrationSideLinks = z.infer<typeof IntegrationSideLinksSchema>;

export const EMPTY_SIDE_LINKS: IntegrationSideLinks = { listing_url: null, docs_url: null };

/** Both write routes answer with the side as it now stands. */
export const IntegrationLinkResponseSchema = z.object({
  integration_id: z.string().uuid(),
  product_id: z.string(),
  links: IntegrationSideLinksSchema,
});
export type IntegrationLinkResponse = z.infer<typeof IntegrationLinkResponseSchema>;

/**
 * The pair page's view of both sides, framed to the page's context product like
 * every other pair field. `null` on a side that has set neither link.
 */
export const PairVendorLinksSchema = z.object({
  context: IntegrationSideLinksSchema.nullable(),
  other: IntegrationSideLinksSchema.nullable(),
});
export type PairVendorLinks = z.infer<typeof PairVendorLinksSchema>;

export const EMPTY_PAIR_VENDOR_LINKS: PairVendorLinks = { context: null, other: null };
