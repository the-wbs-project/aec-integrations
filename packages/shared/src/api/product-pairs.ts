import { z } from 'zod';

import { ProductLinkSchema, VendorLinkSchema } from './common';
import { IntegrationMechanismKindSchema } from './integrations';
import { ProductListItemSchema } from './products';

/**
 * Product-PAIR page contract (Stage 1.5 §7 — AECI-294). The pair page
 * consolidates every integration between two products into one
 * context-oriented view served at `/products/:contextSlug/integrations/:otherSlug`
 * and read via `GET /api/products/:slug/integrations/:otherSlug`.
 *
 * This is **Layer A**: the shell + mechanisms, no claim/data-flow rows. The
 * `data_object`-level claims (§8) and the real `sync_headline` ratio land with
 * Layer B (AECI-300); the fields are present here so the contract is stable and
 * Layer B only fills them in.
 */

/**
 * Direction of a mechanism (or, in Layer B, a claim) **relative to the page's
 * context product** (§3.2). The stored integration/claim direction is canonical
 * to the row's own endpoints; the API translates it into the visitor's frame
 * before it leaves the Worker (the browser never re-derives it). `outbound` =
 * flows from the context product to the other; `inbound` = the reverse; `both`
 * = bidirectional.
 */
export const ContextDirectionSchema = z.enum(['outbound', 'inbound', 'both']);

export type ContextDirection = z.infer<typeof ContextDirectionSchema>;

/**
 * One integration (mechanism) row on the pair page. Mirrors the integration
 * detail shape minus the redundant source/target links (both products are
 * already the page's two endpoints), and with `direction` translated to the
 * context product's frame (§3.2) instead of the stored `one-way`/`bidirectional`.
 * `claims[]` are added in Layer B (AECI-300); this Layer-A shape omits them.
 */
export const ProductPairMechanismSchema = z.object({
  id: z.string().uuid(),
  mechanism_kind: IntegrationMechanismKindSchema.nullable(),
  mechanism_name: z.string().nullable(),
  // Context-relative arrow for the mechanism card (§7). `null` when the
  // integration's stored `direction` column is null (AECI-115) — the card
  // renders a neutral "connects" state rather than fabricating a direction.
  direction: ContextDirectionSchema.nullable(),
  description: z.string().nullable(),
  listing_url: z.string().url().nullable(),
  docs_url: z.string().url().nullable(),
  built_by_vendor: VendorLinkSchema.nullable(),
  powered_by_product: ProductLinkSchema.nullable(),
});

export type ProductPairMechanism = z.infer<typeof ProductPairMechanismSchema>;

/**
 * The `confirmed / total` sync headline (§3.5). `total` = distinct claims on the
 * pair; `confirmed` = claims whose computed agreement is vendor-confirmed. In
 * Layer A there are no claims, so both are `0` and the page renders its empty
 * headline; Layer B (AECI-300) fills these from the ingested claims.
 */
export const SyncHeadlineSchema = z.object({
  total: z.number().int().min(0),
  confirmed: z.number().int().min(0),
});

export type SyncHeadline = z.infer<typeof SyncHeadlineSchema>;

/**
 * Response for `GET /api/products/:slug/integrations/:otherSlug`. Both products
 * are hydrated as `ProductListItem` (vendor, logo, review recap) so the rail
 * renders without a second fetch. `mechanisms` is `[]` for a valid-but-empty
 * pair (both products exist, no integration between them) — a 200, not a 404.
 */
export const ProductPairResponseSchema = z.object({
  context_product: ProductListItemSchema,
  other_product: ProductListItemSchema,
  mechanisms: z.array(ProductPairMechanismSchema),
  sync_headline: SyncHeadlineSchema,
});

export type ProductPairResponse = z.infer<typeof ProductPairResponseSchema>;
