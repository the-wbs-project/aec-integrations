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
 * A claim's computed agreement state (§3.4 — AECI-300; widened by
 * `STAGE_2_ATTESTATIONS_SPEC.md` §4 — AECI-605). Derived on read from the
 * attestation set by `computeAgreement`, never stored (ADR 0018). Only
 * `unverified` is reachable until the Stage 2 portal (AECI-301) lets vendors
 * attest; `confirmed` additionally requires **two distinct vendor identities**,
 * so a lone affirmation reads `single_source` instead.
 */
export const AgreementStateSchema = z.enum(AGREEMENT_STATES);
// The `AgreementState` *type* is canonical in `../agreement` (the compute
// engine owns it); this schema is its runtime mirror for the pair contract.

/**
 * One attestation surfaced on a claim (§3.3), for the annotated provenance
 * affordance (§8). Only live attestations appear — the read path filters
 * `retracted_at IS NULL`, so a withdrawn assertion neither votes nor renders.
 * The `introduced_at`/`deprecated_at` version stamps ride dormant for the
 * Stage 2 timeline (AECI-303) and are **not** retraction.
 *
 * `attestor` is the slot translated into the page's context frame by
 * `attestorForContext` (`STAGE_2_ATTESTATIONS_SPEC.md` §4.3) — the browser
 * renders it verbatim against the response's two `ProductListItem.vendor`
 * links, and never re-derives which endpoint is which. The raw
 * `attested_by_vendor_id` is deliberately **not** exposed: attribution is a
 * display concern, and the reader has no use for an internal vendor UUID.
 */
export const PairClaimAttestationSchema = z.object({
  source: z.enum(ATTESTATION_SOURCES),
  attestor: z.enum(['aeci', 'context', 'other']),
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
 * The sync headline (§3.5, widened by `STAGE_2_ATTESTATIONS_SPEC.md` §4.3).
 * `total` = distinct claims on the pair (all directions, all mechanisms);
 * `confirmed` = claims two distinct vendors affirm; `single_source` = claims
 * exactly one vendor affirms with the counterparty silent. The two counts stay
 * separate because the headline may never fold a one-sided assertion into the
 * bilateral figure. Filled from the ingested claims by `computeSyncHeadline`;
 * both are `0` until the Stage 2 portal, and `total` is `0` for an
 * unseeded/empty pair.
 *
 * `single_source` carries `.default(0)` so an SSR Worker running this schema
 * still parses a response from an API Worker that predates the field — the two
 * deploy per-commit but not atomically (same reason `claims` uses `.default([])`).
 */
export const SyncHeadlineSchema = z.object({
  total: z.number().int().min(0),
  confirmed: z.number().int().min(0),
  single_source: z.number().int().min(0).default(0),
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
