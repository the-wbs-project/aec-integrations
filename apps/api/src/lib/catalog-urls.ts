/**
 * The catalog URL set: every D1-backed page `sitemap.xml` lists (AECI-818,
 * `ADMIN_PANEL_SPEC.md` §5.24.5).
 *
 * Two callers read it, and both must see the same set:
 *
 * - `buildCatalogSitemap` (`./sitemap-build`) renders it as `<url>` elements.
 * - The search console (`./seo-queue`) computes every Panel 1 lane and every
 *   snapshot count over it.
 *
 * So the visibility filter, the retired-slug rule and the trade gate live here
 * once, and no caller restates them. Each rule is carried over unchanged from the
 * AECI-1505 sitemap builder:
 *
 * - **Products and vendors are listed unfiltered**, as their list endpoints are,
 *   apart from the AECI-1238 visibility filter.
 * - **One URL per unordered product PAIR** (AECI-294). The pair spans both live
 *   arms the integrations list reads: `integrations` and
 *   `connector_evidenced_pairs` (AECI-1091). The context is the alphabetically
 *   first slug, `defaultIntegrationContext`, which is SQLite's BINARY `min()`.
 *   `lastmod` is the newest `updated_at` across the pair's rows.
 * - **A retired slug is withheld** (AECI-978). `slug_redirects` is read in the
 *   same batch, and a `from_slug` is dropped from the product and vendor loops
 *   and, since AECI-979, from the taxonomy term loop.
 * - **Trades are count-gated** (AECI-546, `TRADES_VOCABULARY.md` §6). A term below
 *   `TRADE_PUBLISH_MIN_PRODUCTS` renders `noindex`, so it is not listed. The three
 *   sibling facets are ungated.
 * - **Taxonomy terms carry no `lastmod`**: they expose no `updated_at`.
 *
 * Each entry also carries its **publish anchor**, the date the page went live
 * (§5.24.5): `promoted_at`, else `created_at`, for a product; `created_at` for a
 * vendor; the earliest `created_at` across a pair's live rows, which is
 * approximate because a row moved between the two tables (AECI-888) carries its
 * move time. Taxonomy terms have none. The sitemap ignores the anchor.
 *
 * Every read is ordered by `id`, BINARY, so the list order is the sitemap order.
 */
import {
  endpointsVisibleSql,
  isPublishedTrade,
  liveEvidencedPairSql,
  liveIntegrationSql,
} from '@aeci/shared';
import { asc, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { products, slugRedirects, vendors } from '../db/schema';
import { visibleProductWhere, visibleVendorWhere } from './listing-visibility';

type TermKind = 'category' | 'audience' | 'phase' | 'trade';

export type CatalogPageType = 'product' | 'vendor' | 'pair' | TermKind;

/** One catalog page. `path` has no origin, so a caller with no public base can
 *  still count the set. */
export interface CatalogUrl {
  path: string;
  pageType: CatalogPageType;
  /** `<lastmod>`: the row's newest `updated_at`. Absent on taxonomy terms. */
  lastmod?: string;
  /** The publish anchor (§5.24.5), ISO 8601, or null for a taxonomy term. */
  publishedAt: string | null;
  /** The entity id, for a product or a vendor page. */
  entityId?: string;
  /** A pair page only: `[context, other]`, the two slugs in URL order. */
  pairSlugs?: readonly [string, string];
  /** A pair page only: true when either endpoint product has an approved
   *  review (`products.review_count > 0`), which is what the pair page renders. */
  pairHasReviews?: boolean;
}

/**
 * The pair rows across both live arms, as `(a, b, u, c, r)`: the two endpoint
 * slugs, the row's `updated_at` and `created_at`, and the two endpoints' summed
 * `review_count`. Two compound terms, well under D1's five-term cap. The
 * aggregate over it is a builder select, not `db.all`, so it stays a lazy batch
 * item on every driver.
 */
const PAIR_ROWS = sql.raw(`(
    SELECT sp.slug AS a, tp.slug AS b, i.updated_at AS u, i.created_at AS c,
           sp.review_count + tp.review_count AS r
      FROM integrations i
      JOIN products sp ON sp.id = i.source_product_id
      JOIN products tp ON tp.id = i.target_product_id
      WHERE ${liveIntegrationSql('i')}
    UNION ALL
    SELECT pa.slug AS a, pb.slug AS b, e.updated_at AS u, e.created_at AS c,
           pa.review_count + pb.review_count AS r
      FROM connector_evidenced_pairs e
      JOIN products pa ON pa.id = e.product_a_id
      JOIN products pb ON pb.id = e.product_b_id
      WHERE ${liveEvidencedPairSql('e')}
  ) AS pair_rows`);

/** Every taxonomy term, with the product count only trades are gated on. Four
 *  compound terms. The trade count is the subquery `tradeTermConfig` uses. `k`
 *  keeps the facets in the order the old builder listed them. */
const TERM_ROWS = sql.raw(`(
    SELECT 1 AS k, 'category' AS kind, t.slug AS slug, 0 AS n, t.id AS id FROM taxonomy_categories t
    UNION ALL
    SELECT 2, 'audience', t.slug, 0, t.id FROM taxonomy_audiences t
    UNION ALL
    SELECT 3, 'phase', t.slug, 0, t.id FROM taxonomy_phases t
    UNION ALL
    SELECT 4, 'trade', t.slug,
      (SELECT count(*) FROM product_trades pt WHERE pt.trade_id = t.id
         AND ${endpointsVisibleSql(['pt.product_id'])}), t.id
      FROM taxonomy_trades t
  ) AS term_rows`);

/** `min(a, b)` / `max(a, b)` are SQLite's two-argument scalar forms, compared
 *  BINARY, which is `defaultIntegrationContext` (`a <= b ? a : b`). */
const PAIR_CONTEXT = sql<string>`min(a, b)`;
const PAIR_OTHER = sql<string>`max(a, b)`;

const TERM_SEGMENT: Record<TermKind, string> = {
  category: 'categories',
  audience: 'audiences',
  phase: 'phases',
  trade: 'trades',
};

/**
 * Reads the catalog in ONE batch of five reads and returns every page, in
 * sitemap order: products, vendors, pairs, then taxonomy terms.
 *
 * The sitemap caller passes a primary-anchored client: a replica can lag the
 * commit that marked the sitemap dirty.
 */
export async function listCatalogUrls(db: Db): Promise<CatalogUrl[]> {
  const [productRows, vendorRows, pairRows, termRows, redirectRows] = await db.batch([
    db
      .select({
        id: products.id,
        slug: products.slug,
        updatedAt: products.updatedAt,
        createdAt: products.createdAt,
        promotedAt: products.promotedAt,
      })
      .from(products)
      // AECI-1238: a hidden listing leaves the sitemap. Its pairs leave through the
      // live predicate in `PAIR_ROWS`.
      .where(visibleProductWhere)
      .orderBy(asc(products.id)),
    db
      .select({
        id: vendors.id,
        slug: vendors.slug,
        updatedAt: vendors.updatedAt,
        createdAt: vendors.createdAt,
      })
      .from(vendors)
      .where(visibleVendorWhere)
      .orderBy(asc(vendors.id)),
    db
      .select({
        context: PAIR_CONTEXT,
        other: PAIR_OTHER,
        lastmod: sql<string>`max(u)`,
        firstCreated: sql<string>`min(c)`,
        reviews: sql<number>`max(r)`,
      })
      .from(PAIR_ROWS)
      .groupBy(PAIR_CONTEXT, PAIR_OTHER)
      .orderBy(PAIR_CONTEXT, PAIR_OTHER),
    db
      .select({
        kind: sql<TermKind>`kind`,
        slug: sql<string>`slug`,
        n: sql<number>`n`,
      })
      .from(TERM_ROWS)
      .orderBy(sql`k`, sql`id`),
    db
      .select({ entity: slugRedirects.entity, fromSlug: slugRedirects.fromSlug })
      .from(slugRedirects),
  ]);

  // AECI-978: keyed by the RAW entity string. An unknown kind matches nothing,
  // which is the correct degradation when a newer migration widens the CHECK.
  const retired = new Map<string, Set<string>>();
  for (const r of redirectRows) {
    const set = retired.get(r.entity) ?? new Set<string>();
    set.add(r.fromSlug);
    retired.set(r.entity, set);
  }
  const isRetired = (entity: string, slug: string) => retired.get(entity)?.has(slug) === true;

  const urls: CatalogUrl[] = [];
  for (const p of productRows) {
    if (isRetired('product', p.slug)) continue;
    urls.push({
      path: `/products/${p.slug}`,
      pageType: 'product',
      lastmod: p.updatedAt,
      publishedAt: p.promotedAt ?? p.createdAt,
      entityId: p.id,
    });
  }
  for (const v of vendorRows) {
    if (isRetired('vendor', v.slug)) continue;
    urls.push({
      path: `/vendors/${v.slug}`,
      pageType: 'vendor',
      lastmod: v.updatedAt,
      publishedAt: v.createdAt,
      entityId: v.id,
    });
  }
  for (const pair of pairRows) {
    urls.push({
      path: `/products/${pair.context}/integrations/${pair.other}`,
      pageType: 'pair',
      lastmod: pair.lastmod,
      publishedAt: pair.firstCreated ?? null,
      pairSlugs: [pair.context, pair.other],
      pairHasReviews: Number(pair.reviews) > 0,
    });
  }
  for (const term of termRows) {
    if (term.kind === 'trade' && !isPublishedTrade({ product_count: Number(term.n) })) continue;
    // AECI-979: a retired taxonomy slug only redirects. Normally its row is gone too,
    // but a mapping can be seeded ahead of the data op that deletes the term.
    if (isRetired(term.kind, term.slug)) continue;
    const segment = TERM_SEGMENT[term.kind];
    if (!segment) continue;
    urls.push({ path: `/${segment}/${term.slug}`, pageType: term.kind, publishedAt: null });
  }
  return urls;
}
