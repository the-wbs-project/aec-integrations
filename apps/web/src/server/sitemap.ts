/**
 * `GET /sitemap.xml` generation for the SSR Worker (AECI-63 / Phase 2.17).
 *
 * Two concerns live here, kept apart so the XML builder is trivially testable
 * without any I/O:
 *
 *   1. `buildSitemapXml(entries)` — a pure function turning a list of entries
 *      into a sitemaps.org-protocol `<urlset>` document.
 *   2. `resolveSitemapEntries(client, baseUrl)` — pulls every public entity
 *      from the API over the `env.API` service binding (the established
 *      `apps/web` data path; see `createServerApiClient`) and maps it to
 *      entries.
 *
 * The route wiring (headers, cache control) lives in `server-runtime.ts`.
 *
 * `<lastmod>` is emitted for products / vendors / integration PAIRS from their
 * `updated_at` (a pair uses the newest `updated_at` across its integrations —
 * AECI-294). Taxonomy terms (categories / audiences / phases / trades) expose no
 * `updated_at` anywhere in the API, so those entries carry no `<lastmod>` —
 * the field is optional in the sitemap protocol (AECI-63 decision).
 *
 * **Trades are the one count-gated facet** (AECI-546). A `/trades/:slug` term is
 * listed only once it clears `TRADE_PUBLISH_MIN_PRODUCTS` — a sub-floor page
 * renders `noindex`, and advertising a noindex'd URL in the sitemap is the
 * contradiction the publication gate exists to prevent. The gate lives here (and
 * in the browse resolver's meta), NOT in the API: `GET /api/taxonomy` returns
 * every term with its `product_count` and each surface applies the floor
 * (`TRADES_VOCABULARY.md` §6). The three sibling facets are ungated — their
 * vocabularies are curated to match the catalog rather than seeded closed, so a
 * zero-product category is a data problem, not an expected steady state.
 */
import { defaultIntegrationContext, isPublishedTrade } from '@aeci/shared';
import type {
  IntegrationListItem,
  PaginatedResponse,
  ProductListItem,
  TaxonomyResponse,
  VendorListItem,
} from '@aeci/shared';

import type { ServerApiClient } from '../server-api-client';

/** A single `<url>` entry in the sitemap. `lastmod` is optional per protocol. */
export interface SitemapEntry {
  loc: string;
  lastmod?: string;
  changefreq: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority: number;
}

/** Server-side cap on list endpoints (`PageQuerySchema.perPage` max). */
const PER_PAGE = 100;

/**
 * Sitemap protocol caps a single sitemap document at 50,000 URLs. At Stage 1
 * catalog size we are far below this; splitting into a `<sitemapindex>` of
 * sub-sitemaps is deliberately deferred (AECI-63 "out of scope") until the
 * catalog grows past the limit.
 */
export const SITEMAP_MAX_URLS = 50_000;

/** XML-escapes the five predefined entities so `<loc>` is always well-formed. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Renders entries into a protocol-valid `<urlset>` document. Pure — no I/O.
 */
export function buildSitemapXml(entries: readonly SitemapEntry[]): string {
  const urls = entries.map((entry) => {
    const lines = [`    <loc>${escapeXml(entry.loc)}</loc>`];
    if (entry.lastmod) lines.push(`    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`);
    lines.push(`    <changefreq>${entry.changefreq}</changefreq>`);
    lines.push(`    <priority>${entry.priority.toFixed(1)}</priority>`);
    return `  <url>\n${lines.join('\n')}\n  </url>`;
  });

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    (urls.length > 0 ? `${urls.join('\n')}\n` : '') +
    '</urlset>\n'
  );
}

/**
 * Fetches every page of a paginated list endpoint, accumulating `data` until
 * we've collected `total` items. `perPage` is `PER_PAGE` (the server cap), so
 * the catalog is paginated to completion. Guards against a malformed `total`
 * by also breaking on an empty page.
 */
async function paginate<T>(client: ServerApiClient, path: string): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  for (;;) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await client.request<PaginatedResponse<T>>(
      `${path}${sep}page=${page}&perPage=${PER_PAGE}`,
    );
    items.push(...res.data);
    if (res.data.length === 0 || items.length >= res.total) break;
    page += 1;
  }
  return items;
}

/**
 * Resolves the full set of sitemap entries: index pages, then every product,
 * vendor, integration, and taxonomy term. `baseUrl` is the absolute origin
 * (e.g. `https://aecintegrations.com`) the `<loc>` URLs are built against.
 */
export async function resolveSitemapEntries(
  client: ServerApiClient,
  baseUrl: string,
): Promise<SitemapEntry[]> {
  const base = baseUrl.replace(/\/+$/, '');

  const [products, vendors, integrations, taxonomy] = await Promise.all([
    paginate<ProductListItem>(client, '/api/products'),
    paginate<VendorListItem>(client, '/api/vendors'),
    paginate<IntegrationListItem>(client, '/api/integrations'),
    client.request<TaxonomyResponse>('/api/taxonomy'),
  ]);

  const entries: SitemapEntry[] = [
    // Index pages. AECI-165 removed the `/vendors` and `/integrations` index
    // pages (they now 301-redirect to `/products`), so they are no longer listed
    // here — only their `:slug` / `:id` DETAIL URLs (added below) remain. Three
    // taxonomy indexes (/categories, /audiences, /phases) exist since AECI-157;
    // /trades joined them in AECI-544.
    //
    // `/trades` is listed UNCONDITIONALLY, unlike the trade term pages below.
    // The publication floor gates individual terms, not the navigational index
    // that lists them — the index is the surface a crawler needs in order to
    // discover terms as they cross the floor, and it stays a real page (with the
    // facet's copy and its published grid) even while that grid is short.
    { loc: `${base}/products`, changefreq: 'daily', priority: 0.8 },
    { loc: `${base}/categories`, changefreq: 'weekly', priority: 0.6 },
    { loc: `${base}/audiences`, changefreq: 'weekly', priority: 0.6 },
    { loc: `${base}/phases`, changefreq: 'weekly', priority: 0.6 },
    { loc: `${base}/trades`, changefreq: 'weekly', priority: 0.6 },
    // Static legal pages (AECI-237). Indexable, rarely change — low priority,
    // yearly changefreq. Their canonicals are self-referential against the same
    // serving origin, so sitemap `<loc>` ⇄ page canonical stay consistent.
    { loc: `${base}/legal/terms`, changefreq: 'yearly', priority: 0.3 },
    { loc: `${base}/legal/privacy`, changefreq: 'yearly', priority: 0.3 },
    { loc: `${base}/legal/review-guidelines`, changefreq: 'yearly', priority: 0.3 },
    { loc: `${base}/legal/listing-accuracy`, changefreq: 'yearly', priority: 0.3 },
  ];

  for (const product of products) {
    entries.push({
      loc: `${base}/products/${product.slug}`,
      lastmod: product.updated_at,
      changefreq: 'weekly',
      priority: 0.7,
    });
  }

  for (const vendor of vendors) {
    entries.push({
      loc: `${base}/vendors/${vendor.slug}`,
      lastmod: vendor.updated_at,
      changefreq: 'weekly',
      priority: 0.7,
    });
  }

  // AECI-294 — integrations are consolidated onto the product-PAIR page, so the
  // sitemap emits ONE canonical URL per unordered product pair (context =
  // alphabetically-first slug via `defaultIntegrationContext`, matching the page
  // canonical + the `/integrations/:id` 301) rather than the retired
  // per-integration `/integrations/:id`. Two products connected by several
  // mechanisms collapse to a single entry; the most recent `updated_at` across
  // the pair's integrations wins as `lastmod`.
  const pairs = new Map<string, { context: string; other: string; lastmod: string }>();
  for (const integration of integrations) {
    const a = integration.source.slug;
    const b = integration.target.slug;
    const context = defaultIntegrationContext(a, b);
    const other = context === a ? b : a;
    const key = `${context}__${other}`;
    const existing = pairs.get(key);
    if (!existing || integration.updated_at > existing.lastmod) {
      pairs.set(key, { context, other, lastmod: integration.updated_at });
    }
  }
  for (const { context, other, lastmod } of pairs.values()) {
    entries.push({
      loc: `${base}/products/${context}/integrations/${other}`,
      lastmod,
      changefreq: 'weekly',
      priority: 0.6,
    });
  }

  // Taxonomy terms carry no <lastmod> — the API exposes no updated_at for them.
  for (const category of taxonomy.categories) {
    entries.push({
      loc: `${base}/categories/${category.slug}`,
      changefreq: 'weekly',
      priority: 0.5,
    });
  }
  for (const audience of taxonomy.audiences) {
    entries.push({
      loc: `${base}/audiences/${audience.slug}`,
      changefreq: 'weekly',
      priority: 0.5,
    });
  }
  for (const phase of taxonomy.phases) {
    entries.push({ loc: `${base}/phases/${phase.slug}`, changefreq: 'weekly', priority: 0.5 });
  }
  // Trades — the publication gate (AECI-546 / `TRADES_VOCABULARY.md` §6). A term
  // below `TRADE_PUBLISH_MIN_PRODUCTS` still resolves 200 at its permanent slug,
  // but renders `noindex` and is withheld here; it self-heals into the sitemap on
  // the next fetch once a promote pushes it over the floor, with no redirect and
  // no URL churn. The 34-term vocabulary is seeded closed and tagging is sparse by
  // design, so most terms start empty — without this gate the sitemap would
  // advertise a page of thin stubs.
  for (const trade of taxonomy.trades) {
    if (!isPublishedTrade(trade)) continue;
    entries.push({ loc: `${base}/trades/${trade.slug}`, changefreq: 'weekly', priority: 0.5 });
  }

  if (entries.length > SITEMAP_MAX_URLS) {
    console.warn(
      `[sitemap] ${entries.length} URLs exceeds the ${SITEMAP_MAX_URLS}-URL sitemap protocol ` +
        `limit; a <sitemapindex> split is required (deferred per AECI-63).`,
    );
  }

  return entries;
}
