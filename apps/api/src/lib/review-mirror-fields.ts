/**
 * The review-app mirror's field map (AECI-1413, ADR 0044, `REVIEW_APP_PROMOTE_API.md`
 * §4d): the ONE place that says which live column becomes which v2 ownership-record
 * wire field, per entity. The v2 record builder (`lib/ownership-sync.ts`) projects
 * every row through {@link projectRow}, so a column is mirrored exactly when it has an
 * entry here.
 *
 * Wire names are the promote wire names (`@aeci/shared` `promote.ts`), so the review
 * app reverses its own promote mapping and needs no new vocabulary. A wire field that
 * promote never carries must be listed in {@link LIVE_ONLY_FIELDS} with its reason.
 *
 * `review-mirror-fields.spec.ts` is the drift control. It fails when:
 *
 * - a key of a vendor-input schema (the portal's profile, product, integration edit,
 *   integration create, claim create and attestation upsert bodies) has no entry and
 *   is not in {@link VENDOR_INPUTS_NOT_MIRRORED}, so a new vendor-editable field
 *   cannot ship without a mirror decision;
 * - an entry's wire field is in neither the promote schema nor
 *   {@link LIVE_ONLY_FIELDS};
 * - the map and the shared v2 content schemas disagree on the wire field set.
 *
 * Left out on purpose, so a write to one never reads as drift: derived and aggregate
 * columns (`verified`, `review_count`, rating averages, `integration_count`), the
 * timestamps `created_at` / `updated_at`, and the research, scoring and note columns
 * the review app authors itself. The shared content schemas name each one.
 */

import type {
  attestations,
  claims,
  connectorEvidencedPairs,
  integrations,
  products,
  vendors,
} from '../db/schema';

export const MIRROR_ENTITIES = [
  'vendor',
  'product',
  'integration',
  'connector_evidenced_pair',
  'claim',
] as const;
export type MirrorEntity = (typeof MIRROR_ENTITIES)[number];

type Cols<T> = Extract<keyof T, string>;
type VendorCol = Cols<typeof vendors.$inferSelect>;
type ProductCol = Cols<typeof products.$inferSelect>;
type IntegrationCol = Cols<typeof integrations.$inferSelect>;
type PairCol = Cols<typeof connectorEvidencedPairs.$inferSelect>;
type ClaimCol = Cols<typeof claims.$inferSelect> | Cols<typeof attestations.$inferSelect>;

/**
 * One mirrored field.
 *
 * - `column`: the key {@link projectRow} reads from the builder's row. For a direct
 *   column it is the Drizzle property on the entity's table, typed against
 *   `schema.ts`, so a renamed column fails `pnpm typecheck`. For a joined value it is
 *   the name the builder gives it, and `joined` says where it comes from.
 * - `wire`: the v2 wire field.
 * - `encode: 'ref'`: a non-null id goes out as `{ supabaseId }`, the promote
 *   `EntityRef` form.
 * - `inputs`: vendor-input keys that write this field, when they differ from the
 *   column's SQL name. A direct column's SQL name counts on its own.
 */
export interface MirrorField<C extends string = string> {
  readonly column: C;
  readonly wire: string;
  readonly encode?: 'ref';
  readonly joined?: string;
  readonly inputs?: readonly string[];
}

const VENDOR_FIELDS: readonly MirrorField<VendorCol>[] = [
  { column: 'companyName', wire: 'companyName' },
  { column: 'description', wire: 'description' },
  { column: 'website', wire: 'website' },
  { column: 'headquarters', wire: 'headquarters' },
  { column: 'foundedYear', wire: 'foundedYear' },
  { column: 'publicPrivate', wire: 'publicPrivate' },
  { column: 'parentCompany', wire: 'parentCompany' },
  { column: 'linkedinUrl', wire: 'linkedinUrl' },
  { column: 'xUrl', wire: 'xUrl' },
  { column: 'facebookUrl', wire: 'facebookUrl' },
  { column: 'instagramUrl', wire: 'instagramUrl' },
  { column: 'youtubeUrl', wire: 'youtubeUrl' },
  { column: 'crunchbaseUrl', wire: 'crunchbaseUrl' },
  { column: 'wikiUrl', wire: 'wikiUrl' },
  { column: 'githubOrg', wire: 'githubOrg' },
  { column: 'phoneNumber', wire: 'phoneNumber' },
  { column: 'contactEmail', wire: 'contactEmail' },
  { column: 'logoUrl', wire: 'logoUrl' },
  { column: 'lastReviewedAt', wire: 'lastReviewedAt' },
  { column: 'maintainedBy', wire: 'maintainedBy' },
];

type ProductJoined = 'categories' | 'audiences' | 'phases' | 'trades' | 'versions';

const PRODUCT_FIELDS: readonly MirrorField<ProductCol | ProductJoined>[] = [
  { column: 'name', wire: 'name' },
  { column: 'slug', wire: 'slug' },
  { column: 'productRole', wire: 'productRole' },
  { column: 'description', wire: 'description' },
  { column: 'website', wire: 'website' },
  { column: 'toolIntegrationsUrl', wire: 'toolIntegrationsUrl' },
  { column: 'apiDocsUrl', wire: 'apiDocsUrl' },
  { column: 'logoUrl', wire: 'logoUrl' },
  { column: 'usefulness', wire: 'usefulness' },
  {
    column: 'categories',
    wire: 'categories',
    joined: 'product_categories -> taxonomy_categories.slug',
    inputs: ['category_slugs'],
  },
  {
    column: 'audiences',
    wire: 'audiences',
    joined: 'product_audiences -> taxonomy_audiences.slug',
    inputs: ['audience_slugs'],
  },
  {
    column: 'phases',
    wire: 'phases',
    joined: 'product_phases -> taxonomy_phases.slug',
    inputs: ['phase_slugs'],
  },
  {
    column: 'trades',
    wire: 'trades',
    joined: 'product_trades -> taxonomy_trades.slug',
    inputs: ['trade_slugs'],
  },
  { column: 'lastReviewedAt', wire: 'lastReviewedAt' },
  { column: 'maintainedBy', wire: 'maintainedBy' },
  {
    column: 'versions',
    wire: 'versions',
    joined: 'product_versions { label, released_at, sunset_at } in sort_key order',
  },
];

const INTEGRATION_FIELDS: readonly MirrorField<IntegrationCol | 'vendorLinks'>[] = [
  { column: 'name', wire: 'name' },
  { column: 'sourceProductId', wire: 'sourceProduct', encode: 'ref', inputs: ['product_id'] },
  {
    column: 'targetProductId',
    wire: 'targetProduct',
    encode: 'ref',
    inputs: ['counterpart_product_id'],
  },
  { column: 'builtByVendorId', wire: 'builtByVendor', encode: 'ref' },
  { column: 'poweredByProductId', wire: 'poweredByProduct', encode: 'ref' },
  { column: 'mechanismKind', wire: 'mechanismKind' },
  { column: 'mechanismName', wire: 'mechanismName' },
  { column: 'direction', wire: 'direction' },
  { column: 'description', wire: 'description' },
  { column: 'listingUrl', wire: 'listingUrl' },
  { column: 'docsUrl', wire: 'docsUrl' },
  { column: 'website', wire: 'website' },
  { column: 'mechanismUrl', wire: 'mechanismUrl' },
  { column: 'pricingModel', wire: 'pricingModel' },
  { column: 'maturity', wire: 'maturity' },
  { column: 'pricingUrl', wire: 'pricingUrl' },
  { column: 'lastReviewedAt', wire: 'lastReviewedAt' },
  { column: 'maintainedBy', wire: 'maintainedBy' },
  { column: 'origin', wire: 'origin' },
  { column: 'claimedAt', wire: 'claimedAt' },
  { column: 'retiredAt', wire: 'retiredAt' },
  {
    column: 'vendorLinks',
    wire: 'vendorLinks',
    joined: 'integration_vendor_links { product_id, kind, url }',
  },
];

/**
 * A connector-evidenced pair goes out in the integration shape. Its id-sorted A and B
 * become `sourceProduct` and `targetProduct`, and its connector becomes
 * `poweredByProduct`, which is where promote's connector arm read it from (§3.4a).
 * It stores no `mechanism_kind`, so it has no entry and the key is absent.
 */
const PAIR_FIELDS: readonly MirrorField<PairCol | 'vendorLinks'>[] = [
  { column: 'name', wire: 'name' },
  { column: 'productAId', wire: 'sourceProduct', encode: 'ref' },
  { column: 'productBId', wire: 'targetProduct', encode: 'ref' },
  { column: 'builtByVendorId', wire: 'builtByVendor', encode: 'ref' },
  { column: 'connectorProductId', wire: 'poweredByProduct', encode: 'ref' },
  { column: 'mechanismName', wire: 'mechanismName' },
  { column: 'direction', wire: 'direction' },
  { column: 'description', wire: 'description' },
  { column: 'listingUrl', wire: 'listingUrl' },
  { column: 'docsUrl', wire: 'docsUrl' },
  { column: 'website', wire: 'website' },
  { column: 'mechanismUrl', wire: 'mechanismUrl' },
  { column: 'pricingModel', wire: 'pricingModel' },
  { column: 'maturity', wire: 'maturity' },
  { column: 'pricingUrl', wire: 'pricingUrl' },
  { column: 'lastReviewedAt', wire: 'lastReviewedAt' },
  { column: 'maintainedBy', wire: 'maintainedBy' },
  { column: 'origin', wire: 'origin' },
  { column: 'claimedAt', wire: 'claimedAt' },
  { column: 'retiredAt', wire: 'retiredAt' },
  {
    column: 'vendorLinks',
    wire: 'vendorLinks',
    joined: 'always []: integration_vendor_links references integrations rows only',
  },
];

type ClaimJoined = 'dataObject' | 'introducedVersion' | 'deprecatedVersion';

/** One claim slot: a `claims` row joined to one `attestations` row. */
const CLAIM_FIELDS: readonly MirrorField<ClaimCol | ClaimJoined>[] = [
  {
    column: 'dataObject',
    wire: 'dataObject',
    joined: 'claims.data_object_id -> taxonomy_data_objects.slug',
    inputs: ['data_object'],
  },
  { column: 'direction', wire: 'direction' },
  { column: 'source', wire: 'source' },
  { column: 'asserted', wire: 'asserted' },
  { column: 'note', wire: 'note' },
  {
    column: 'introducedVersion',
    wire: 'introducedVersion',
    joined: 'attestations.introduced_version_id -> product_versions.label',
    inputs: ['introduced_version_id'],
  },
  {
    column: 'deprecatedVersion',
    wire: 'deprecatedVersion',
    joined: 'attestations.deprecated_version_id -> product_versions.label',
    inputs: ['deprecated_version_id'],
  },
  { column: 'retractedAt', wire: 'retractedAt' },
];

export const REVIEW_MIRROR_FIELDS: Readonly<Record<MirrorEntity, readonly MirrorField[]>> = {
  vendor: VENDOR_FIELDS,
  product: PRODUCT_FIELDS,
  integration: INTEGRATION_FIELDS,
  connector_evidenced_pair: PAIR_FIELDS,
  claim: CLAIM_FIELDS,
};

export interface LiveOnlyField {
  readonly entity: MirrorEntity;
  readonly wire: string;
  readonly reason: string;
}

const maintainedByReason =
  'Promote refuses it on every entity; it flips only through a live vendor action (AECI-301).';
const ownershipStateReason =
  'Ownership state set only by live routes (ADR 0035); promote never writes it.';
const pricingUrlReason = 'Owner-edit-only field (AECI-1154); promote has no such field.';

/** Wire fields promote never carries, each with why the mirror sends it anyway. */
export const LIVE_ONLY_FIELDS: readonly LiveOnlyField[] = [
  { entity: 'vendor', wire: 'maintainedBy', reason: maintainedByReason },
  {
    entity: 'product',
    wire: 'slug',
    reason: 'Server-generated; lets a mirror row made for an unknown id link to its live URL.',
  },
  { entity: 'product', wire: 'maintainedBy', reason: maintainedByReason },
  {
    entity: 'product',
    wire: 'versions',
    reason: 'Vendors author product_versions in the portal; promote has no versions field.',
  },
  ...(['integration', 'connector_evidenced_pair'] as const).flatMap((entity) => [
    { entity, wire: 'pricingUrl', reason: pricingUrlReason },
    { entity, wire: 'maintainedBy', reason: maintainedByReason },
    { entity, wire: 'origin', reason: ownershipStateReason },
    { entity, wire: 'claimedAt', reason: ownershipStateReason },
    { entity, wire: 'retiredAt', reason: ownershipStateReason },
    {
      entity,
      wire: 'vendorLinks',
      reason: 'Endpoint vendors set integration_vendor_links in the portal; promote has none.',
    },
  ]),
  {
    entity: 'claim',
    wire: 'introducedVersion',
    reason: 'A product_versions label; promote carries only the dormant introducedAt date.',
  },
  {
    entity: 'claim',
    wire: 'deprecatedVersion',
    reason: 'A product_versions label; promote carries only the dormant deprecatedAt date.',
  },
  {
    entity: 'claim',
    wire: 'retractedAt',
    reason: 'Promote replaces attestations and never sends a retraction.',
  },
];

/** Vendor-input keys that write no mirrored column, each with why. */
export const VENDOR_INPUTS_NOT_MIRRORED: Readonly<Record<string, string>> = {
  context_product_id:
    'Frames a caller-relative direction or echo; nothing is stored from it (AECI-666).',
  integration_id:
    'The claim anchor; a claim slot rides inside its integration entry, not as a field.',
};

/**
 * Project one row onto its entity's wire fields. `row` carries every entry's `column`:
 * the Drizzle row plus the joined values the builder read. A missing key throws, so a
 * builder that forgot a column fails its test instead of sending a silent `null`. An
 * `undefined` or `null` value goes out as `null`. A `ref` field wraps a non-null id as
 * `{ supabaseId }`.
 *
 * The result is untyped on purpose: the builder parses it through the shared v2
 * content schema, which is what checks the values.
 */
export function projectRow(
  entity: MirrorEntity,
  row: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of REVIEW_MIRROR_FIELDS[entity]) {
    if (!(field.column in row)) {
      throw new Error(`projectRow(${entity}): the row has no "${field.column}"`);
    }
    const value = row[field.column] ?? null;
    out[field.wire] =
      field.encode === 'ref' && value !== null ? { supabaseId: value as string } : value;
  }
  return out;
}
