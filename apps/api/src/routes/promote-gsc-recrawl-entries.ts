/**
 * Which public URLs a promote should put on the **Google** re-crawl worklist, and
 * why (AECI-945 / §20.2).
 *
 * ─── Why this is not `affectedUrlsForPromote` with an extra field ─────────────
 *
 * The IndexNow deriver next door returns a flat `string[]`. It has no reason to
 * carry provenance: IndexNow is free, batched and unranked, so every URL is equal
 * to every other and three specs pin that return shape.
 *
 * This list is **ranked and quota-bound**, so it needs to know which entity each
 * URL came from and whether that entity is new. Widening the sibling's return
 * type to carry a reason would make one function serve two consumers with
 * opposite needs, and would churn the specs that pin it. A parallel deriver over
 * the same `PromoteResponse` is cheaper and keeps each function's contract
 * single-purpose.
 *
 * ─── The lists are deliberately NOT the same set ──────────────────────────────
 *
 * `affectedUrlsForPromote` emits hub pages too — `/products`, `/categories`,
 * `/trades`, and `/` on a term creation. **This deriver emits none of them**, and
 * that is the substantive difference rather than an oversight.
 *
 * A hub page is the part of the site Google already re-crawls on its own: it is
 * linked from every page, it changes constantly, and it carries no content of its
 * own beyond the tiles. Spending a Request Indexing slot on `/products` buys
 * nothing and costs one of the few slots that could have gone to a page Google
 * has never seen. IndexNow can afford to be indiscriminate. This cannot.
 *
 * So the rule is: **entity detail pages only** — a product, a vendor, an
 * integration pair, and a trade page at the moment it becomes indexable.
 *
 * ─── Trades ───────────────────────────────────────────────────────────────────
 *
 * A `/trades/:slug` page is queued only when the term clears
 * `TRADE_PUBLISH_MIN_PRODUCTS` (§5.5a), which is the same publication gate the
 * IndexNow path applies, resolved by `resolvePublishedTradeSlugs` after the batch
 * commits. Asking Google to index a page that serves `noindex` is the exact
 * contradiction the gate exists to prevent — and unlike the IndexNow case it
 * would also burn quota to be told no.
 *
 * Note a published trade is `trade.published` regardless of whether the term was
 * newly minted, because trades are find-only (`PromoteTaxonomyOperation` is
 * `'created' | 'reused'` and a trade is always `'reused'`). What is new is the
 * page's *indexability*, not the row.
 *
 * The three sibling facets — categories, audiences, phases — are **not** queued
 * at all. They are ungated, so their pages are always indexable and always
 * linked from a hub, which puts them in the same class as the hubs themselves.
 */

import type { PromoteResponse } from '@aeci/shared';

import type { GscRecrawlEntry } from '../lib/gsc-recrawl-priority';

import { sortedPairSlugs } from './promote-pair';

/** The publication-gate result, resolved after the batch commits. Mirrors the
 *  `publishedTradeSlugs` half of `AffectedUrlOptions` — the `removedTradeSlugs`
 *  half is deliberately unused here, because a term falling BACK under the floor
 *  makes its page `noindex` and there is nothing to ask Google to look at. */
export interface GscRecrawlOptions {
  publishedTradeSlugs?: readonly string[];
}

/**
 * The worklist entries a promote produces.
 *
 * Walk order is fixed — product, vendors, integrations, trades — because
 * `dedupeByBestPriority` breaks ties by first occurrence, and a stable order is
 * what makes the same promote produce the same rows twice.
 *
 * Returns entries, not rows: `priority` is derived from `reason` at insert time
 * so a call site cannot disagree with the tier map.
 */
export function gscRecrawlEntriesForPromote(
  response: PromoteResponse,
  baseUrl: string,
  opts: GscRecrawlOptions = {},
): GscRecrawlEntry[] {
  const base = baseUrl.replace(/\/+$/, '');
  const entries: GscRecrawlEntry[] = [];

  // The product. `operation` is 'created' for a genuinely new row — including the
  // AECI-568 case where a dead `supabaseId` fell back to an insert, which is
  // correct here: the page really is new, whatever the review app believed.
  if (response.product) {
    entries.push({
      url: `${base}/products/${response.product.slug}`,
      reason: response.product.operation === 'created' ? 'product.created' : 'product.updated',
    });
  }

  // Vendors. A vendor blocked by a claim (AECI-520) is OMITTED from the array
  // rather than flagged, so iterating unconditionally excludes it for free.
  for (const vendor of response.vendors) {
    entries.push({
      url: `${base}/vendors/${vendor.slug}`,
      reason: vendor.operation === 'created' ? 'vendor.created' : 'vendor.updated',
    });
  }

  // Integration pairs. Both endpoint slugs are required — an integration whose
  // other end is not promoted renders no pair page, so there is nothing to index.
  //
  // A cross-table move between `integrations` and `connector_evidenced_pairs`
  // reports `updated` (AECI-888), which is the right answer here: the pair page
  // URL already existed and only its backing row moved.
  for (const integration of response.integrations) {
    if (integration.sourceSlug && integration.targetSlug) {
      const [context, other] = sortedPairSlugs(integration.sourceSlug, integration.targetSlug);
      entries.push({
        url: `${base}/products/${context}/integrations/${other}`,
        reason: integration.operation === 'created' ? 'pair.created' : 'pair.updated',
      });
    }
  }

  // Trades that are published as of after the commit. See the module header.
  for (const slug of opts.publishedTradeSlugs ?? []) {
    entries.push({ url: `${base}/trades/${slug}`, reason: 'trade.published' });
  }

  return entries;
}
