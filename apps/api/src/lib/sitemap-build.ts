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
 * The URL set itself, with every rule that decides it (the visibility filter, the
 * pair dedupe, the retired-slug rule and the trade gate), lives in
 * `listCatalogUrls` (`./catalog-urls`) since AECI-818, because the search console
 * computes its lanes over the same set. This module only renders it.
 */
import { type SitemapEntry, SITEMAP_MAX_URLS, renderSitemapUrls } from '@aeci/shared';

import type { Db } from '../db/client';
import { listCatalogUrls, type CatalogPageType } from './catalog-urls';

/** The built fragment and what it was built against. */
export interface CatalogSitemap {
  /** The `<url>` elements, each newline-terminated. No prolog, no `<urlset>`. */
  xml: string;
  urlCount: number;
  /** The origin every `<loc>` was built on, with no trailing slash. */
  base: string;
}

/** `<changefreq>` and `<priority>` per page type, as the SSR builder emitted them. */
const SITEMAP_HINTS: Record<CatalogPageType, Pick<SitemapEntry, 'changefreq' | 'priority'>> = {
  product: { changefreq: 'weekly', priority: 0.7 },
  vendor: { changefreq: 'weekly', priority: 0.7 },
  pair: { changefreq: 'weekly', priority: 0.6 },
  category: { changefreq: 'weekly', priority: 0.5 },
  audience: { changefreq: 'weekly', priority: 0.5 },
  phase: { changefreq: 'weekly', priority: 0.5 },
  trade: { changefreq: 'weekly', priority: 0.5 },
};

/**
 * Reads the catalog in one batch and renders its `<url>` elements against `base`.
 * Pass a primary-anchored client: a replica can lag the commit that marked the
 * sitemap dirty, and the build would then miss the write that asked for it.
 */
export async function buildCatalogSitemap(db: Db, base: string): Promise<CatalogSitemap> {
  const origin = base.replace(/\/+$/, '');
  const entries: SitemapEntry[] = (await listCatalogUrls(db)).map((u) => ({
    loc: `${origin}${u.path}`,
    ...(u.lastmod !== undefined ? { lastmod: u.lastmod } : {}),
    ...SITEMAP_HINTS[u.pageType],
  }));

  if (entries.length > SITEMAP_MAX_URLS) {
    console.warn(
      `[sitemap] ${entries.length} catalog URLs exceeds the ${SITEMAP_MAX_URLS}-URL sitemap ` +
        `protocol limit; a <sitemapindex> split is required (deferred per AECI-63).`,
    );
  }

  return { xml: renderSitemapUrls(entries), urlCount: entries.length, base: origin };
}
