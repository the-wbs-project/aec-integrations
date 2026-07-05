import { z } from 'zod';

import { AGREEMENT_STATES } from '../agreement';
import { ProductLinkSchema, VendorLinkSchema } from './common';
import { ContextDirectionSchema, IntegrationMechanismKindSchema } from './integrations';
import { ProductListItemSchema } from './products';
import { ATTESTATION_SOURCES } from './promote';

/**
 * Product-PAIR page contract (Stage 1.5 §7 — AECI-294). The pair page
 * consolidates every integration between two products into one
 * context-oriented view served at `/products/:contextSlug/integrations/:otherSlug`
 * and read via `GET /api/products/:slug/integrations/:otherSlug`.
 *
 * Layer A (AECI-294) shipped the shell + mechanisms; **Layer B (AECI-300)**
 * adds the `data_object`-level `claims[]` on each mechanism (§8) — each with a
 * context-relative direction and computed agreement — and the real
 * `sync_headline` ratio (§3.5) derived from those claims.
 */

// `ContextDirectionSchema` / `ContextDirection` moved to `./integrations` (its
// conceptual home — integration/claim direction) so the product-detail table can
// reference it without a `products → product-pairs → products` import cycle. It
// is still re-exported from the package barrel via `./integrations`.

/**
 * A claim's computed agreement state (§3.4 — AECI-300). Derived on read from the
 * attestation set by `computeAgreement`, never stored (ADR 0018). Only
 * `unverified` is reachable in Stage 1.5 (AECi-only attestations, the
 * AECi-never-red rule); `confirmed`/`conflict` arrive with the Stage 2 portal.
 */
export const AgreementStateSchema = z.enum(AGREEMENT_STATES);
// The `AgreementState` *type* is canonical in `../agreement` (the compute
// engine owns it); this schema is its runtime mirror for the pair contract.

/**
 * One attestation surfaced on a claim (§3.3), for the AECi-annotated provenance
 * affordance (§8). In Stage 1.5 only the `aeci` source is ever present; the
 * `introduced_at`/`deprecated_at` version stamps ride dormant for the Stage 2
 * timeline (AECI-303).
 */
export const PairClaimAttestationSchema = z.object({
  source: z.enum(ATTESTATION_SOURCES),
  asserted: z.boolean(),
  note: z.string().nullable(),
  introduced_at: z.string().nullable(),
  deprecated_at: z.string().nullable(),
});

export type PairClaimAttestation = z.infer<typeof PairClaimAttestationSchema>;

/**
 * One `data_object` claim on a mechanism (Layer B — §8). Identity is the triple
 * `(integration, data_object, direction)` (§3.1); the API exposes the
 * `data_object` name/slug, the `direction` already translated to the context
 * product's frame (§3.2), the computed `agreement` (§3.4), and the attestations
 * behind it (provenance). The browser renders this verbatim — it never
 * re-derives direction or agreement.
 */
export const ProductPairClaimSchema = z.object({
  data_object_slug: z.string(),
  data_object_name: z.string(),
  direction: ContextDirectionSchema,
  agreement: AgreementStateSchema,
  attestations: z.array(PairClaimAttestationSchema),
});

export type ProductPairClaim = z.infer<typeof ProductPairClaimSchema>;

/**
 * One integration (mechanism) row on the pair page. Mirrors the integration
 * detail shape minus the redundant source/target links (both products are
 * already the page's two endpoints), and with `direction` translated to the
 * context product's frame (§3.2) instead of the stored `one-way`/`bidirectional`.
 * `claims[]` are the `data_object`-level flows on this mechanism (Layer B —
 * AECI-300), each with a context-relative direction + computed agreement.
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
  // Data-object claims on this mechanism (§8). `[]` for a mechanism with no
  // claims yet (Layer A / pre-AECI-299 seeding); `.default([])` keeps parsing
  // lenient for callers that predate Layer B while the output type carries it.
  claims: z.array(ProductPairClaimSchema).default([]),
});

export type ProductPairMechanism = z.infer<typeof ProductPairMechanismSchema>;

/**
 * The `confirmed / total` sync headline (§3.5). `total` = distinct claims on the
 * pair (all directions, all mechanisms); `confirmed` = claims whose computed
 * agreement is vendor-confirmed. Filled from the ingested claims by Layer B via
 * `computeSyncHeadline`; `confirmed` is `0` for every pair in Stage 1.5 (no
 * vendor attestations), and `total` is `0` for an unseeded/empty pair.
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
