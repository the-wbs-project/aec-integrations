/**
 * Drizzle query configs + mappers for the READ paths (ADR 0016 / AECI-253).
 * The D1 successor to the read surface of `prisma-helpers.ts`:
 *
 *   1. **Query configs** — `productListConfig`, `vendorListConfig`, … objects
 *      spread into `db.query.<table>.findMany({ ...config, where, orderBy })`.
 *      `columns`/`with` mirror the old Prisma `select`; `_count` becomes an
 *      `extras` correlated-subquery so list rows carry their counts without
 *      over-fetching join rows.
 *
 *   2. **Mappers** — `toProductListItem`, … convert the Drizzle row to the public
 *      `@aeci/shared` wire shape. Two old conversions are now near-identity and
 *      gone: D1 `real` columns are already `number` (no Prisma `Decimal`), and
 *      `*_at` columns are already ISO-8601 `text` (no `Date`). The fail-loud
 *      coalescing rules (AECI-115) are preserved verbatim.
 *
 * Raw row shapes are explicit interfaces (not `GetPayload`): the `findMany`
 * result is structurally checked against them at each call site, so dropping a
 * needed column from a config breaks the build — the same lockstep the Prisma
 * `select` discipline gave us.
 */

import {
  attestorForContext,
  claimDirectionForContext,
  computeAgreement,
  computeSyncHeadline,
  effectiveContextDirection,
  integrationDirectionForContext,
  ProductUsefulnessSchema,
  RATING_VISIBILITY_MIN_REVIEWS,
} from '@aeci/shared';
import type {
  AccountReview,
  AdminClaim,
  AdminReview,
  AdminVendorRequest,
  AdminVendorSeat,
  ClaimDirection,
  ClaimTimeline,
  ClaimTimelineEntry,
  IntegrationDetail,
  IntegrationListItem,
  IntegrationMechanismKind,
  LinkRef,
  Maintenance,
  PairClaimAttestation,
  PairVersionDiff,
  ProductDetail,
  ProductIntegrationItem,
  ProductLink,
  ProductListItem,
  ProductPairClaim,
  ProductPairMechanism,
  ProductPairResponse,
  ProductRole,
  ProductUsefulness,
  PublicReview,
  RelatedRequestRef,
  ReviewStatus,
  TaxonomyTermWithCount,
  VendorDetail,
  VendorEntitlementResponse,
  VendorLink,
  VendorListItem,
} from '@aeci/shared';
import {
  claimVersionStatus,
  isClaimPresentAt,
  type ClaimVersionWindow,
  type VersionPairSelection,
} from '@aeci/shared/version-diff';
import { and, asc, eq, inArray, isNull, like, sql, type SQL } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  attestations,
  productAudiences,
  productCategories,
  productPhases,
  products,
  productTrades,
  productVendors,
  productVersions,
  vendors,
} from '../db/schema';

// ---------------------------------------------------------------------------
// Shared read orderings
// ---------------------------------------------------------------------------

/**
 * The ordered `product_versions` read (§8.2). `sort_key` first; `created_at` then
 * `id` break a tie, which is possible because the unique index is on
 * `(product_id, label)`, not on `sort_key`, and every digit-free label derives 0.
 * The tiebreak deliberately does NOT fall back to `label` — that would
 * reintroduce exactly the lexical ordering the column exists to avoid.
 *
 * Mirrors `compareProductVersions` (`@aeci/shared/version-sort`) — **change both
 * together.** Lives here rather than beside either reader because there are now
 * two: `routes/vendor-product-versions.ts` (the authoring list, AECI-607) and the
 * product-PAIR read (the §9 selectors, AECI-303). One `ORDER BY`, one comment.
 */
export const VERSION_ORDER = [
  asc(productVersions.sortKey),
  asc(productVersions.createdAt),
  asc(productVersions.id),
];

// ---------------------------------------------------------------------------
// Leaf column sets (reused by several parents)
// ---------------------------------------------------------------------------

const vendorLinkColumns = {
  id: true,
  companyName: true,
  slug: true,
  logoUrl: true,
  verified: true,
} as const;
/** Exported for `routes/vendor-attestations.ts` (AECI-301), whose hydration
 *  embeds the same `ProductLink` shape. One column list, one mapper. */
export const productLinkColumns = { id: true, name: true, slug: true, logoUrl: true } as const;
const taxonomyLinkColumns = { id: true, name: true, slug: true } as const;
const taxonomyLinkWithOrderColumns = { ...taxonomyLinkColumns, displayOrder: true } as const;

// ---------------------------------------------------------------------------
// Query configs (spread into db.query.<table>.findMany / findFirst)
// ---------------------------------------------------------------------------

/** `IntegrationListItem` hydration — source + target as `ProductLink`. */
export const integrationListConfig = {
  columns: {
    id: true,
    name: true,
    mechanismKind: true,
    mechanismName: true,
    direction: true,
    createdAt: true,
    updatedAt: true,
  },
  with: {
    sourceProduct: { columns: productLinkColumns },
    targetProduct: { columns: productLinkColumns },
  },
} as const;

/**
 * The predicate both claim-loading read configs apply to their `attestations`
 * sub-query, and the load-bearing half of the §4 read path: `retracted_at IS
 * NULL` is what keeps a withdrawn assertion from voting
 * (`STAGE_2_ATTESTATIONS_SPEC.md` §2.5 handed this to §4 / AECI-605).
 *
 * It filters on `retracted_at` **only**. Gating on the `deprecated_at` version
 * stamp (`STAGE_1_5_SPEC.md` §3.3) would make an attestation vanish the moment
 * a vendor recorded that a flow was deprecated in some version — the opposite
 * of what AECI-303's timeline needs. The two columns are easy to conflate;
 * `schema.ts` spells out the distinction at the table.
 *
 * `computeAgreement` re-checks `retractedAt` itself, so the shared engine is
 * safe for callers that assemble attestations another way. This is the
 * belt — that is the braces.
 *
 * Exported for the §7 detector sweep (AECI-302), which builds its own read
 * config rather than paying for the pair page's render payload but must apply
 * the identical predicate — one definition, not a second `isNull(...)` literal
 * that could drift from this comment.
 */
export const liveAttestationsWhere = isNull(attestations.retractedAt);

/**
 * Product-detail embed of an integration (`ProductDetail.integrations_as_*`).
 * Like the list config but also loads each mechanism's claims — their
 * **directions** and the attestations that decide whether each still counts —
 * so `toProductIntegrationItem` can derive the claims-aware `context_direction`
 * (Stage 1.5 §3.2) the table renders. Kept separate from `integrationListConfig`
 * so `/api/integrations` and the home rail don't pay for the extra join.
 *
 * The attestation hydration is the §4 refuted-claim rule: a flow every voting
 * vendor denies must stop steering the table's arrow. Its column list is
 * deliberately narrower than the pair page's (no `note`/version stamps) —
 * nothing here is serialised, and this join already costs roughly
 * integrations × claims × attestations rows on a product-detail read.
 */
export const productDetailIntegrationConfig = {
  columns: integrationListConfig.columns,
  with: {
    ...integrationListConfig.with,
    claims: {
      columns: { direction: true },
      with: {
        attestations: {
          columns: { source: true, asserted: true, attestedByVendorId: true, retractedAt: true },
          where: liveAttestationsWhere,
        },
      },
    },
  },
} as const;

// ---------------------------------------------------------------------------
// Connector-evidenced pairs (AECI-721) — the SECOND storage table behind one
// wire shape.
//
// `STAGE_1_5_SPEC.md` §13.1 splits the DELIVERED tier across two tables:
// `integrations` holds accountable-party edges, `connector_evidenced_pairs` holds
// edges an iPaaS delivers. Both render as `IntegrationListItem`, distinguished by
// `via`, because §13.3 is written source-agnostically on purpose — the split is a
// sourcing question, never a rendering one.
//
// Three shape differences the mappers below have to reconcile, none of them
// accidental (`DATABASE_SCHEMA.md` §9a.6):
//
//   1. **Canonical pair, not source/target.** The row stores `product_a_id <
//      product_b_id` (a CHECK), so orientation lives in `direction` alone. A
//      vendor publishing both directions as separate pages would otherwise arrive
//      twice and the unique index could not see the collision.
//   2. **`direction` uses the CLAIM vocabulary** (`a_to_b | b_to_a | both`), not
//      `integrations`' `one-way | bidirectional`: once the pair is canonicalised,
//      `one-way` no longer says which way. Mapping back out is the inverse of the
//      migration's CASE and is lossless in both directions.
//   3. **No `mechanism_kind` column at all.** The lane answers "which mechanism",
//      so these rows serialise `mechanism_kind: null` and carry `via` instead.
//      Do not synthesise a kind to fill the gap.
// ---------------------------------------------------------------------------

/** `IntegrationListItem` hydration for an evidenced pair — both endpoints and the
 *  connector as `ProductLink`. */
export const connectorEvidencedPairListConfig = {
  columns: {
    id: true,
    name: true,
    mechanismName: true,
    direction: true,
    createdAt: true,
    updatedAt: true,
  },
  with: {
    productA: { columns: productLinkColumns },
    productB: { columns: productLinkColumns },
    connectorProduct: { columns: productLinkColumns },
  },
} as const;

/** Pair-page hydration for an evidenced pair — the list config plus the mechanism
 *  card's body and the maintenance marker, mirroring `integrationPairConfig`.
 *  `claims` joins in AECI-721 PR-B, once the anchor column exists. */
export const connectorEvidencedPairPairConfig = {
  columns: {
    ...connectorEvidencedPairListConfig.columns,
    description: true,
    listingUrl: true,
    docsUrl: true,
    lastReviewedAt: true,
    maintainedBy: true,
  },
  with: {
    ...connectorEvidencedPairListConfig.with,
    builtByVendor: { columns: vendorLinkColumns },
  },
} as const;

export interface RawConnectorEvidencedPairRow {
  id: string;
  name: string | null;
  mechanismName: string | null;
  direction: string | null;
  createdAt: string;
  updatedAt: string;
  productA: RawProductLink;
  productB: RawProductLink;
  connectorProduct: RawProductLink;
}

export interface RawConnectorEvidencedPairDetailRow extends RawConnectorEvidencedPairRow {
  description: string | null;
  listingUrl: string | null;
  docsUrl: string | null;
  lastReviewedAt: string | null;
  maintainedBy: string;
  builtByVendor: RawVendorLink | null;
}

/**
 * Resolve a canonical evidenced pair back into the oriented `source`/`target`
 * frame every read surface speaks, plus the `integrations` direction vocabulary.
 *
 * The exact inverse of the AECI-721 migration's CASE, and lossless: `b_to_a` is
 * the only value that swaps the endpoints, which is precisely the information
 * canonicalisation would otherwise discard. `both` and `null` both present A as
 * source — for `both` the orientation carries no meaning, and for `null` we have
 * no orientation to assert, so the stable canonical order is the honest choice.
 */
export function orientEvidencedPair(raw: RawConnectorEvidencedPairRow): {
  source: RawProductLink;
  target: RawProductLink;
  direction: 'one-way' | 'bidirectional' | null;
} {
  switch (raw.direction) {
    case 'a_to_b':
      return { source: raw.productA, target: raw.productB, direction: 'one-way' };
    case 'b_to_a':
      return { source: raw.productB, target: raw.productA, direction: 'one-way' };
    case 'both':
      return { source: raw.productA, target: raw.productB, direction: 'bidirectional' };
    default:
      // NULL is legal — the CHECK constrains only non-null values, and the
      // migration maps a null `integrations.direction` straight through.
      return { source: raw.productA, target: raw.productB, direction: null };
  }
}

/** An evidenced pair as an `IntegrationListItem`. `mechanism_kind` is null by
 *  construction (the table has no such column) and `via` names the connector. */
export function toIntegrationListItemFromEvidencedPair(
  raw: RawConnectorEvidencedPairRow,
): IntegrationListItem {
  const { source, target, direction } = orientEvidencedPair(raw);
  return {
    id: raw.id,
    name: synthesizeIntegrationName(raw.name, source, target),
    mechanism_kind: null,
    mechanism_name: raw.mechanismName,
    direction,
    source: toProductLink(source),
    target: toProductLink(target),
    via: toProductLink(raw.connectorProduct),
    created_at: raw.createdAt,
    updated_at: raw.updatedAt,
  };
}

/** Detail adds the heavier hydration per API_CONTRACTS §3.4. */
export const integrationDetailConfig = {
  columns: {
    ...integrationListConfig.columns,
    description: true,
    listingUrl: true,
    docsUrl: true,
    mechanismUrl: true,
    pricingModel: true,
    maturity: true,
  },
  with: {
    sourceProduct: { columns: productLinkColumns },
    targetProduct: { columns: productLinkColumns },
    builtByVendor: { columns: vendorLinkColumns },
    poweredByProduct: { columns: productLinkColumns },
  },
} as const;

/**
 * Pair-page mechanism hydration (Stage 1.5 §7 — AECI-294). Like the detail
 * config but drops the redundant `mechanism_url`/`pricing_model`/`maturity`
 * fields (unused by the pair card) while keeping source/target — needed to
 * translate the stored direction into the context product's frame.
 */
export const integrationPairConfig = {
  columns: {
    id: true,
    name: true,
    mechanismKind: true,
    mechanismName: true,
    direction: true,
    description: true,
    listingUrl: true,
    docsUrl: true,
    // Feed the page header's maintenance marker (AECI-616). Not surfaced per
    // mechanism — `computePairMaintenance` folds them into one header value.
    lastReviewedAt: true,
    maintainedBy: true,
  },
  with: {
    sourceProduct: { columns: productLinkColumns },
    targetProduct: { columns: productLinkColumns },
    builtByVendor: { columns: vendorLinkColumns },
    poweredByProduct: { columns: productLinkColumns },
    // Layer B (§8 — AECI-300): the `data_object` claims on this mechanism, each
    // with its stored direction + live attestations, mapped to a
    // context-relative claim with computed agreement in `toProductPairClaim`.
    //
    // `liveAttestationsWhere` discharges the AECI-603 handoff
    // (STAGE_2_ATTESTATIONS_SPEC.md §2.5): a retracted attestation must neither
    // vote nor render. `attestedByVendorId` feeds the §4.2 distinct-identity
    // dedupe and is dropped by the mapper; `note` + the version stamps are the
    // provenance popover's payload.
    //
    // The two `*VersionId` FKs are AECI-303's presence input (§9.1). Only the ids
    // are selected — NOT the related `product_versions` rows: the pair handler
    // already loads both endpoints' full version lists for the selectors, so
    // `resolveVersionSelection` resolves each id against that map. Hydrating the
    // relations here would mean two more joins on the heaviest read in the system
    // (and both would need their disambiguated `relationName`, since two FKs point
    // at one table) for data already in hand.
    claims: {
      columns: { id: true, direction: true },
      with: {
        dataObject: { columns: { slug: true, name: true, displayOrder: true } },
        attestations: {
          columns: {
            source: true,
            asserted: true,
            attestedByVendorId: true,
            retractedAt: true,
            note: true,
            introducedAt: true,
            deprecatedAt: true,
            introducedVersionId: true,
            deprecatedVersionId: true,
          },
          where: liveAttestationsWhere,
        },
      },
    },
  },
} as const;

/**
 * Per-claim **history** hydration for the pair timeline read
 * (`GET …/integrations/:otherSlug/timeline`, AECI-303 / §9.1).
 *
 * ⚠️ **This is the ONE read in the system that deliberately omits
 * `liveAttestationsWhere`.** Retracted rows are the point: §2.1's supersession is
 * retract-then-insert, so the append-only history *is* the retracted rows plus the
 * live one. Consequences, both load-bearing:
 *
 *   - **Never call `computeAgreement` (or `isClaimRefuted`, or `computeSyncHeadline`)
 *     on this config's output.** Those engines re-check `retractedAt` themselves, so
 *     they would not be *wrong* — but routing history through them is how a
 *     withdrawn assertion finds its way back into a vote, which is the exact hazard
 *     §2.5 handed to §4. Agreement comes from `integrationPairConfig`; this config
 *     feeds the timeline mapper and nothing else.
 *   - It carries no products, vendors, or mechanism columns — only what one history
 *     row renders. The payload is unbounded in principle (the log grows forever),
 *     so it stays as narrow as possible.
 */
export const integrationTimelineConfig = {
  columns: { id: true },
  with: {
    sourceProduct: { columns: { id: true } },
    claims: {
      columns: { id: true },
      with: {
        attestations: {
          columns: {
            id: true,
            source: true,
            asserted: true,
            note: true,
            retractedAt: true,
            createdAt: true,
            introducedVersionId: true,
            deprecatedVersionId: true,
          },
        },
      },
    },
  },
} as const;

/**
 * The narrowest product read that still answers §9.3's version-diff gate: the id,
 * plus the vendor links `pickPrimaryVendor` needs to expose the `verified` MIRROR
 * (AECI-304 / `STAGE_2_ATTESTATIONS_SPEC.md` §9.3).
 *
 * Used by the pair TIMELINE read, whose products are otherwise `{ id: true }` — the
 * pair read itself already carries this via `productListConfig`. It reuses
 * `vendorLinkColumns` and `pickPrimaryVendor` rather than a bespoke
 * "is-this-vendor-verified" selection so the two reads and the web resolver cannot
 * disagree about *which* vendor of a multi-vendor product the gate reads.
 *
 * `verified` is the denormalized mirror of an `active` entitlement row. **Nothing
 * here may join the entitlement table** — `STAGE_2_PAID_TIERS_SPEC.md` §2.5 forbids
 * it on a read path, and `drizzle-helpers.read-path.spec.ts` asserts it (which is
 * why this comment names the mirror rather than the table).
 */
export const productVersionDiffGateConfig = {
  columns: { id: true },
  with: {
    productVendors: {
      with: { vendor: { columns: vendorLinkColumns } },
    },
  },
} as const;

/** `ProductListItem` hydration. `vendor` resolves from `productVendors` ordered
 *  `isPrimary desc`; `primary_category` from the category joins. */
export const productListConfig = {
  columns: {
    id: true,
    slug: true,
    name: true,
    logoUrl: true,
    productRole: true,
    integrationCount: true,
    reviewCount: true,
    ratingOverallAvg: true,
    ratingOnboardingAvg: true,
    createdAt: true,
    updatedAt: true,
  },
  with: {
    // No `columns` restriction on the junctions: Drizzle's relational query needs
    // the FK columns to resolve the nested `with`, and the mappers ignore the
    // extra scalar fields. No orderBy — `pickPrimaryVendor` resolves the primary
    // via `find(isPrimary) ?? rows[0]`, so it is order-independent.
    productVendors: {
      with: { vendor: { columns: vendorLinkColumns } },
    },
    productCategories: {
      with: { category: { columns: taxonomyLinkWithOrderColumns } },
    },
  },
} as const;

/** Detail adds editorial fields, taxonomy joins, both integration sides. */
export const productDetailConfig = {
  columns: {
    ...productListConfig.columns,
    description: true,
    website: true,
    toolIntegrationsUrl: true,
    apiDocsUrl: true,
    hasApiDocs: true,
    usefulness: true,
    // Maintenance marker (AECI-616) — detail only; the marker never renders on a card.
    lastReviewedAt: true,
    maintainedBy: true,
  },
  with: {
    productVendors: {
      columns: { isPrimary: true },
      with: { vendor: { columns: vendorLinkColumns } },
    },
    productCategories: {
      columns: {},
      with: { category: { columns: taxonomyLinkWithOrderColumns } },
    },
    productAudiences: { columns: {}, with: { audience: { columns: taxonomyLinkColumns } } },
    productPhases: { columns: {}, with: { phase: { columns: taxonomyLinkColumns } } },
    // Sparse by design (§5.5a) — most products resolve to `[]` here.
    productTrades: { columns: {}, with: { trade: { columns: taxonomyLinkColumns } } },
    // Deliberately unordered. The detail page interleaves these two buckets
    // into ONE list sorted alphabetically by partner name (`product-detail.ts`,
    // `STAGE_1_5_SPEC.md` §7.1) — an order SQL can't express from here: a
    // relation `orderBy` only reaches columns of `integrations`, and the partner
    // name is on the joined product. Sorting each bucket wouldn't interleave
    // them either. Adding an `orderBy` here buys nothing the client reads.
    sourceIntegrations: productDetailIntegrationConfig,
    targetIntegrations: productDetailIntegrationConfig,
    // Edges this product powers as the connector/mechanism (Stage 1.5
    // Addendum B). The bare list config, not `productDetailIntegrationConfig`:
    // the page product is neither endpoint, so there is no context_direction
    // and no claims join to pay for.
    poweredIntegrations: integrationListConfig,
    // The same bucket's SECOND source after AECI-721: edges this product powers
    // that have moved out of `integrations` into the connector lane's delivered
    // tier. `toProductDetail` unions the two into `integrations_as_connector`.
    evidencedPairsAsConnector: connectorEvidencedPairListConfig,
  },
} as const;

/** Public-review display fields (`PublicReview`, §5.4). Omits all PII/moderation
 *  columns; always paired with a `status = 'approved'` filter by the caller. */
export const publicReviewColumns = {
  id: true,
  ratingOverall: true,
  ratingOnboarding: true,
  title: true,
  body: true,
  roleAtCompany: true,
  yearsUsing: true,
  wouldRecommend: true,
  verifiedWorkEmail: true,
  createdAt: true,
} as const;

/** First-page size for the approved-reviews list + the `ProductDetail` embed. */
export const EMBED_REVIEWS_PAGE_SIZE = 24;

/** Admin moderation row (`AdminReview`, §5.13) — the INVERSE of the public
 *  select: the columns the public path hides (status/toxicity/moderation +
 *  reviewerId to look the email up out-of-band) + the hydrated product. */
export const adminReviewConfig = {
  columns: {
    id: true,
    reviewerId: true,
    ratingOverall: true,
    ratingOnboarding: true,
    title: true,
    body: true,
    roleAtCompany: true,
    yearsUsing: true,
    wouldRecommend: true,
    reviewerFirm: true,
    verifiedWorkEmail: true,
    locale: true,
    status: true,
    toxicityScore: true,
    rejectionReason: true,
    moderatedAt: true,
    createdAt: true,
  },
  with: { product: { columns: { id: true, name: true, slug: true } } },
} as const;

/** Reviewer-scoped own-reviews (`AccountReview`, §5.11). A narrow slice: the
 *  author needs `status` + `rejectionReason`, NONE of the admin-only signals.
 *  Always paired with a `reviewerId = session.userId` filter by the caller. */
export const accountReviewConfig = {
  columns: {
    id: true,
    ratingOverall: true,
    ratingOnboarding: true,
    title: true,
    status: true,
    rejectionReason: true,
    createdAt: true,
  },
  with: { product: { columns: { id: true, name: true, slug: true } } },
} as const;

/** `VendorListItem` — counts via correlated-subquery `extras`. */
export const vendorListConfig = {
  columns: {
    id: true,
    slug: true,
    companyName: true,
    logoUrl: true,
    verified: true,
    headquarters: true,
    foundedYear: true,
    createdAt: true,
    updatedAt: true,
  },
  // The correlated outer column MUST be qualified by the root alias. Drizzle
  // renders `${vendors.id}` as bare `"id"`, which a subquery's own table shadows
  // when it also has an `id` column (e.g. `integrations`) — silently returning 0.
  // The relational builder (`db.query.*`) aliases the root as its DRIZZLE SCHEMA
  // KEY (here `vendors`, which happens to match the SQL table name). These configs
  // are used only in relational queries, so the schema-key literal is stable; a
  // regression would fail the route specs (which exercise the counts).
  extras: {
    productCount:
      sql<number>`(SELECT count(*) FROM product_vendors pv WHERE pv.vendor_id = "vendors"."id")`.as(
        'product_count',
      ),
    integrationCount:
      // AECI-721 / §13.5 item 6: a DIFFERENT rule from the product count — a
      // correlated subquery on `built_by_vendor_id`, not a read of the
      // denormalized `products.integration_count` column. It is therefore NOT
      // downstream of `recompute-counts.ts` and drops every migrated edge on its
      // own unless the evidenced table is summed here too. The ~20-row accountable
      // residue §13.2 records is exactly this population: Agave built 11 of the 19
      // edges that move, so without the second subquery Agave's vendor record
      // reports 0 integrations the day the migration lands.
      sql<number>`((SELECT count(*) FROM integrations bi WHERE bi.built_by_vendor_id = "vendors"."id")
        + (SELECT count(*) FROM connector_evidenced_pairs cep WHERE cep.built_by_vendor_id = "vendors"."id"))`.as(
        'integration_count',
      ),
  },
} as const;

/** Vendor detail adds editorial + social fields and the vendor's products. */
export const vendorDetailConfig = {
  columns: {
    ...vendorListConfig.columns,
    description: true,
    website: true,
    linkedinUrl: true,
    xUrl: true,
    facebookUrl: true,
    instagramUrl: true,
    youtubeUrl: true,
    githubOrg: true,
    // Maintenance marker (AECI-616) — detail only.
    lastReviewedAt: true,
    maintainedBy: true,
  },
  extras: vendorListConfig.extras,
  with: {
    productVendors: {
      columns: { isPrimary: true },
      with: { product: productListConfig },
    },
  },
} as const;

/** Per-model taxonomy term config; `_count` → an `extras` subquery on the model's
 *  own join table. */
// `_count` → an `extras` subquery on the model's own join table. The outer
// column is table-qualified (see the vendor extras note); these join tables have
// no `id` column so bare would also work, but qualifying keeps the pattern uniform.
export const categoryTermConfig = {
  columns: { id: true, slug: true, name: true, description: true, displayOrder: true },
  extras: {
    productCount:
      sql<number>`(SELECT count(*) FROM product_categories pc WHERE pc.category_id = "taxonomyCategories"."id")`.as(
        'product_count',
      ),
  },
} as const;
export const audienceTermConfig = {
  columns: { id: true, slug: true, name: true, description: true, displayOrder: true },
  extras: {
    productCount:
      sql<number>`(SELECT count(*) FROM product_audiences pa WHERE pa.audience_id = "taxonomyAudiences"."id")`.as(
        'product_count',
      ),
  },
} as const;
export const phaseTermConfig = {
  columns: { id: true, slug: true, name: true, description: true, displayOrder: true },
  extras: {
    productCount:
      sql<number>`(SELECT count(*) FROM product_phases pp WHERE pp.phase_id = "taxonomyPhases"."id")`.as(
        'product_count',
      ),
  },
} as const;
/** Trades (§5.5a / AECI-541). Same shape as its three siblings — `aliases` is
 *  deliberately NOT selected: it is resolver + search metadata (promote find-only,
 *  Algolia `trade_aliases`), never part of the public term payload. The count is
 *  ungated: sub-`TRADE_PUBLISH_MIN_PRODUCTS` terms travel with their real count
 *  and each surface applies the floor (`TRADES_VOCABULARY.md` §6). */
export const tradeTermConfig = {
  columns: { id: true, slug: true, name: true, description: true, displayOrder: true },
  extras: {
    productCount:
      sql<number>`(SELECT count(*) FROM product_trades pt WHERE pt.trade_id = "taxonomyTrades"."id")`.as(
        'product_count',
      ),
  },
} as const;

// ---------------------------------------------------------------------------
// Raw row shapes (what the configs above return)
// ---------------------------------------------------------------------------

interface RawVendorLink {
  id: string;
  companyName: string;
  slug: string;
  logoUrl: string | null;
  verified: boolean;
}
interface RawProductLink {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
}
interface RawTaxonomyLink {
  id: string;
  name: string;
  slug: string;
}
interface RawTaxonomyLinkWithOrder extends RawTaxonomyLink {
  displayOrder: number | null;
}

export interface RawIntegrationListRow {
  id: string;
  name: string | null;
  mechanismKind: string | null;
  mechanismName: string | null;
  direction: string | null;
  createdAt: string;
  updatedAt: string;
  sourceProduct: RawProductLink;
  targetProduct: RawProductLink;
}
/** List row + each mechanism's claims, for the product-detail embed
 *  (`productDetailIntegrationConfig`). Both halves feed
 *  `effectiveContextDirection`: the direction is what the table renders, the
 *  attestations decide whether a claim still gets a say (§4.3 — a flow every
 *  voting vendor denies must stop steering the arrow). */
export interface RawProductIntegrationRow extends RawIntegrationListRow {
  claims: Array<{ direction: string; attestations: RawAgreementVoteRow[] }>;
}

export interface RawIntegrationDetailRow extends RawIntegrationListRow {
  description: string | null;
  listingUrl: string | null;
  docsUrl: string | null;
  mechanismUrl: string | null;
  pricingModel: string | null;
  maturity: string | null;
  builtByVendor: RawVendorLink | null;
  poweredByProduct: RawProductLink | null;
}

/** The minimum an attestation must carry to be counted by `computeAgreement`
 *  (§4.2): who voted, under which vendor identity, and whether the assertion
 *  still stands. Structurally an `AgreementAttestation` with Drizzle's camelCase
 *  column names — the read configs already filter `retractedAt IS NULL`, but the
 *  column is carried so the shared engine's own re-check has something to read. */
export interface RawAgreementVoteRow {
  source: string;
  asserted: boolean;
  attestedByVendorId: string | null;
  retractedAt: string | null;
}

/** A pair-page attestation: the vote plus the provenance payload the popover
 *  renders. */
export interface RawClaimAttestationRow extends RawAgreementVoteRow {
  note: string | null;
  introducedAt: string | null;
  deprecatedAt: string | null;
  // AECI-303 (§9.1): the PRECISE version stamps. Resolved against the pair's
  // loaded `product_versions` map, not via a relation — see `integrationPairConfig`.
  introducedVersionId: string | null;
  deprecatedVersionId: string | null;
}

/** One append-only history row for the timeline read (`integrationTimelineConfig`). */
export interface RawTimelineAttestationRow {
  id: string;
  source: string;
  asserted: boolean;
  note: string | null;
  retractedAt: string | null;
  createdAt: string;
  introducedVersionId: string | null;
  deprecatedVersionId: string | null;
}

export interface RawTimelineIntegrationRow {
  id: string;
  sourceProduct: { id: string };
  claims: { id: string; attestations: RawTimelineAttestationRow[] }[];
}

/**
 * What the §9 mappers need to resolve one pair read's version diff.
 *
 * Implemented by `resolveVersionSelection` (`./pair-version-diff`), which owns the
 * label lookup, the stamp-id → side resolution, and the **single**
 * `canViewVersionDiff` consult on the API. Declared here because the mappers are
 * the consumer and this is their contract; the dependency runs
 * `pair-version-diff → drizzle-helpers`, never back.
 *
 * Passing `undefined` to the mappers is not a degraded mode — it is the ordinary
 * path for every pair whose diff does not apply, and it must produce output
 * identical to the pre-AECI-303 shape.
 */
export interface PairVersionResolver {
  /** The wire payload for `ProductPairResponse.version_diff`. */
  readonly diff: PairVersionDiff;
  readonly selected: VersionPairSelection;
  readonly previous: VersionPairSelection | null;
  /** The 0, 1, or 2 windows one attestation's stamps contribute. */
  claimWindows(attestation: {
    introducedVersionId: string | null;
    deprecatedVersionId: string | null;
  }): ClaimVersionWindow[];
  /** A stamped version's label, or `undefined` when unstamped or unresolvable. */
  versionLabel(versionId: string | null): string | undefined;
}

export interface RawPairClaimRow {
  id: string;
  direction: string;
  dataObject: { slug: string; name: string; displayOrder: number | null };
  attestations: RawClaimAttestationRow[];
}

export interface RawIntegrationPairRow {
  id: string;
  name: string | null;
  mechanismKind: string | null;
  mechanismName: string | null;
  direction: string | null;
  description: string | null;
  listingUrl: string | null;
  docsUrl: string | null;
  sourceProduct: RawProductLink;
  targetProduct: RawProductLink;
  builtByVendor: RawVendorLink | null;
  poweredByProduct: RawProductLink | null;
  claims: RawPairClaimRow[];
  // Folded into the page header by `computePairMaintenance`, not surfaced per
  // mechanism (AECI-616).
  maintainedBy: string;
  lastReviewedAt: string | null;
}

/** The maintenance-marker columns every detail read selects (AECI-616). */
export interface RawMaintenanceColumns {
  maintainedBy: string;
  lastReviewedAt: string | null;
}

export interface RawProductListRow {
  id: string;
  slug: string;
  name: string;
  logoUrl: string | null;
  productRole: string;
  integrationCount: number;
  reviewCount: number;
  ratingOverallAvg: number | null;
  ratingOnboardingAvg: number | null;
  createdAt: string;
  updatedAt: string;
  productVendors: Array<{ isPrimary: boolean; vendor: RawVendorLink }>;
  productCategories: Array<{ category: RawTaxonomyLinkWithOrder }>;
}
export interface RawProductDetailRow extends RawProductListRow, RawMaintenanceColumns {
  description: string | null;
  website: string | null;
  toolIntegrationsUrl: string | null;
  apiDocsUrl: string | null;
  hasApiDocs: boolean;
  usefulness: unknown;
  productAudiences: Array<{ audience: RawTaxonomyLink }>;
  productPhases: Array<{ phase: RawTaxonomyLink }>;
  productTrades: Array<{ trade: RawTaxonomyLink }>;
  sourceIntegrations: RawProductIntegrationRow[];
  targetIntegrations: RawProductIntegrationRow[];
  poweredIntegrations: RawIntegrationListRow[];
  evidencedPairsAsConnector: RawConnectorEvidencedPairRow[];
}

export interface RawPublicReviewRow {
  id: string;
  ratingOverall: number;
  ratingOnboarding: number;
  title: string;
  body: string;
  roleAtCompany: string | null;
  yearsUsing: number | null;
  wouldRecommend: string | null;
  verifiedWorkEmail: boolean;
  createdAt: string;
}

export interface RawAccountReviewRow {
  id: string;
  ratingOverall: number;
  ratingOnboarding: number;
  title: string;
  status: string;
  rejectionReason: string | null;
  createdAt: string;
  product: { id: string; name: string; slug: string };
}

export interface RawAdminReviewRow {
  id: string;
  reviewerId: string | null;
  ratingOverall: number;
  ratingOnboarding: number;
  title: string;
  body: string;
  roleAtCompany: string | null;
  yearsUsing: number | null;
  wouldRecommend: string | null;
  reviewerFirm: string | null;
  verifiedWorkEmail: boolean;
  locale: string;
  status: string;
  toxicityScore: number | null;
  rejectionReason: string | null;
  moderatedAt: string | null;
  createdAt: string;
  product: { id: string; name: string; slug: string };
}

export interface RawVendorListRow {
  id: string;
  slug: string;
  companyName: string;
  logoUrl: string | null;
  verified: boolean;
  headquarters: string | null;
  foundedYear: number | null;
  createdAt: string;
  updatedAt: string;
  productCount: number;
  integrationCount: number;
}
export interface RawVendorDetailRow extends RawVendorListRow, RawMaintenanceColumns {
  description: string | null;
  website: string | null;
  linkedinUrl: string | null;
  xUrl: string | null;
  facebookUrl: string | null;
  instagramUrl: string | null;
  youtubeUrl: string | null;
  githubOrg: string | null;
  productVendors: Array<{ isPrimary: boolean; product: RawProductListRow }>;
}

export interface RawTaxonomyTermRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  displayOrder: number | null;
  productCount: number;
}

// ---------------------------------------------------------------------------
// Coalescing / conversion helpers (AECI-115 fail-loud preserved)
// ---------------------------------------------------------------------------

const VALID_MECHANISM_KINDS = new Set<IntegrationMechanismKind>([
  'native',
  'iPaaS',
  'marketplace-app',
  'api',
  'webhook',
  'partner',
  'integrator',
]);

export function toMechanismKind(
  raw: string | null,
  integrationId: string,
): IntegrationMechanismKind | null {
  if (raw === null) return null;
  if ((VALID_MECHANISM_KINDS as Set<string>).has(raw)) return raw as IntegrationMechanismKind;
  throw new Error(
    `Data integrity: integration ${integrationId} has unknown mechanism_kind "${raw}"`,
  );
}

export function coerceDirection(raw: string | null): 'one-way' | 'bidirectional' | null {
  if (raw === 'one-way' || raw === 'bidirectional') return raw;
  return null;
}

/** Narrow a `claims.direction` string (DB check-constrained — §6.1) to the typed
 *  union. Fail loud on an unexpected value rather than silently mis-rendering. */
export function coerceClaimDirection(raw: string, claimId: string): ClaimDirection {
  if (raw === 'a_to_b' || raw === 'b_to_a' || raw === 'both') return raw;
  throw new Error(`Data integrity: claim ${claimId} has unknown direction "${raw}"`);
}

function toProductRole(raw: string, productId: string): ProductRole {
  if (raw === 'application' || raw === 'connector' || raw === 'hybrid') return raw;
  throw new Error(`Data integrity: product ${productId} has unknown product_role "${raw}"`);
}

export function toProductLink(raw: RawProductLink): ProductLink {
  return { id: raw.id, name: raw.name, slug: raw.slug, logo_url: raw.logoUrl };
}
function toVendorLink(raw: RawVendorLink): VendorLink {
  return {
    id: raw.id,
    name: raw.companyName,
    slug: raw.slug,
    logo_url: raw.logoUrl,
    verified: raw.verified,
  };
}
function synthesizeIntegrationName(
  rawName: string | null,
  source: RawProductLink,
  target: RawProductLink,
): string {
  if (rawName && rawName.length > 0) return rawName;
  return `${source.name} → ${target.name}`;
}

export function toUsefulness(raw: unknown): ProductUsefulness | null {
  if (raw == null) return null;
  const parsed = ProductUsefulnessSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function toIntegrationListItem(raw: RawIntegrationListRow): IntegrationListItem {
  return {
    id: raw.id,
    name: synthesizeIntegrationName(raw.name, raw.sourceProduct, raw.targetProduct),
    mechanism_kind: toMechanismKind(raw.mechanismKind, raw.id),
    mechanism_name: raw.mechanismName,
    direction: coerceDirection(raw.direction),
    source: toProductLink(raw.sourceProduct),
    target: toProductLink(raw.targetProduct),
    // A row of `integrations` is by definition NOT delivered by a named connector
    // in the AECI-721 sense: the connector-delivered edges live in
    // `connector_evidenced_pairs` and come through
    // `toIntegrationListItemFromEvidencedPair`. A self-referential Convention-A
    // edge keeps its `powered_by_product` on the DETAIL shape and still reads
    // `via: null` here — the two are deliberately not interchangeable.
    via: null,
    created_at: raw.createdAt,
    updated_at: raw.updatedAt,
  };
}

/**
 * Product-detail embed of an integration: the list item plus the claims-aware
 * `context_direction` (Stage 1.5 §3.2). The effective direction prefers the
 * mechanism's `data_object` claim directions (the richer signal the pair page
 * surfaces) and falls back to the stored row `direction`, both framed to this
 * page's product. Claims every voting vendor denies are dropped by
 * `effectiveContextDirection` (§4.3). `contextIsSource` is whether this product
 * is the integration's `source` (its endpoint A). Precomputed here so the table
 * can't drift from the pair page.
 */
export function toProductIntegrationItem(
  raw: RawProductIntegrationRow,
  contextIsSource: boolean,
): ProductIntegrationItem {
  return {
    ...toIntegrationListItem(raw),
    context_direction: effectiveContextDirection(
      coerceDirection(raw.direction),
      raw.claims.map((claim) => ({
        direction: coerceClaimDirection(claim.direction, raw.id),
        attestations: claim.attestations,
      })),
      contextIsSource,
    ),
  };
}

export function toIntegrationDetail(raw: RawIntegrationDetailRow): IntegrationDetail {
  return {
    ...toIntegrationListItem(raw),
    description: raw.description,
    listing_url: raw.listingUrl,
    docs_url: raw.docsUrl,
    mechanism_url: raw.mechanismUrl,
    built_by_vendor: raw.builtByVendor ? toVendorLink(raw.builtByVendor) : null,
    powered_by_product: raw.poweredByProduct ? toProductLink(raw.poweredByProduct) : null,
    pricing_model: raw.pricingModel,
    maturity: raw.maturity,
  };
}

/** Surface one attestation for the provenance popover, with its slot translated
 *  into the page's context frame (§4.3). `attested_by_vendor_id` stays server-
 *  side: the reader has no use for a vendor UUID, and `attestor` is enough to
 *  name the party from the response's two hydrated vendor links. */
function toPairClaimAttestation(
  raw: RawClaimAttestationRow,
  contextIsSource: boolean,
  versions?: PairVersionResolver,
): PairClaimAttestation {
  const source = raw.source as PairClaimAttestation['source'];
  // Version LABELS, and only when they resolve. `versions` undefined (the diff
  // does not apply to this pair) or an unresolvable id both leave the keys ABSENT
  // rather than `null` — the one spelling of "no stamp", which is what keeps an
  // unstamped attestation serialising byte-for-byte as it did before AECI-303.
  const introducedVersion = versions?.versionLabel(raw.introducedVersionId);
  const deprecatedVersion = versions?.versionLabel(raw.deprecatedVersionId);
  return {
    source,
    attestor: attestorForContext(source, contextIsSource),
    asserted: raw.asserted,
    note: raw.note,
    introduced_at: raw.introducedAt,
    deprecated_at: raw.deprecatedAt,
    ...(introducedVersion === undefined ? {} : { introduced_version: introducedVersion }),
    ...(deprecatedVersion === undefined ? {} : { deprecated_version: deprecatedVersion }),
  };
}

/**
 * One `data_object` claim on a mechanism (§8), with its stored direction
 * translated to the context product's frame (§3.2) and its agreement computed
 * from the attestation set (§3.4 / §4.2 — never stored, ADR 0018).
 * `contextIsSource` is whether the page's context product is the integration's
 * endpoint A.
 *
 * Returns **`null` when the claim must be dropped** from the response: it is
 * present at neither the selected version pair nor the previous one, so it belongs
 * to an earlier era (AECI-303 / §9.1). Without that drop, a pair with a long
 * release history would render every flow it ever had. With `versions` undefined
 * nothing is ever dropped — the pre-AECI-303 behaviour.
 */
function toProductPairClaim(
  raw: RawPairClaimRow,
  contextIsSource: boolean,
  versions?: PairVersionResolver,
): ProductPairClaim | null {
  const base = {
    id: raw.id,
    data_object_slug: raw.dataObject.slug,
    data_object_name: raw.dataObject.name,
    direction: claimDirectionForContext(
      coerceClaimDirection(raw.direction, raw.id),
      contextIsSource,
    ),
    // Agreement is computed from the LIVE attestations only and is deliberately
    // independent of the version selection: §8.1(4) makes the latest conflict /
    // single-source state free and full-fidelity, and a claim that renders at all
    // renders its real agreement.
    agreement: computeAgreement(raw.attestations),
    attestations: raw.attestations.map((a) => toPairClaimAttestation(a, contextIsSource, versions)),
  };
  if (!versions) return base;

  const windows = raw.attestations.flatMap((a) => versions.claimWindows(a));
  const presentNow = isClaimPresentAt(windows, versions.selected);
  const presentBefore = versions.previous !== null && isClaimPresentAt(windows, versions.previous);
  if (!presentNow && !presentBefore) return null;

  return {
    ...base,
    version_status: claimVersionStatus(windows, versions.selected, versions.previous),
  };
}

/** Order claims for stable rendering: by the data_object's curated
 *  `display_order`, then name — independent of D1 row order. */
function compareClaims(a: RawPairClaimRow, b: RawPairClaimRow): number {
  const oa = a.dataObject.displayOrder ?? Number.MAX_SAFE_INTEGER;
  const ob = b.dataObject.displayOrder ?? Number.MAX_SAFE_INTEGER;
  if (oa !== ob) return oa - ob;
  return a.dataObject.name.localeCompare(b.dataObject.name);
}

/** One mechanism row on the pair page, with its direction translated to the
 *  context product's frame (§3.2 / §7) and its `data_object` claims (§8).
 *  `mechanism_name` is the integration's own title, falling back to the
 *  mechanism label; source/target are redundant on the pair page (both are the
 *  page's endpoints) so they are not surfaced. */
function toProductPairMechanism(
  raw: RawIntegrationPairRow,
  contextProductId: string,
  versions?: PairVersionResolver,
): ProductPairMechanism {
  const contextIsSource = raw.sourceProduct.id === contextProductId;
  return {
    id: raw.id,
    mechanism_kind: toMechanismKind(raw.mechanismKind, raw.id),
    mechanism_name: raw.name ?? raw.mechanismName,
    direction: integrationDirectionForContext(coerceDirection(raw.direction), contextIsSource),
    description: raw.description,
    listing_url: raw.listingUrl,
    docs_url: raw.docsUrl,
    built_by_vendor: raw.builtByVendor ? toVendorLink(raw.builtByVendor) : null,
    powered_by_product: raw.poweredByProduct ? toProductLink(raw.poweredByProduct) : null,
    // Always null on an `integrations` row — the evidenced-pair arm of the pair
    // read sets it (`toProductPairMechanismFromEvidencedPair`).
    via: null,
    // Sort FIRST, then drop: ordering stays this mapper's job and is independent
    // of the version selection, so walking the selectors never reshuffles the lanes.
    claims: [...raw.claims]
      .sort(compareClaims)
      .map((claim) => toProductPairClaim(claim, contextIsSource, versions))
      .filter((claim): claim is ProductPairClaim => claim !== null),
  };
}

/**
 * One mechanism row on the pair page sourced from `connector_evidenced_pairs`
 * (AECI-721). The evidenced-pair twin of `toProductPairMechanism`.
 *
 * Without this arm the pair page queries `integrations` alone and renders "no
 * integrations" for the 19 production pairs that exist ONLY as evidenced pairs
 * after the migration — a pair that plainly has a delivered integration reading
 * as though it has none, purely because of an internal storage move.
 *
 * `claims` is `[]` until PR-B adds `claims.connector_evidenced_pair_id`; the
 * migration preserves each edge's id verbatim as the pair's id, so the 85
 * production claims re-anchor without their stored value changing.
 */
function toProductPairMechanismFromEvidencedPair(
  raw: RawConnectorEvidencedPairDetailRow,
  contextProductId: string,
): ProductPairMechanism {
  const { source, direction } = orientEvidencedPair(raw);
  const contextIsSource = source.id === contextProductId;
  return {
    id: raw.id,
    // Null by construction — see the section header. The connector is in `via`.
    mechanism_kind: null,
    mechanism_name: raw.name ?? raw.mechanismName,
    direction: integrationDirectionForContext(direction, contextIsSource),
    description: raw.description,
    listing_url: raw.listingUrl,
    docs_url: raw.docsUrl,
    built_by_vendor: raw.builtByVendor ? toVendorLink(raw.builtByVendor) : null,
    // `powered_by_product` stays null: on an evidenced pair the connector is
    // structural, and the byline reads it from `via`. Setting both would let a
    // renderer print the connector twice.
    powered_by_product: null,
    via: toProductLink(raw.connectorProduct),
    claims: [],
  };
}

export { toProductPairMechanismFromEvidencedPair };

/**
 * Assemble the product-PAIR response (§7 + §8). Both products hydrate as
 * `ProductListItem` (vendor + review recap) for the rail; each integration row
 * becomes a mechanism with a context-relative direction and its `data_object`
 * claims. `sync_headline` is derived from every claim on the pair via
 * `computeSyncHeadline` (§3.5 / §4.3) — `total` is the distinct claim count
 * across all mechanisms; `confirmed` and `single_source` are both `0` until the
 * Stage 2 portal writes vendor attestations, and stay separate counts so a
 * one-sided assertion is never folded into the bilateral figure.
 */
export function toProductPairResponse(
  contextProduct: RawProductListRow,
  otherProduct: RawProductListRow,
  integrations: RawIntegrationPairRow[],
  /**
   * Connector-evidenced pairs between the same two products (AECI-721).
   * **Required, not optional** — after the migration 19 production pairs exist
   * only here, and a defaulted parameter is precisely how a future read surface
   * would silently render "no integrations" for a pair that has one. Callers with
   * nothing to pass write `[]` and thereby say so.
   */
  evidencedPairs: RawConnectorEvidencedPairDetailRow[],
  versions?: PairVersionResolver,
): ProductPairResponse {
  const mechanisms = [
    ...integrations.map((row) => toProductPairMechanism(row, contextProduct.id, versions)),
    ...evidencedPairs.map((row) => toProductPairMechanismFromEvidencedPair(row, contextProduct.id)),
  ];
  const claims = mechanisms.flatMap((m) => m.claims);
  return {
    context_product: toProductListItem(contextProduct),
    other_product: toProductListItem(otherProduct),
    mechanisms,
    // `removed` claims still render (struck through) but must not be counted:
    // "N data objects sync" may not include a flow that has stopped
    // (AECI-303 / §9.1). Filtered HERE, at the single call site, rather than inside
    // `computeSyncHeadline` — the shared engine stays a pure function of
    // `{ agreement }` and owes the diff contract nothing.
    sync_headline: computeSyncHeadline(claims.filter((c) => c.version_status !== 'removed')),
    // Both tables carry the maintenance marker pair, and the header shows ONE
    // value for the pair — so an evidenced pair that a vendor maintains must be
    // able to speak for it, exactly as an `integrations` row can.
    maintenance: computePairMaintenance([...integrations, ...evidencedPairs]),
    version_diff: versions ? { ...versions.diff, counts: countVersionStatuses(claims) } : null,
  };
}

/** The data-flow band's "2 added · 1 removed" line. */
function countVersionStatuses(claims: readonly ProductPairClaim[]): PairVersionDiff['counts'] {
  let added = 0;
  let removed = 0;
  for (const claim of claims) {
    if (claim.version_status === 'added') added += 1;
    else if (claim.version_status === 'removed') removed += 1;
  }
  return { added, removed };
}

/**
 * Assemble the per-claim histories for the pair timeline read (AECI-303 / §9.1).
 *
 * Reads `integrationTimelineConfig`'s output, which — uniquely — includes
 * **retracted** rows. Entries are ordered oldest-first by `created_at` then `id`,
 * a total order so the render is stable regardless of D1 row order. Claims with no
 * attestations at all are omitted: an empty history is nothing to show, and the
 * browser's "does this claim have a history affordance?" test is the absence of an
 * entry for its id.
 *
 * `contextProductId` frames each row's slot context-relatively via
 * `attestorForContext`, exactly as the live pair read does, so the two surfaces
 * cannot disagree about which party is "context".
 */
export function toPairTimelines(
  integrations: readonly RawTimelineIntegrationRow[],
  contextProductId: string,
  versions: Pick<PairVersionResolver, 'versionLabel'>,
): ClaimTimeline[] {
  const timelines: ClaimTimeline[] = [];
  for (const integration of integrations) {
    const contextIsSource = integration.sourceProduct.id === contextProductId;
    for (const claim of integration.claims) {
      if (claim.attestations.length === 0) continue;
      const entries = [...claim.attestations]
        .sort((a, b) => {
          if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
          return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        })
        .map((row) => toClaimTimelineEntry(row, contextIsSource, versions));
      timelines.push({ claim_id: claim.id, entries });
    }
  }
  return timelines;
}

function toClaimTimelineEntry(
  raw: RawTimelineAttestationRow,
  contextIsSource: boolean,
  versions: Pick<PairVersionResolver, 'versionLabel'>,
): ClaimTimelineEntry {
  const source = raw.source as PairClaimAttestation['source'];
  const introducedVersion = versions.versionLabel(raw.introducedVersionId);
  const deprecatedVersion = versions.versionLabel(raw.deprecatedVersionId);
  return {
    attestor: attestorForContext(source, contextIsSource),
    asserted: raw.asserted,
    note: raw.note,
    ...(introducedVersion === undefined ? {} : { introduced_version: introducedVersion }),
    ...(deprecatedVersion === undefined ? {} : { deprecated_version: deprecatedVersion }),
    created_at: raw.createdAt,
    retracted_at: raw.retractedAt,
  };
}

/**
 * Fold N mechanisms into the ONE maintenance marker the pair-page header renders
 * (AECI-616 / §13).
 *
 * `maintained_by` is `'vendor'` when ANY mechanism is vendor-maintained: a page that
 * carries even one vendor-authored mechanism is not purely AECi's word any more, and
 * claiming otherwise understates who is on the hook.
 *
 * The date is then taken **only over the mechanisms in the winning branch**, which is
 * the part that is easy to get wrong. A global `max()` would let an AECi mechanism
 * reviewed last week supply the date for a header that reads `Vendor-maintained.
 * Updated <date>.` — attributing AECi's review to the vendor. Scoping the max to the
 * branch keeps the two halves of the sentence about the same records.
 *
 * An empty pair (or one where nothing has been reviewed) yields `null`, which renders
 * bare attribution — correct, not missing.
 */
export function computePairMaintenance(
  rows: readonly { maintainedBy: string; lastReviewedAt: string | null }[],
): Maintenance {
  const maintainedBy = rows.some((r) => r.maintainedBy === 'vendor') ? 'vendor' : 'aeci';
  const dates = rows
    .filter((r) => (r.maintainedBy === 'vendor' ? 'vendor' : 'aeci') === maintainedBy)
    .map((r) => r.lastReviewedAt)
    .filter((at): at is string => at !== null);
  // ISO-8601 UTC strings sort lexicographically, which is why the column stores them
  // that way; no Date parsing needed to find the newest.
  return {
    maintained_by: maintainedBy,
    last_reviewed_at: dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : null,
  };
}

function pickPrimaryCategory(
  rows: Array<{ category: RawTaxonomyLinkWithOrder }>,
): { id: string; name: string; slug: string } | null {
  if (rows.length === 0) return null;
  let best = rows[0]!.category;
  for (let i = 1; i < rows.length; i++) {
    const candidate = rows[i]!.category;
    const candidateOrder = candidate.displayOrder ?? Number.POSITIVE_INFINITY;
    const bestOrder = best.displayOrder ?? Number.POSITIVE_INFINITY;
    if (
      candidateOrder < bestOrder ||
      (candidateOrder === bestOrder && candidate.name.localeCompare(best.name) < 0)
    ) {
      best = candidate;
    }
  }
  return { id: best.id, name: best.name, slug: best.slug };
}

export function pickPrimaryVendor(
  rows: Array<{ isPrimary: boolean; vendor: RawVendorLink }>,
): VendorLink | null {
  if (rows.length === 0) return null;
  const primary = rows.find((r) => r.isPrimary) ?? rows[0]!;
  return toVendorLink(primary.vendor);
}

export function toProductListItem(raw: RawProductListRow): ProductListItem {
  // §5.5 gate (shared with `toProductDetail` + the `rating` sort): a product's
  // averages are withheld until it has ≥5 approved reviews, so the list/grid/
  // search cards never render a statistically misleading sub-5 average. The
  // `review_count` itself is always truthful (a card may show "N reviews"
  // without an average).
  const ratingsVisible = raw.reviewCount >= RATING_VISIBILITY_MIN_REVIEWS;
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    logo_url: raw.logoUrl,
    product_role: toProductRole(raw.productRole, raw.id),
    vendor: pickPrimaryVendor(raw.productVendors),
    primary_category: pickPrimaryCategory(raw.productCategories),
    integration_count: raw.integrationCount,
    review_count: raw.reviewCount,
    rating_overall_avg: ratingsVisible ? raw.ratingOverallAvg : null,
    rating_onboarding_avg: ratingsVisible ? raw.ratingOnboardingAvg : null,
    created_at: raw.createdAt,
    updated_at: raw.updatedAt,
  };
}

const VALID_WOULD_RECOMMEND = new Set<PublicReview['would_recommend']>(['yes', 'no', 'maybe']);

export function toPublicReview(raw: RawPublicReviewRow): PublicReview {
  const wouldRecommend = raw.wouldRecommend as PublicReview['would_recommend'] | null;
  return {
    id: raw.id,
    rating_overall: raw.ratingOverall,
    rating_onboarding: raw.ratingOnboarding,
    title: raw.title,
    body: raw.body,
    role_at_company: raw.roleAtCompany,
    years_using: raw.yearsUsing,
    would_recommend: VALID_WOULD_RECOMMEND.has(wouldRecommend) ? wouldRecommend : null,
    verified_work_email: raw.verifiedWorkEmail,
    created_at: raw.createdAt,
  };
}

/** Shape an admin moderation row (`adminReviewConfig`) into `AdminReview` (§5.13).
 *  `emailByReviewerId` carries the out-of-band `auth.users.email` lookup (seam #2);
 *  an anonymized review or a missing entry → `reviewer_email: null`. */
export function toAdminReview(
  raw: RawAdminReviewRow,
  emailByReviewerId: ReadonlyMap<string, string>,
): AdminReview {
  const wouldRecommend = raw.wouldRecommend as AdminReview['would_recommend'] | null;
  return {
    id: raw.id,
    product: { id: raw.product.id, name: raw.product.name, slug: raw.product.slug },
    reviewer_email: raw.reviewerId ? (emailByReviewerId.get(raw.reviewerId) ?? null) : null,
    reviewer_firm: raw.reviewerFirm,
    rating_overall: raw.ratingOverall,
    rating_onboarding: raw.ratingOnboarding,
    title: raw.title,
    body: raw.body,
    role_at_company: raw.roleAtCompany,
    years_using: raw.yearsUsing,
    would_recommend: VALID_WOULD_RECOMMEND.has(wouldRecommend) ? wouldRecommend : null,
    verified_work_email: raw.verifiedWorkEmail,
    locale: raw.locale,
    status: raw.status as AdminReview['status'],
    toxicity_score: raw.toxicityScore,
    rejection_reason: raw.rejectionReason,
    moderated_at: raw.moderatedAt,
    created_at: raw.createdAt,
  };
}

const VALID_REVIEW_STATUS = new Set<ReviewStatus>(['pending', 'approved', 'rejected']);

/** Shape an own-review row (`accountReviewConfig`) into `AccountReview` (§5.11).
 *  An off-contract `status` degrades to `'pending'`; no PII/admin columns. */
export function toAccountReview(raw: RawAccountReviewRow): AccountReview {
  const status = raw.status as ReviewStatus;
  return {
    id: raw.id,
    product: { id: raw.product.id, name: raw.product.name, slug: raw.product.slug },
    rating_overall: raw.ratingOverall,
    rating_onboarding: raw.ratingOnboarding,
    title: raw.title,
    status: VALID_REVIEW_STATUS.has(status) ? status : 'pending',
    rejection_reason: raw.rejectionReason,
    created_at: raw.createdAt,
  };
}

// ---------------------------------------------------------------------------
// Admin vendor-request (`AdminVendorRequest`, §6.9) — moved from prisma-helpers.
// ---------------------------------------------------------------------------

/** Admin requests `columns` config (`AdminVendorRequest`, AECI-216 / Phase 6.9).
 *  Selects the full `vendor_requests` row the admin queue surfaces, INCLUDING the
 *  keys the list handler groups on to derive `is_duplicate` (`kind`, `targetType`,
 *  `targetId`, `submitterEmail`). `is_duplicate` itself has no column — it's
 *  computed at read time and passed to `toAdminVendorRequest`. No relations: every
 *  field is a `vendor_requests` scalar. The polymorphic target (`target_type`,
 *  `target_id`) is hydrated separately via `resolveRequestTargets` — a batch lookup
 *  against the products/vendors tables (AECI-217) — and the resolved `LinkRef` is
 *  passed into `toAdminVendorRequest`. (A relational `with` can't model the
 *  same-field-two-tables polymorphism here.) */
export const adminVendorRequestConfig = {
  columns: {
    id: true,
    kind: true,
    status: true,
    targetType: true,
    targetId: true,
    submitterEmail: true,
    submitterName: true,
    submitterRole: true,
    domainMatch: true,
    body: true,
    sourceUrl: true,
    linearIssueId: true,
    linearIssueUrl: true,
    // AECI-521: the Phase-6 duplicate chain, surfaced only by the claims LIST
    // (`toAdminClaim`); harmless to the requests path, which never reads it.
    duplicateOfRequestId: true,
    createdAt: true,
    resolvedAt: true,
    resolvedById: true,
  },
} as const;

export interface RawAdminVendorRequestRow {
  id: string;
  kind: string;
  status: string;
  targetType: string;
  targetId: string;
  submitterEmail: string;
  submitterName: string | null;
  submitterRole: string | null;
  domainMatch: string;
  body: string;
  sourceUrl: string | null;
  linearIssueId: string | null;
  linearIssueUrl: string | null;
  duplicateOfRequestId: string | null;
  createdAt: string;
  resolvedAt: string | null;
  resolvedById: string | null;
}

/**
 * Batch-resolve the polymorphic `(target_type, target_id)` of a page of vendor
 * requests into a `Map<target_id, LinkRef>` (AECI-217). One `IN (...)` query per
 * target table (skipped when that page has none) — no per-row N+1. The
 * `/admin/requests` UI needs name/slug to link the target, but detail pages are
 * slug-only with no by-id route, so the API resolves the link here. A request whose
 * target row is missing (deleted/un-promoted) simply gets no map entry → the
 * caller passes `null` and the UI shows a non-linked label. Vendors expose their
 * label as `companyName`, mapped to `LinkRef.name`.
 *
 * Second caller (AECI-577): `listPageViews` in `lib/admin-analytics.ts` hydrates
 * the Activity feed's `entity` the same way. A `page_views` row carries
 * `product_id` XOR `vendor_id` rather than a `(type, id)` pair, so it maps its
 * rows into this shape first; product and vendor ids are both UUIDs, so the one
 * returned map cannot collide.
 */
export async function resolveRequestTargets(
  db: Db,
  rows: ReadonlyArray<{ targetType: string; targetId: string }>,
): Promise<Map<string, LinkRef>> {
  const productIds = [
    ...new Set(rows.filter((r) => r.targetType === 'product').map((r) => r.targetId)),
  ];
  const vendorIds = [
    ...new Set(rows.filter((r) => r.targetType === 'vendor').map((r) => r.targetId)),
  ];
  const map = new Map<string, LinkRef>();
  await Promise.all([
    productIds.length === 0
      ? Promise.resolve()
      : db
          .select({ id: products.id, name: products.name, slug: products.slug })
          .from(products)
          .where(inArray(products.id, productIds))
          .then((ps) => {
            for (const p of ps) map.set(p.id, { id: p.id, name: p.name, slug: p.slug });
          }),
    vendorIds.length === 0
      ? Promise.resolve()
      : db
          .select({ id: vendors.id, name: vendors.companyName, slug: vendors.slug })
          .from(vendors)
          .where(inArray(vendors.id, vendorIds))
          .then((vs) => {
            for (const v of vs) map.set(v.id, { id: v.id, name: v.name, slug: v.slug });
          }),
  ]);
  return map;
}

/** Map a raw `vendor_requests` row → `AdminVendorRequest` (camelCase → snake_case;
 *  D1 `*_at` are already ISO text, so no `Date` conversion). `is_duplicate` is
 *  supplied by the caller (the list handler computes it page-wide; the single-row
 *  PATCH confirmation passes `false`). `kind`/`status`/`target_type` cast to their
 *  enums — the DB CHECK guarantees the value and dev response-validation catches
 *  drift (same pattern as `toAdminReview`'s `status`). */
export function toAdminVendorRequest(
  raw: RawAdminVendorRequestRow,
  isDuplicate: boolean,
  target: LinkRef | null = null,
  /** AECI-527 reviewer signal, keyed by `submitter_email` VERBATIM (see
   *  `fetchAuthAccountsByEmail`) so there is no normalization here. Defaulted to
   *  empty so the single-row PATCH confirmation — which does not fan out to
   *  GoTrue — reports `null` without needing to pass anything. */
  authAccountByEmail: ReadonlyMap<string, boolean> = new Map(),
): AdminVendorRequest {
  return {
    id: raw.id,
    kind: raw.kind as AdminVendorRequest['kind'],
    status: raw.status as AdminVendorRequest['status'],
    target_type: raw.targetType as AdminVendorRequest['target_type'],
    target_id: raw.targetId,
    target,
    submitter_email: raw.submitterEmail,
    submitter_name: raw.submitterName,
    submitter_role: raw.submitterRole,
    domain_match: raw.domainMatch,
    body: raw.body,
    source_url: raw.sourceUrl,
    is_duplicate: isDuplicate,
    // Claim-only: a correction never links an account, so it must not inherit the
    // signal from a claim row that happens to share a submitter email on the same
    // page. Keep this gate in step with the fetch-side gate in `admin-requests.ts`.
    has_auth_account:
      raw.kind === 'claim' ? (authAccountByEmail.get(raw.submitterEmail) ?? null) : null,
    linear_issue_id: raw.linearIssueId,
    linear_issue_url: raw.linearIssueUrl,
    created_at: raw.createdAt,
    resolved_at: raw.resolvedAt,
    resolved_by: raw.resolvedById,
  };
}

/** Map a raw `vendor_requests` claim row → `AdminClaim` (AECI-521): the shared
 *  `AdminVendorRequest` (delegated to `toAdminVendorRequest`, so the two never
 *  drift) plus the claim-only reviewer signals. `existingSeats` /
 *  `relatedRequests` are supplied by the LIST handler's fail-soft enrichment —
 *  `null` = signal unavailable (degraded), `[]` = computed-and-empty.
 *
 *  `entitlementVendor` / `entitlement` (AECI-532 / §5) are the same shape: the
 *  RESOLVED target vendor (a product claim → its primary vendor) and its current
 *  entitlement, so the queue can render the entitlement column and address the
 *  `PATCH /api/admin/vendors/:id/entitlement` control. Both null when there is no
 *  vendor to act on or the enrichment degraded. */
export function toAdminClaim(
  raw: RawAdminVendorRequestRow,
  isDuplicate: boolean,
  target: LinkRef | null,
  authAccountByEmail: ReadonlyMap<string, boolean>,
  existingSeats: AdminVendorSeat[] | null,
  relatedRequests: RelatedRequestRef[] | null,
  entitlementVendor: LinkRef | null = null,
  entitlement: VendorEntitlementResponse | null = null,
): AdminClaim {
  return {
    ...toAdminVendorRequest(raw, isDuplicate, target, authAccountByEmail),
    duplicate_of_request_id: raw.duplicateOfRequestId,
    existing_seats: existingSeats,
    related_requests: relatedRequests,
    entitlement_vendor: entitlementVendor,
    entitlement,
  };
}

export function toProductDetail(
  raw: RawProductDetailRow,
  relatedProducts: RawProductListRow[],
  reviews: RawPublicReviewRow[] = [],
): ProductDetail {
  // `toProductListItem` already applies the §5.5 ≥5-review gate (nulling the
  // averages below the threshold), so the detail inherits it via the spread.
  const base = toProductListItem(raw);
  return {
    ...base,
    description: raw.description,
    website: raw.website,
    tool_integrations_url: raw.toolIntegrationsUrl,
    api_docs_url: raw.apiDocsUrl,
    has_api_docs: raw.hasApiDocs,
    categories: raw.productCategories.map((r) => ({
      id: r.category.id,
      name: r.category.name,
      slug: r.category.slug,
    })),
    audiences: raw.productAudiences.map((r) => r.audience),
    phases: raw.productPhases.map((r) => r.phase),
    trades: raw.productTrades.map((r) => r.trade),
    usefulness: toUsefulness(raw.usefulness),
    // Source bucket: this product IS the integration's source (contextIsSource:
    // true → outbound flows read outbound); target bucket is the mirror.
    integrations_as_source: raw.sourceIntegrations.map((r) => toProductIntegrationItem(r, true)),
    integrations_as_target: raw.targetIntegrations.map((r) => toProductIntegrationItem(r, false)),
    // Connector bucket: this product is the mechanism, not an endpoint — bare
    // list items (no context_direction; direction is between source and target).
    //
    // TWO sources, unioned (AECI-721 / §13.1): edges still in `integrations`
    // carrying `powered_by_product_id`, and edges that have moved to the
    // connector lane's delivered tier. The union is what makes the migration
    // invisible here — the rendered set is the same before and after.
    //
    // SELF-EXCLUSION (§13.4(2)): `poweredIntegrations` is a bare `many(...)` with
    // no `where`, so it selects on `powered_by_product_id` alone. Review-side
    // Convention A stores "product X ships a connector on platform C" as ONE edge
    // whose `powered_by` IS one of its own endpoints — 60 production rows
    // (Aquifer 31, Kroo 29). On C's own page such an edge lands in
    // `sourceIntegrations`/`targetIntegrations` AND here, rendering twice.
    // AECI-706's backfill switched that on; the filter below is what turns it off.
    // The evidenced-pair arm needs no equivalent — its
    // `connector_evidenced_pairs_distinct_connector` CHECK makes the case
    // unrepresentable.
    integrations_as_connector: [
      ...raw.poweredIntegrations
        .filter((r) => r.sourceProduct.id !== raw.id && r.targetProduct.id !== raw.id)
        .map(toIntegrationListItem),
      ...raw.evidencedPairsAsConnector.map(toIntegrationListItemFromEvidencedPair),
    ],
    related_products: relatedProducts.map(toProductListItem),
    reviews: reviews.map(toPublicReview),
    maintenance: toMaintenance(raw),
  };
}

/**
 * The maintenance marker's payload for one record (AECI-616 / §13).
 *
 * `maintained_by` is narrowed rather than cast: the DB CHECK constrains it, but the
 * column is TEXT, and a row that somehow escaped the constraint should render AECi
 * attribution — the conservative reading — instead of failing the response parse.
 */
export function toMaintenance(raw: {
  maintainedBy: string;
  lastReviewedAt: string | null;
}): Maintenance {
  return {
    maintained_by: raw.maintainedBy === 'vendor' ? 'vendor' : 'aeci',
    last_reviewed_at: raw.lastReviewedAt,
  };
}

export function toVendorListItem(raw: RawVendorListRow): VendorListItem {
  return {
    id: raw.id,
    slug: raw.slug,
    company_name: raw.companyName,
    logo_url: raw.logoUrl,
    verified: raw.verified,
    headquarters: raw.headquarters,
    founded_year: raw.foundedYear,
    product_count: raw.productCount,
    integration_count: raw.integrationCount,
    review_count: 0, // No vendor review aggregate in Stage 1 (placeholder per schema).
    created_at: raw.createdAt,
    updated_at: raw.updatedAt,
  };
}

export function toVendorDetail(raw: RawVendorDetailRow): VendorDetail {
  return {
    ...toVendorListItem(raw),
    description: raw.description,
    website: raw.website,
    linkedin_url: raw.linkedinUrl,
    x_url: raw.xUrl,
    facebook_url: raw.facebookUrl,
    instagram_url: raw.instagramUrl,
    youtube_url: raw.youtubeUrl,
    products: raw.productVendors.map((r) => toProductListItem(r.product)),
    maintenance: toMaintenance(raw),
  };
}

export function toTaxonomyTermWithCount(raw: RawTaxonomyTermRow): TaxonomyTermWithCount {
  return {
    id: raw.id,
    name: raw.name,
    slug: raw.slug,
    description: raw.description,
    display_order: raw.displayOrder ?? 0,
    product_count: raw.productCount,
  };
}

// ---------------------------------------------------------------------------
// Product `where` builder (shared by the list + facets endpoints)
// ---------------------------------------------------------------------------

export type ProductFacetDimension = 'category' | 'audience' | 'phase' | 'trade';

export type ProductFilterParams = {
  search?: string;
  category_id?: string[];
  audience_id?: string[];
  phase_id?: string[];
  trade_id?: string[];
  vendor_id?: string;
  product_role?: string;
  has_api_docs?: boolean;
};

/**
 * Build the Drizzle `where` (a single `SQL` or undefined) for the products list.
 * Taxonomy multi-select matches OR-within-dimension via an `id IN (subquery)`
 * over the join table (AECI-223); dimensions AND across. `excludeDimension`
 * powers disjunctive faceting. `db` is needed to build the correlated subqueries.
 */
export function buildProductsWhere(
  db: Db,
  query: ProductFilterParams,
  excludeDimension?: ProductFacetDimension,
): SQL | undefined {
  const clauses: SQL[] = [];
  if (query.search) clauses.push(like(products.name, `%${query.search}%`));
  if (query.category_id?.length && excludeDimension !== 'category') {
    clauses.push(
      inArray(
        products.id,
        db
          .select({ id: productCategories.productId })
          .from(productCategories)
          .where(inArray(productCategories.categoryId, query.category_id)),
      ),
    );
  }
  if (query.audience_id?.length && excludeDimension !== 'audience') {
    clauses.push(
      inArray(
        products.id,
        db
          .select({ id: productAudiences.productId })
          .from(productAudiences)
          .where(inArray(productAudiences.audienceId, query.audience_id)),
      ),
    );
  }
  if (query.phase_id?.length && excludeDimension !== 'phase') {
    clauses.push(
      inArray(
        products.id,
        db
          .select({ id: productPhases.productId })
          .from(productPhases)
          .where(inArray(productPhases.phaseId, query.phase_id)),
      ),
    );
  }
  if (query.trade_id?.length && excludeDimension !== 'trade') {
    clauses.push(
      inArray(
        products.id,
        db
          .select({ id: productTrades.productId })
          .from(productTrades)
          .where(inArray(productTrades.tradeId, query.trade_id)),
      ),
    );
  }
  if (query.vendor_id) {
    clauses.push(
      inArray(
        products.id,
        db
          .select({ id: productVendors.productId })
          .from(productVendors)
          .where(eq(productVendors.vendorId, query.vendor_id)),
      ),
    );
  }
  if (query.product_role) clauses.push(eq(products.productRole, query.product_role));
  if (query.has_api_docs !== undefined) clauses.push(eq(products.hasApiDocs, query.has_api_docs));

  // `like` on SQLite is case-insensitive for ASCII by default — matches the old
  // Prisma `mode: 'insensitive'` intent for the product-name search.
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : and(...clauses);
}
