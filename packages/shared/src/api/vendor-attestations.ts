import { z } from 'zod';

import { AGREEMENT_STATES } from '../agreement';
import { ProductLinkSchema } from './common';
import { ContextDirectionSchema, IntegrationMechanismKindSchema } from './integrations';
import type { AttestationSource } from './promote';

/**
 * Vendor attestation authoring contracts (AECI-301 /
 * `STAGE_2_ATTESTATIONS_SPEC.md` §5), behind `requireVendor()` plus the
 * authority + Verified checks in `apps/api/src/routes/vendor-attestations.ts`:
 *
 *   GET    /api/vendor/integrations                    — the attestable surface.
 *   POST   /api/vendor/claims                          — create a claim + affirm it.
 *   PUT    /api/vendor/claims/:claimId/attestation     — assert or deny.
 *   DELETE /api/vendor/claims/:claimId/attestation     — retract (204).
 *
 * Source of truth: `STAGE_2_ATTESTATIONS_SPEC.md` §5, `API_CONTRACTS.md` §6.14.
 *
 * ⚠️ **"Claim" is overloaded three ways in this codebase.** Here it is a
 * *data-flow claim* — "this `data_object` flows in this `direction` through this
 * integration" (`STAGE_1_5_SPEC.md` §3.1). It is NOT the public correction/claim
 * *request* (`./requests.ts`) and NOT the vendor-account *claim* an admin grants
 * (`./admin-claims.ts`).
 *
 * Four things these schemas encode:
 *
 * 1. **No vendor id and no slot on any write shape.** Which `attestations.source`
 *    slot the caller may fill is derived server-side from product ownership
 *    (`lib/attestation-authority.ts`, §2.1), never from the request — the
 *    AECI-520 `vendor_id`-scoping invariant extended to a two-slot model. `slot`
 *    appears on the READ only, as "which one is yours".
 * 2. **Direction is caller-relative on the wire, canonical in the DB.** The
 *    vendor speaks `inbound`/`outbound`/`both`; `claims.direction` stores
 *    `a_to_b`/`b_to_a`/`both` relative to the integration row's own endpoints
 *    (§3.2). `claimDirectionForContext` / `claimDirectionFromContext`
 *    (`../integration-context`) are the two halves of that translation.
 * 3. **`data_object` is find-only.** A free string resolved against the frozen
 *    `taxonomy_data_objects` vocabulary by slug or alias
 *    (`docs/DATA_OBJECT_VOCABULARY.md`). A vendor cannot mint a term; an
 *    unmatched one is a `400 VALIDATION_FAILED` naming the field, not a silent
 *    drop (promote's `skipped[]` behaviour is for a batch job, not an
 *    interactive caller).
 * 4. **`agreement` is computed and echoed, never sent.** Both writes return the
 *    claim's recomputed state so the dashboard never re-derives `computeAgreement`
 *    client-side — and so a lone affirmation visibly lands on `single_source`
 *    rather than looking like agreement (§4.2, the §8.1(4) invariant).
 *
 * i18n note: this package is framework-agnostic (no `$localize`) — the messages
 * below are for API consumers / logs; the Angular dashboard renders its own copy.
 */

// ─── Field primitives ────────────────────────────────────────────────────────

/**
 * A vendor's free-text qualifier on its attestation ("only for RFIs created
 * after 2025"). Same 2000-character ceiling as the editable long-text fields on
 * `./vendor.ts`; it renders in the pair page's provenance disclosure, so it is a
 * sentence or two, not a document.
 */
const attestationNote = z.string().trim().max(2000);

/**
 * A `data_object` reference — a slug or any of its seeded aliases. Free text
 * because the vocabulary owns the matching (case and spacing are normalized
 * server-side by the same `safeSlugify` promote uses), NOT because a vendor may
 * invent one. The §6 dashboard should offer the closed list rather than a text
 * input in the first place.
 */
const dataObjectRef = z.string().trim().min(1).max(100);

/** A `product_versions.id`. Its authority is checked server-side (§8.2): the
 *  version must belong to the endpoint product of the slot it stamps. */
const versionId = z.string().uuid();

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * The two vendor-writable `attestations.source` values — `ATTESTATION_SOURCES`
 * minus the `aeci` seed, which no vendor may ever write. Declared here rather
 * than in the Worker so the wire contract and `lib/attestation-authority.ts`
 * cannot drift apart: that module imports this tuple.
 *
 * `vendor_a` is the integration's endpoint A (`source_product_id`), `vendor_b`
 * its endpoint B (`target_product_id`) — `STAGE_1_5_SPEC.md` §3.2/§3.3.
 */
export const VENDOR_ATTESTATION_SLOTS = [
  'vendor_a',
  'vendor_b',
] as const satisfies readonly AttestationSource[];

export type VendorAttestationSlot = (typeof VENDOR_ATTESTATION_SLOTS)[number];

export const VendorAttestationSlotSchema = z.enum(VENDOR_ATTESTATION_SLOTS);

/**
 * Claim provenance (§2.2). `vendor` means a vendor created the claim through
 * this surface; `aeci` means promote seeded it. It exists for **write
 * arbitration** — §3 scopes promote's deletes on it — and for the AECi ops view.
 * It is deliberately **not** a reader-facing trust badge: a vendor-created claim
 * renders through the same agreement states as an AECi-seeded one.
 */
export const CLAIM_ORIGINS = ['aeci', 'vendor'] as const;

export const ClaimOriginSchema = z.enum(CLAIM_ORIGINS);

export type ClaimOrigin = z.infer<typeof ClaimOriginSchema>;

// ─── Entity shapes ───────────────────────────────────────────────────────────

/**
 * One of the caller's own live attestations, per slot. A vendor owning **both**
 * endpoints of an integration gets two entries — its write fills every slot it
 * owns (§2.1), which is why this is an array rather than a single object.
 *
 * Retracted rows never appear: the read filters `retracted_at IS NULL`, exactly
 * as the public pair page does.
 */
export const VendorOwnAttestationSchema = z.object({
  slot: VendorAttestationSlotSchema,
  asserted: z.boolean(),
  note: z.string().nullable(),
  introduced_version_id: z.string().uuid().nullable(),
  deprecated_version_id: z.string().uuid().nullable(),
  updated_at: z.string().datetime(),
});

export type VendorOwnAttestation = z.infer<typeof VendorOwnAttestationSchema>;

/**
 * The counterparty vendor's live position on the claim, deliberately reduced to
 * stance + note. §6 requires a conflict to be legible from the vendor's side
 * with the other party's position shown; it does not require — and must not
 * leak — the counterparty's version stamps or its `attested_by_vendor_id`. The
 * note is already public on the pair page's provenance disclosure, so surfacing
 * it here reveals nothing new.
 *
 * `null` when the counterparty slot is empty. That silence is the whole point of
 * `single_source`: absence of an attestation is never rendered as agreement
 * (`STAGE_2_SPEC.md` §8.1(4)).
 */
export const CounterpartyAttestationSchema = z.object({
  asserted: z.boolean(),
  note: z.string().nullable(),
});

export type CounterpartyAttestation = z.infer<typeof CounterpartyAttestationSchema>;

/**
 * One data-flow claim as its own vendor sees it. `direction` is already
 * translated into the caller's frame and `agreement` is already computed — the
 * dashboard renders both verbatim.
 *
 * `data_object_slug` / `data_object_name` are flat, matching
 * `ProductPairClaimSchema`, so the two surfaces read the same way.
 */
export const VendorClaimSchema = z.object({
  id: z.string().uuid(),
  integration_id: z.string().uuid(),
  data_object_slug: z.string(),
  data_object_name: z.string(),
  /** Relative to `VendorIntegration.context_product`, never to the DB's A/B. */
  direction: ContextDirectionSchema,
  agreement: z.enum(AGREEMENT_STATES),
  origin: ClaimOriginSchema,
  /** The caller's own live attestations — `[]` when it has not voted. */
  mine: z.array(VendorOwnAttestationSchema),
  counterparty: CounterpartyAttestationSchema.nullable(),
});

export type VendorClaim = z.infer<typeof VendorClaimSchema>;

/**
 * One integration the caller may attest on. `context_product` /
 * `other_product` borrow the pair page's vocabulary: the context is the caller's
 * own endpoint (endpoint **A** when it owns A, including the owns-both case),
 * and every `direction` on the claims below is framed against it.
 *
 * `slots` is the answer to "which slot is mine" — one entry normally, two when
 * the caller owns both endpoints. It is never empty: an integration only appears
 * here because the caller owns at least one endpoint.
 */
export const VendorIntegrationSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  mechanism_kind: IntegrationMechanismKindSchema.nullable(),
  mechanism_name: z.string().nullable(),
  context_product: ProductLinkSchema,
  other_product: ProductLinkSchema,
  slots: z.array(VendorAttestationSlotSchema).min(1),
  claims: z.array(VendorClaimSchema),
});

export type VendorIntegration = z.infer<typeof VendorIntegrationSchema>;

// ─── GET /api/vendor/integrations ────────────────────────────────────────────

/**
 * The caller's whole attestable surface. A bare object, **never paginated** —
 * same posture as `GET /api/vendor/me`'s product list and the product-version
 * list: the set is bounded by the vendor's own catalog, not by the site's.
 */
export const ListVendorIntegrationsResponseSchema = z.object({
  integrations: z.array(VendorIntegrationSchema),
});

export type ListVendorIntegrationsResponse = z.infer<typeof ListVendorIntegrationsResponseSchema>;

// ─── POST /api/vendor/claims ─────────────────────────────────────────────────

/**
 * Create a data-flow claim and the caller's affirming attestation, in one batch.
 *
 * `integration_id` is the only client-supplied id that decides authority, and it
 * is proven against `product_vendors` before anything is read or written — a
 * miss is a **404**, never a 403.
 *
 * There is no `asserted` field: creating a claim IS affirming it. A vendor that
 * wants to record a denial is denying a claim that already exists, which is what
 * `PUT` is for.
 */
export const CreateVendorClaimSchema = z.object({
  integration_id: z.string().uuid(),
  data_object: dataObjectRef,
  /** Caller-relative. Translated to `a_to_b`/`b_to_a`/`both` server-side. */
  direction: ContextDirectionSchema,
  note: attestationNote.nullable().optional(),
  introduced_version_id: versionId.nullable().optional(),
  deprecated_version_id: versionId.nullable().optional(),
});

export type CreateVendorClaimInput = z.infer<typeof CreateVendorClaimSchema>;

// ─── PUT /api/vendor/claims/:claimId/attestation ─────────────────────────────

/**
 * Assert or deny — replace the caller's attestation on every slot it owns.
 *
 * **This is a PUT, and the absent-leaves-alone convention of the `/api/vendor/*`
 * PATCH shapes deliberately does NOT apply.** Supersession is retract-then-insert
 * (§2.1), so there is no prior row to leave a field alone on: an omitted `note`
 * or version stamp lands as `null` on the new row. Send the whole position every
 * time.
 */
export const UpsertVendorAttestationSchema = z.object({
  asserted: z.boolean(),
  note: attestationNote.nullable().optional(),
  introduced_version_id: versionId.nullable().optional(),
  deprecated_version_id: versionId.nullable().optional(),
});

export type UpsertVendorAttestationInput = z.infer<typeof UpsertVendorAttestationSchema>;

/** `POST` and `PUT` both echo the claim's post-write state, agreement included. */
export const VendorClaimResponseSchema = z.object({ claim: VendorClaimSchema });

export type VendorClaimResponse = z.infer<typeof VendorClaimResponseSchema>;
