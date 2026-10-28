/**
 * The pure `sitemap.xml` renderer, shared by both Workers (AECI-1505).
 *
 * The document is assembled from two halves that are built in different places:
 *
 *   - The **catalog** `<url>` elements (products, vendors, pairs, taxonomy terms)
 *     are rendered by the API Worker's rebuild job and stored in `TAXONOMY_KV`
 *     (`apps/api/src/lib/sitemap-build.ts`).
 *   - The **static** and **docs** elements are rendered by the SSR Worker, because
 *     the docs manifest is an Angular-only `.md` import
 *     (`apps/web/src/server/sitemap.ts`).
 *
 * The SSR route streams `SITEMAP_XML_HEAD`, its own elements, the stored fragment
 * and `SITEMAP_XML_TAIL`. That join is only correct because `buildSitemapXml` is
 * exactly `HEAD + renderSitemapUrls(entries) + TAIL`, and `renderSitemapUrls` of a
 * concatenation is the concatenation of the renders. `sitemap.spec.ts` pins both.
 */

/** A single `<url>` entry in the sitemap. `lastmod` is optional per protocol. */
export interface SitemapEntry {
  loc: string;
  lastmod?: string;
  changefreq: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never';
  priority: number;
}

/**
 * Sitemap protocol caps a single sitemap document at 50,000 URLs. At Stage 1
 * catalog size we are far below this; splitting into a `<sitemapindex>` of
 * sub-sitemaps is deliberately deferred (AECI-63 "out of scope") until the
 * catalog grows past the limit.
 */
export const SITEMAP_MAX_URLS = 50_000;

/** Everything before the first `<url>`. */
export const SITEMAP_XML_HEAD =
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';

/** Everything after the last `<url>`. */
export const SITEMAP_XML_TAIL = '</urlset>\n';

/** XML-escapes the five predefined entities so `<loc>` is always well-formed. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Renders entries into `<url>` elements, each followed by a newline, so two
 * fragments concatenate into the same text one render of both would produce.
 * Pure — no I/O. An empty list renders as the empty string.
 */
export function renderSitemapUrls(entries: readonly SitemapEntry[]): string {
  let out = '';
  for (const entry of entries) {
    const lines = [`    <loc>${escapeXml(entry.loc)}</loc>`];
    if (entry.lastmod) lines.push(`    <lastmod>${escapeXml(entry.lastmod)}</lastmod>`);
    lines.push(`    <changefreq>${entry.changefreq}</changefreq>`);
    lines.push(`    <priority>${entry.priority.toFixed(1)}</priority>`);
    out += `  <url>\n${lines.join('\n')}\n  </url>\n`;
  }
  return out;
}

/**
 * Renders entries into a protocol-valid `<urlset>` document. Pure — no I/O.
 */
export function buildSitemapXml(entries: readonly SitemapEntry[]): string {
  return SITEMAP_XML_HEAD + renderSitemapUrls(entries) + SITEMAP_XML_TAIL;
}

/**
 * Headers `GET /api/sitemap.xml` sets beside the stored fragment. The SSR
 * Worker reads `base` to build its own static and docs `<loc>`s against the
 * same origin as the catalog ones, so one document never mixes two hosts.
 */
export const SITEMAP_FRAGMENT_HEADERS = {
  base: 'X-Sitemap-Base',
  builtAt: 'X-Sitemap-Built-At',
  urlCount: 'X-Sitemap-Url-Count',
} as const;
