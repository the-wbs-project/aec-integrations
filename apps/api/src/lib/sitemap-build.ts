/**
 * The catalog half of `sitemap.xml` (AECI-1505, `docs/CACHE_STRATEGY.md` §5).
 *
 * Until AECI-1505 the SSR Worker built the whole sitemap on every edge miss by
 * paging `/api/products`, `/api/vendors` and `/api/integrations` 100 rows at a
 * time over the service binding: about 35 serial hops and 4 to 8 seconds in
 * production. This module replaces that walk with ONE `db.batch` of five reads,
 * and renders the result as `<url>` elements. The `sitemap-rebuild` cron stores
 * the fragment in `TAXONOMY_KV` (`lib/sitemap-store.ts`), and the SSR route streams
 * it between its own static and docs entries (`apps/web/src/server/sitemap.ts`).
 *
 * Every rule below is carried over from the SSR builder it replaces, so the URL set
 * is unchanged:
 *
 * - **Products and vendors are listed unfiltered**, as their list endpoints are.
 * - **One URL per unordered product PAIR** (AECI-294). The pair spans both live
 *   arms the integrations list reads: `integrations` and
 *   `connector_evidenced_pairs` (AECI-1091). The context is the alphabetically
 *   first slug, `defaultIntegrationContext`, which is SQLite's BINARY `min()`.
 *   `<lastmod>` is the newest `updated_at` across the pair's rows.
 * - **A retired slug is withheld** (AECI-978). `slug_redirects` is read in the
 *   same batch, and a `from_slug` is dropped from the product and vendor loops.
 * - **Trades are count-gated** (AECI-546, `TRADES_VOCABULARY.md` §6). A term below
 *   `TRADE_PUBLISH_MIN_PRODUCTS` renders `noindex`, so it is not listed. The three
 *   sibling facets are ungated.
 * - **Taxonomy terms carry no `<lastmod>`**: they expose no `updated_at`.
 *
 * Every read is ordered by `id`, BINARY. The sitemap protocol gives order no
 * meaning, and `name COLLATE NOCASE` was a sort the old pages paid for nothing.
 */
import {
  type SitemapEntry,
  SITEMAP_MAX_URLS,
  isPublishedTrade,
  liveEvidencedPairSql,
  liveIntegrationSql,
  renderSitemapUrls,
} from '@aeci/shared';
import { asc, sql } from 'drizzle-orm';

import type { Db } from '../db/client';
import { products, slugRedirects, vendors } from '../db/schema';

/** The built fragment and what it was built against. */
export interface CatalogSitemap {
  /** The `<url>` elements, each newline-terminated. No prolog, no `<urlset>`. */
  xml: string;
  urlCount: number;
  /** The origin every `<loc>` was built on, with no trailing slash. */
  base: string;
}

type TermKind = 'category' | 'audience' | 'phase' | 'trade';

/**
 * The pair rows across both live arms, as `(a, b, u)`: the two endpoint slugs and
 * the row's `updated_at`. Two compound terms, well under D1's five-term cap. The
 * aggregate over it is a builder select (`pairsQuery`), not `db.all`, so it stays
 * a lazy batch item on every driver.
 */
const PAIR_ROWS = sql.raw(`(
    SELECT sp.slug AS a, tp.slug AS b, i.updated_at AS u
      FROM integrations i
      JOIN products sp ON sp.id = i.source_product_id
      JOIN products tp ON tp.id = i.target_product_id
      WHERE ${liveIntegrationSql('i')}
    UNION ALL
    SELECT pa.slug AS a, pb.slug AS b, e.updated_at AS u
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
      (SELECT count(*) FROM product_trades pt WHERE pt.trade_id = t.id), t.id
      FROM taxonomy_trades t
  ) AS term_rows`);

/** `min(a, b)` / `max(a, b)` are SQLite's two-argument scalar forms, compared
 *  BINARY, which is `defaultIntegrationContext` (`a <= b ? a : b`). */
const PAIR_CONTEXT = sql<string>`min(a, b)`;
const PAIR_OTHER = sql<string>`max(a, b)`;

/**
 * Reads the catalog in one batch and renders its `<url>` elements against `base`.
 * Pass a primary-anchored client: a replica can lag the commit that marked the
 * sitemap dirty, and the build would then miss the write that asked for it.
 */
export async function buildCatalogSitemap(db: Db, base: string): Promise<CatalogSitemap> {
  const origin = base.replace(/\/+$/, '');

  const [productRows, vendorRows, pairRows, termRows, redirectRows] = await db.batch([
    db
      .select({ slug: products.slug, updatedAt: products.updatedAt })
      .from(products)
      .orderBy(asc(products.id)),
    db
      .select({ slug: vendors.slug, updatedAt: vendors.updatedAt })
      .from(vendors)
      .orderBy(asc(vendors.id)),
    db
      .select({ context: PAIR_CONTEXT, other: PAIR_OTHER, lastmod: sql<string>`max(u)` })
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

  const entries: SitemapEntry[] = [];
  for (const p of productRows) {
    if (isRetired('product', p.slug)) continue;
    entries.push({
      loc: `${origin}/products/${p.slug}`,
      lastmod: p.updatedAt,
      changefreq: 'weekly',
      priority: 0.7,
    });
  }
  for (const v of vendorRows) {
    if (isRetired('vendor', v.slug)) continue;
    entries.push({
      loc: `${origin}/vendors/${v.slug}`,
      lastmod: v.updatedAt,
      changefreq: 'weekly',
      priority: 0.7,
    });
  }
  for (const pair of pairRows) {
    entries.push({
      loc: `${origin}/products/${pair.context}/integrations/${pair.other}`,
      lastmod: pair.lastmod,
      changefreq: 'weekly',
      priority: 0.6,
    });
  }
  for (const term of termRows) {
    if (term.kind === 'trade' && !isPublishedTrade({ product_count: Number(term.n) })) continue;
    const segment = TERM_SEGMENT[term.kind];
    if (!segment) continue;
    entries.push({ loc: `${origin}/${segment}/${term.slug}`, changefreq: 'weekly', priority: 0.5 });
  }

  if (entries.length > SITEMAP_MAX_URLS) {
    console.warn(
      `[sitemap] ${entries.length} catalog URLs exceeds the ${SITEMAP_MAX_URLS}-URL sitemap ` +
        `protocol limit; a <sitemapindex> split is required (deferred per AECI-63).`,
    );
  }

  return { xml: renderSitemapUrls(entries), urlCount: entries.length, base: origin };
}

const TERM_SEGMENT: Record<TermKind, string> = {
  category: 'categories',
  audience: 'audiences',
  phase: 'phases',
  trade: 'trades',
};
