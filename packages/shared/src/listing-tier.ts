/**
 * `listing_tier` — the coarse listing-completeness tier carried on the `products`
 * and `vendors` Algolia records (AECI-636, product change 1).
 *
 * ── WHAT IT IS FOR ──────────────────────────────────────────────────────────────
 * AECI-636 retires `integration_count` as an ordering signal. Products and vendors
 * tie-break on this tier instead: "can a buyer evaluate this listing at all", in
 * three coarse buckets. `SEARCH_RANKING.md` §3.1 / §3.2 hold the definition.
 *
 * PR-A of the change only puts the field ON the records. `INDEX_SETTINGS` does not
 * name it yet, so it orders nothing until the settings change ships.
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────
 * Tier 2: every input present. Tier 1: description present, and one or two of the
 * others missing. Otherwise NO tier: the caller omits the attribute entirely,
 * because Algolia sorts a record that lacks a `customRanking` attribute last
 * regardless of asc/desc. There is no sentinel value, and never a `0`.
 *
 * A blank or whitespace-only string counts as missing, as does an empty category
 * list or a category list of blank names.
 *
 * ── CONTENT ONLY (the ranking firewall) ─────────────────────────────────────────
 * The inputs are the listing's own content fields and nothing else. Never plan
 * status, the entitlement, `verified`, `priority_tier`, `logo_source`, or anything
 * a vendor can buy. AECI-636's trap 1: a paid plan and a complete listing will
 * correlate over time, which is survivable only if the tier reads the record and
 * the free path can reach every tier. `entitlements.spec.ts` asserts this against
 * the declared input lists below AND against every property the functions actually
 * read, so adding a plan-shaped input fails the build.
 *
 * ── WHY IT LIVES HERE ───────────────────────────────────────────────────────────
 * Both record builders call it: the Worker transforms
 * (`apps/api/src/lib/algolia-transforms.ts`) and the datatool full reindex
 * (`apps/datatool/src/algolia-reindex.ts`, raw SQL). Two copies would drift, and
 * the two paths would disagree about where the same product ranks. Same reasoning
 * as `algoliaSortKey` / `flattenTradeAliases`. Dependency-free on purpose.
 */

/** The tier values a record may carry. "No tier" is attribute omission, not a value. */
export type ListingTier = 1 | 2;

/**
 * Every field `productListingTier` reads, by its record name. This list IS the
 * input contract: the input type is derived from it, and the firewall spec checks
 * both this list and the properties actually read against the entitlement vocabulary.
 */
export const PRODUCT_LISTING_TIER_INPUTS = [
  'name',
  'description',
  'categories',
  'website',
  'logo_url',
] as const;

/** Every field `vendorListingTier` reads. See {@link PRODUCT_LISTING_TIER_INPUTS}. */
export const VENDOR_LISTING_TIER_INPUTS = [
  'company_name',
  'description',
  'headquarters',
  'website',
  'logo_url',
] as const;

type ProductFieldTypes = {
  name: string;
  description: string | null;
  /** Category term names. At least one non-blank name counts as present. */
  categories: readonly string[];
  /** The product's OWN `products.website`, never its vendor's (AECI-636 D3). */
  website: string | null;
  logo_url: string | null;
};

type VendorFieldTypes = {
  company_name: string;
  description: string | null;
  headquarters: string | null;
  website: string | null;
  logo_url: string | null;
};

export type ProductListingTierInput = Pick<
  ProductFieldTypes,
  (typeof PRODUCT_LISTING_TIER_INPUTS)[number]
>;
export type VendorListingTierInput = Pick<
  VendorFieldTypes,
  (typeof VENDOR_LISTING_TIER_INPUTS)[number]
>;

function hasText(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** The shared threshold: `description` gates, then count what else is missing. */
function tierFrom(
  descriptionPresent: boolean,
  othersPresent: readonly boolean[],
): ListingTier | undefined {
  if (!descriptionPresent) return undefined;
  const missing = othersPresent.filter((present) => !present).length;
  if (missing === 0) return 2;
  if (missing <= 2) return 1;
  return undefined;
}

/**
 * Product tier over name, description, at least one category, website and logo.
 * Returns `undefined` for "no tier"; spread {@link listingTierField} into the
 * record rather than writing the key yourself.
 */
export function productListingTier(input: ProductListingTierInput): ListingTier | undefined {
  return tierFrom(hasText(input.description), [
    hasText(input.name),
    input.categories.some((name) => hasText(name)),
    hasText(input.website),
    hasText(input.logo_url),
  ]);
}

/** Vendor tier over company name, description, headquarters, website and logo. */
export function vendorListingTier(input: VendorListingTierInput): ListingTier | undefined {
  return tierFrom(hasText(input.description), [
    hasText(input.company_name),
    hasText(input.headquarters),
    hasText(input.website),
    hasText(input.logo_url),
  ]);
}

/**
 * The record fragment to spread into a product or vendor record:
 * `{ listing_tier: 1 | 2 }`, or `{}` when there is no tier.
 *
 * The key is OMITTED, never `null` or `undefined`. The sync writes with Algolia's
 * `updateObject` (a full replace), so a record that loses its tier loses the
 * attribute cleanly, and Algolia then sorts it last.
 */
export function listingTierField(
  tier: ListingTier | undefined,
): { listing_tier: ListingTier } | Record<string, never> {
  return tier === undefined ? {} : { listing_tier: tier };
}
