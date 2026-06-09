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
 * `<lastmod>` is emitted for products / vendors / integrations from their
 * `updated_at`. Taxonomy terms (categories / audiences / phases) expose no
 * `updated_at` anywhere in the API, so those entries carry no `<lastmod>` —
 * the field is optional in the sitemap protocol (AECI-63 decision).
 */
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
    // here — only their `:slug` / `:id` DETAIL URLs (added below) remain. The
    // three taxonomy indexes (/categories, /audiences, /phases) all exist since
    // AECI-157.
    { loc: `${base}/products`, changefreq: 'daily', priority: 0.8 },
    { loc: `${base}/categories`, changefreq: 'weekly', priority: 0.6 },
    { loc: `${base}/audiences`, changefreq: 'weekly', priority: 0.6 },
    { loc: `${base}/phases`, changefreq: 'weekly', priority: 0.6 },
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

  for (const integration of integrations) {
    entries.push({
      loc: `${base}/integrations/${integration.id}`,
      lastmod: integration.updated_at,
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

  if (entries.length > SITEMAP_MAX_URLS) {
    console.warn(
      `[sitemap] ${entries.length} URLs exceeds the ${SITEMAP_MAX_URLS}-URL sitemap protocol ` +
        `limit; a <sitemapindex> split is required (deferred per AECI-63).`,
    );
  }

  return entries;
}
