import { z } from 'zod';

import { AGREEMENT_STATES } from '../agreement';
import { VERSION_DIFF_ACCESS, VERSION_STATUSES } from '../version-diff';
import { MaintenanceSchema, ProductLinkSchema, VendorLinkSchema } from './common';
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
  /**
   * The PRECISE version stamps (AECI-303 / §8.2), as the vendor's own release
   * **label** — the same value the selectors put in the URL. Present only when the
   * attestation carries the corresponding `*_version_id` FK, which today means a
   * vendor authored it through `/api/vendor/claims/:claimId/attestation`; promote
   * writes the coarse ISO dates above instead (§11).
   *
   * **`.optional()`, deliberately asymmetric with the sibling
   * `introduced_at: z.string().nullable()`.** `null` there is the legacy spelling;
   * here, absent is the ONE spelling of "no stamp", so an unstamped attestation
   * serialises exactly as it did before this field existed. A stamp whose version
   * row was deleted degrades to absent too — `ON DELETE SET NULL` keeps the
   * assertion and drops the stamp (§8.2), which lands the claim back on the
   * "no version data ⇒ always present" baseline.
   */
  introduced_version: z.string().optional(),
  deprecated_version: z.string().optional(),
});

export type PairClaimAttestation = z.infer<typeof PairClaimAttestationSchema>;

/**
 * One selectable release of one endpoint product (AECI-303 / §9.1).
 *
 * Carries the label and nothing else identifying: **no `id` and no `sort_key`.**
 * The API has already ordered these lists and resolved every comparison, so the
 * browser has nothing to compare — and exposing `sort_key` would invite it to,
 * which is exactly the "never expose an ordering derived from the label" rule
 * §8.2 writes down. Same discipline as withholding `attested_by_vendor_id`.
 *
 * `released_at` is display-only ("2026.1 · January 2026"). It is **never** an
 * ordering input: it is nullable, and §8.2 forbids it.
 */
export const PairVersionSchema = z.object({
  label: z.string(),
  released_at: z.string().nullable(),
});

export type PairVersion = z.infer<typeof PairVersionSchema>;

/**
 * A claim's state for the selected version pair (§9.1). The `VersionStatus` *type*
 * is canonical in `../version-diff` (the compute engine owns it); this is its
 * runtime mirror, the same relationship `AgreementStateSchema` has with
 * `../agreement`.
 */
export const VersionStatusSchema = z.enum(VERSION_STATUSES);

/** How much historical diff depth the reader may see (§9.3). */
export const VersionDiffAccessSchema = z.enum(VERSION_DIFF_ACCESS);

/** One side of a version pair, by label. `null` = that product has no releases. */
const SelectedVersionPairSchema = z.object({
  context: z.string().nullable(),
  other: z.string().nullable(),
});

/**
 * The two version selectors' state (AECI-303 / §9).
 *
 * `ProductPairResponse.version_diff` is **`null`** whenever the diff does not
 * apply — neither endpoint product has a release, or no live attestation on the
 * pair carries a version stamp. A gated pair (neither endpoint vendor entitled,
 * AECI-304) instead answers with the selection clamped to latest × latest and
 * `diff_access: 'latest_only'`; the SSR resolver degrades that to the same `null`
 * only if it ever receives un-clamped depth from an older API Worker.
 * That null is the entire suppression rule: the browser renders no selectors, no
 * markers and no summary, which is what makes "latest × latest renders identically
 * to today for claims with no version data" a structural guarantee rather than a
 * rendering discipline. Both facts behind it are server-side only, which is why
 * the decision is not left to the client.
 */
export const PairVersionDiffSchema = z.object({
  /**
   * Each product's releases, **ascending** by the one ordering primitive
   * (`compareProductVersions` / the API's `VERSION_ORDER`). The selector reverses
   * for display — newest first reads better — but the wire order is the canonical
   * one, so "latest" is always the last element and the browser never re-derives it.
   */
  context_versions: z.array(PairVersionSchema).default([]),
  other_versions: z.array(PairVersionSchema).default([]),
  /**
   * What the server actually RESOLVED, which is not always what the URL asked for:
   * an unknown or renamed label degrades to latest rather than 404-ing a pair that
   * exists. The browser renders this, never the raw query param.
   */
  selected: SelectedVersionPairSchema,
  /**
   * The version pair the diff is measured against — each side stepped back one
   * release independently (§9.1 leaves this undefined; `previousVersionPair` is the
   * definition). `null` when NEITHER side has a predecessor, i.e. the earliest
   * pair, where every present claim reads `unchanged`.
   */
  previous: SelectedVersionPairSchema.nullable().default(null),
  /**
   * Is the RESOLVED selection latest × latest? Drives the pair resolver's
   * `noindex` (§9.2), so it is deliberately about the resolution and not the
   * request: a garbage label serves canonical content and stays indexable, with
   * the query-stripped canonical already deduping the URL.
   */
  is_default: z.boolean(),
  /** For the data-flow band's "2 added · 1 removed" line. */
  counts: z
    .object({ added: z.number().int().min(0), removed: z.number().int().min(0) })
    .default({ added: 0, removed: 0 }),
  /**
   * §9.3's seam, as **data**. `STAGE_2_SPEC.md` §2.2 requires entitlements to be
   * "data, not code branches scattered across the app", so the reader's depth
   * arrives as one enum the render path switches on. `.default('full')` covers an
   * API Worker that predates the seam.
   */
  diff_access: VersionDiffAccessSchema.default('full'),
});

export type PairVersionDiff = z.infer<typeof PairVersionDiffSchema>;

/**
 * One `data_object` claim on a mechanism (Layer B — §8). Identity is the triple
 * `(integration, data_object, direction)` (§3.1); the API exposes the
 * `data_object` name/slug, the `direction` already translated to the context
 * product's frame (§3.2), the computed `agreement` (§3.4), and the attestations
 * behind it (provenance). The browser renders this verbatim — it never
 * re-derives direction or agreement.
 */
export const ProductPairClaimSchema = z.object({
  /**
   * The claim's own id — the join key for the per-claim timeline read
   * (`GET …/integrations/:otherSlug/timeline`, AECI-303 / §9.1). The composite
   * `(mechanism id, data_object_slug, direction)` would also identify it, but a
   * `Map<string, …>` beats a three-part template key and this exposes nothing new
   * in kind: `ProductPairMechanismSchema.id` is already an integration UUID on the
   * wire, and AECI-604 guarantees claim ids survive a re-promote.
   *
   * `.optional()` for the non-atomic SSR/API deploy: against an older API the SSR
   * Worker simply has no join key, so it hides the history affordance rather than
   * requesting a timeline it cannot match up.
   */
  id: z.string().uuid().optional(),
  data_object_slug: z.string(),
  data_object_name: z.string(),
  direction: ContextDirectionSchema,
  agreement: AgreementStateSchema,
  attestations: z.array(PairClaimAttestationSchema),
  /**
   * `added` / `removed` / `unchanged` for the selected version pair (§9.1).
   * **Absent** when no version comparison applies — which is every claim on every
   * pair whose `version_diff` is `null`, i.e. the whole catalog until a vendor
   * authors releases. Absent rather than `null` so an unstamped claim serialises
   * exactly as it did before this field existed.
   *
   * A `removed` claim IS in `claims[]` — it is absent at the selection but present
   * at the previous pair, so the reader needs to see it struck through. It is
   * excluded from `sync_headline` (see that schema), because "N data objects sync"
   * must not count a flow that no longer does. A claim present at NEITHER pair
   * belongs to an earlier era and is dropped from the response entirely.
   */
  version_status: VersionStatusSchema.optional(),
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
 *
 * **Claims whose `version_status` is `removed` are excluded from all three counts**
 * (AECI-303 / §9.1). They still render — struck through, as "no longer flows" — but
 * a headline reading "N data objects sync" must not count a flow that has stopped.
 * The filter lives at the single `computeSyncHeadline` call site in
 * `toProductPairResponse`, not inside the shared engine, which stays a pure
 * function of `{ agreement }` and owes the diff contract nothing.
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
  /**
   * The page header's maintenance marker (AECI-616), aggregated across every
   * mechanism on the pair by `computePairMaintenance` — a pair has N mechanisms but
   * one header.
   *
   * Deliberately NOT per-mechanism on {@link ProductPairMechanismSchema}: the marker
   * answers "who is on the hook for this page", which is a page-level question, and a
   * chip on every mechanism card would compete with the per-claim agreement badge
   * that already lives there.
   */
  maintenance: MaintenanceSchema.default({ maintained_by: 'aeci', last_reviewed_at: null }),
  /**
   * The two version selectors and the diff they describe (AECI-303 / §9), or
   * **`null`** when the diff does not apply — see {@link PairVersionDiffSchema} for
   * the exact condition. `.default(null)` so an SSR Worker on this schema still
   * parses a response from an API Worker that predates the field.
   */
  version_diff: PairVersionDiffSchema.nullable().default(null),
});

export type ProductPairResponse = z.infer<typeof ProductPairResponseSchema>;

/**
 * One row of a claim's history (AECI-303 / §9.1), read off the **append-only**
 * attestation rows: §2.1's supersession is retract-then-insert, never an in-place
 * `UPDATE`, precisely so this read has something to show.
 *
 * This is the one shape in the contract that deliberately surfaces **retracted**
 * rows — `retracted_at` non-null means the row was superseded by a later
 * assertion. Every other read filters them out (`liveAttestationsWhere`), because
 * a withdrawn assertion must neither vote nor render as current. Never call
 * `computeAgreement` on these.
 */
export const ClaimTimelineEntrySchema = z.object({
  attestor: z.enum(['aeci', 'context', 'other']),
  asserted: z.boolean(),
  note: z.string().nullable(),
  /** Version labels, as on {@link PairClaimAttestationSchema}. */
  introduced_version: z.string().optional(),
  deprecated_version: z.string().optional(),
  /** The append-only ordering key. Entries arrive oldest-first. */
  created_at: z.string(),
  /** Non-null = superseded. This is what makes the row history rather than state. */
  retracted_at: z.string().nullable(),
});

export type ClaimTimelineEntry = z.infer<typeof ClaimTimelineEntrySchema>;

export const ClaimTimelineSchema = z.object({
  claim_id: z.string().uuid(),
  entries: z.array(ClaimTimelineEntrySchema),
});

export type ClaimTimeline = z.infer<typeof ClaimTimelineSchema>;

/**
 * Response for `GET /api/products/:slug/integrations/:otherSlug/timeline`.
 *
 * Pair-scoped rather than claim-scoped so one fetch serves every provenance
 * popover on the page. Deliberately a **separate, lazy** read rather than inline on
 * the pair response: history is the gateable depth (§9.3), and the pair page is
 * stored in a shared, URL-keyed edge cache. AECI-304 kept that gate URL-derived — it
 * reads the PAIR'S two endpoint vendors, never the reader — so `STAGE_1_SPEC.md`
 * §9.1a holds. The separation stands anyway: an `/api/*` response is
 * `private, no-store`, and this is the only unbounded payload in the system, since
 * the append-only log grows forever.
 *
 * Gated ⇒ `{ claims: [], diff_access: 'latest_only' }` — i.e. neither endpoint vendor
 * holds `'integration.version_diff'`. The latest state is already rendered in full on
 * the free page, so withholding *history* is exactly what §8.1(4) permits and no more.
 */
export const PairTimelineResponseSchema = z.object({
  claims: z.array(ClaimTimelineSchema).default([]),
  diff_access: VersionDiffAccessSchema.default('full'),
});

export type PairTimelineResponse = z.infer<typeof PairTimelineResponseSchema>;
