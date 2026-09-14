/**
 * Which public URLs a vendor-portal write should ask the search engines to
 * re-fetch, and how important each one is (AECI-944 / AECI-945 / §20.2).
 *
 * The vendor-side counterpart to `promote-indexnow-urls.ts` (IndexNow) and
 * `promote-gsc-recrawl-entries.ts` (Google). Same split, same reasons:
 *
 *   - `indexNow` is free, batched and unranked, so it takes everything the edit
 *     touched, hub pages included.
 *   - `gsc` is quota-capped and worked by hand, so it takes entity detail pages
 *     only, each carrying the reason that ranks it.
 *
 * ─── The material/minor distinction, and why it lives here ───────────────────
 *
 * A vendor edit is not one kind of event. Rewriting a product's description
 * changes what the page *says* and is worth one of the day's few Request
 * Indexing slots. Swapping a logo or fixing a link changes the page without
 * changing its answer to any search query, and is not.
 *
 * Both still get queued — the tier system ranks rather than filters, so nothing
 * is silently discarded (see `lib/gsc-recrawl-priority.ts`). The minor edit
 * simply lands in tier 4 and waits, possibly forever, which is the correct
 * outcome rather than a lost one.
 *
 * The split is expressed as an explicit set of *material* fields rather than a
 * set of minor ones, deliberately. A new editable column added to
 * `PRODUCT_COLUMN_MAP` or `VENDOR_COLUMN_MAP` then defaults to **minor**, which
 * is the safe direction: a genuinely important new field gets under-prioritised
 * until someone notices, whereas a deny-list would silently promote every new
 * link field to tier 2 and crowd out real work.
 */

import {
  facetUrl,
  pairUrl,
  productUrl,
  productsIndexUrl,
  tradeUrl,
  tradesIndexUrl,
  vendorUrl,
} from '../lib/public-urls';

import type { GscRecrawlEntry } from '../lib/gsc-recrawl-priority';
import type { VendorRecrawl } from './vendor-shared';

/**
 * Product fields whose change alters what the page says.
 *
 * `description` only. The other four editable columns — `website`,
 * `tool_integrations_url`, `api_docs_url`, `logo_url` — are links and an image;
 * they change the page's furniture, not its content.
 *
 * Keyed on the **payload** field names (snake_case, as the vendor sends them)
 * rather than the Drizzle column names, because the audit entry's `fields` list
 * is already in that vocabulary and re-deriving it would be a second place to
 * get the mapping wrong.
 */
export const MATERIAL_PRODUCT_FIELDS: ReadonlySet<string> = new Set(['description']);

/**
 * Vendor-profile fields whose change alters what the page says.
 *
 * `description` for the same reason as above. `headquarters`, `founded_year`,
 * `public_private` and `parent_company` are the company-facts block, which is
 * rendered as prose on the vendor page and is exactly the kind of thing a
 * "who owns X" query matches.
 *
 * Everything else on `VENDOR_COLUMN_MAP` is a URL, a logo, a phone number or a
 * social handle.
 */
export const MATERIAL_VENDOR_FIELDS: ReadonlySet<string> = new Set([
  'description',
  'headquarters',
  'founded_year',
  'public_private',
  'parent_company',
]);

/** The facet buckets a product edit can move, minus trades — which are
 *  publication-gated and handled separately. */
const UNGATED_FACETS = ['categories', 'audiences', 'phases'] as const;

/** A product's facet membership, before or after an edit. Structurally the
 *  `TaxonomySlugs` shape from `vendor.ts`, restated here so this module does not
 *  import from the handler it feeds. */
export interface RecrawlTaxonomySlugs {
  categories: readonly string[];
  audiences: readonly string[];
  phases: readonly string[];
  trades: readonly string[];
}

/**
 * Re-crawl payload for `PATCH /api/vendor/products/:id`.
 *
 * `publishedTradeSlugs` must already be through the publication floor
 * (`resolvePublishedTradeSlugs`, run post-commit). Passing an unfiltered list
 * would queue `/trades/{slug}` pages that render `noindex` — the contradiction
 * the gate exists to prevent, and on the Google side it would also spend quota
 * to be told no.
 *
 * A taxonomy change counts as **material** even when no column changed: moving a
 * product between categories changes the facet chips the page renders and moves
 * it between browse pages, which is a different answer to a different query.
 */
export function productEditRecrawl(
  base: string,
  slug: string,
  editedFields: readonly string[],
  before: RecrawlTaxonomySlugs,
  after: RecrawlTaxonomySlugs,
  publishedTradeSlugs: readonly string[] = [],
): VendorRecrawl {
  const indexNow = new Set<string>([productUrl(base, slug), productsIndexUrl(base)]);

  // Every browse page the product joined or left, both sides of the union — the
  // page it left never carried this product's tag either. Mirrors
  // `productEditTags`; keep the two in lockstep.
  let taxonomyChanged = false;
  for (const facet of UNGATED_FACETS) {
    const union = new Set<string>([...before[facet], ...after[facet]]);
    if (!sameSet(before[facet], after[facet])) taxonomyChanged = true;
    for (const termSlug of union) indexNow.add(facetUrl(base, facet, termSlug));
  }
  if (!sameSet(before.trades, after.trades)) taxonomyChanged = true;

  // Trades: only the PUBLISHED ones become URLs, and the `/trades` index moves
  // whenever the set changed at all, because its tiles are floor-filtered.
  for (const termSlug of publishedTradeSlugs) indexNow.add(tradeUrl(base, termSlug));
  if (!sameSet(before.trades, after.trades)) indexNow.add(tradesIndexUrl(base));

  const material =
    taxonomyChanged || editedFields.some((field) => MATERIAL_PRODUCT_FIELDS.has(field));

  const gsc: GscRecrawlEntry[] = [
    { url: productUrl(base, slug), reason: material ? 'product.updated' : 'product.minor' },
    // A newly published trade page is a page that was `noindex` a moment ago, so
    // it is genuinely new to Google whatever the row's age. Same reason and tier
    // the promote path gives it.
    ...publishedTradeSlugs.map(
      (termSlug): GscRecrawlEntry => ({
        url: tradeUrl(base, termSlug),
        reason: 'trade.published',
      }),
    ),
  ];

  return { indexNow: [...indexNow], gsc };
}

/**
 * Re-crawl payload for `PATCH /api/vendor/profile`.
 *
 * Only the vendor's own page. A product detail page embeds its vendor and so
 * carries the `vendor:{slug}` cache tag, which is why the purge needs nothing
 * more — but a *crawler* re-fetching every product of a vendor who corrected
 * their phone number is exactly the waste the tiers exist to avoid, and the
 * embedded block is a line of metadata rather than the page's answer.
 */
export function vendorProfileRecrawl(
  base: string,
  slug: string,
  editedFields: readonly string[],
): VendorRecrawl {
  const url = vendorUrl(base, slug);
  const material = editedFields.some((field) => MATERIAL_VENDOR_FIELDS.has(field));
  return {
    indexNow: [url],
    gsc: [{ url, reason: material ? 'vendor.updated' : 'vendor.minor' }],
  };
}

/**
 * Re-crawl payload for the three product-version writes —
 * `POST` / `PATCH` / `DELETE /api/vendor/products/:id/versions`.
 *
 * **Pair pages only, and the product's own page is deliberately absent.** A
 * `product_versions` row renders on the integration-pair page and nowhere else:
 * `routes/integrations.ts` loads the table for both endpoints of a pair, and no
 * product-detail read touches it. Announcing `/products/{slug}` would ask a
 * crawler to re-fetch a page this write did not change. `versionEditTags` still
 * purges `product:{slug}` because that is the tag the pair pages carry, which is
 * the cache layer reaching the same pages by a different route.
 *
 * `counterpartSlugs` comes from `readPairCounterpartSlugs`
 * (`lib/product-pair-slugs.ts`), run post-commit. It is a superset — see there.
 *
 * **Always tier 4 on the Google side**, for the same reason
 * {@link attestationEditRecrawl} is: a pair page cannot exist here without an
 * integration that already existed, so there is no `pair.created` path, and what
 * changed is a version selector rather than the page's own copy.
 */
export function productVersionRecrawl(
  base: string,
  productSlug: string,
  counterpartSlugs: readonly string[],
): VendorRecrawl {
  // Deduped on the built URL rather than on the slug: `pairUrl` sorts its two
  // slugs, so two different counterparts can never collide, but a caller that
  // repeats one would otherwise emit the same page twice.
  const urls = [...new Set(counterpartSlugs.map((other) => pairUrl(base, productSlug, other)))];
  return {
    indexNow: urls,
    gsc: urls.map((url): GscRecrawlEntry => ({ url, reason: 'pair.updated' })),
  };
}

/**
 * Re-crawl payload for the three claim/attestation writes —
 * `POST /api/vendor/claims`, and the attestation `PUT` / `DELETE`.
 *
 * All three change the same three pages, which is why they share one deriver:
 * the integration-pair page, and both endpoint product pages (whose integration
 * rows render the direction and the maintenance marker).
 *
 * **Always tier 4 on the Google side.** A vendor can only attest against a claim
 * on an integration that already exists, so the pair page already exists and is
 * already indexed — there is no `pair.created` path reachable from here. An
 * attestation is real, citable content and it is not nothing, but against a new
 * product page it is the lower-value use of a quota slot, which is what tier 4
 * encodes. The product pages are `product.minor` for the same reason: what
 * changed on them is one integration row's marker, not their own copy.
 *
 * If attestations later prove to be the thing that makes pair pages rank, the
 * fix is one line in `GSC_RECRAWL_PRIORITY`, not here.
 */
export function attestationEditRecrawl(
  base: string,
  sourceSlug: string,
  targetSlug: string,
): VendorRecrawl {
  const pair = pairUrl(base, sourceSlug, targetSlug);
  const source = productUrl(base, sourceSlug);
  const target = productUrl(base, targetSlug);
  return {
    indexNow: [pair, source, target],
    gsc: [
      { url: pair, reason: 'pair.updated' },
      { url: source, reason: 'product.minor' },
      { url: target, reason: 'product.minor' },
    ],
  };
}

/** Set equality over two slug lists. Both sides are deduped and sorted upstream
 *  (`vendor.ts` sorts the incoming set), but this does not assume it. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const seen = new Set(a);
  return b.every((value) => seen.has(value));
}
