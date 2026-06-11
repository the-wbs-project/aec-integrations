/**
 * `GET /robots.txt` body generation for the SSR Worker (AECI-63 / Phase 2.17).
 *
 * When `allowIndexing` is true: allows the full public surface (`/products`,
 * `/categories`, `/audiences`, `/phases`, and every entity DETAIL page are all
 * covered by `Allow: /`) and disallows the non-cacheable / private routes
 * (mirrors the non-cacheable list in `server-runtime.ts` and
 * `docs/CACHE_STRATEGY.md` §4). Points crawlers at the sitemap. (AECI-165
 * removed the `/vendors` and `/integrations` index pages; `Allow: /` still lets
 * crawlers follow their 301 → `/products` redirect.)
 *
 * When `allowIndexing` is false (pre-launch / non-public envs): `Allow: /` with
 * no `Sitemap:` line. Crawling is intentionally still permitted so the
 * authoritative `X-Robots-Tag: noindex` header (see `./robots-policy.ts` and the
 * egress middleware in `server-runtime.ts`) is actually fetched and honored — a
 * `Disallow: /` would stop a compliant crawler from ever seeing the noindex,
 * leaving externally-linked URLs eligible to appear as URL-only results
 * (Google's documented behavior). robots.txt here simply declines to advertise
 * the sitemap; the header is what keeps pages out of the index.
 *
 * `origin` is the absolute request origin so the `Sitemap:` line is
 * self-referential per environment (e.g. staging points at the staging
 * sitemap).
 */
export function buildRobotsTxt(origin: string, allowIndexing = true): string {
  if (!allowIndexing) {
    // Crawling stays ALLOWED so the authoritative `X-Robots-Tag: noindex` header
    // (stamped on every response by the egress middleware) is actually fetched
    // and honored — a `Disallow: /` here would stop compliant crawlers from ever
    // seeing the noindex, letting externally-linked URLs still surface as
    // URL-only results (Google's documented behavior). We just decline to
    // advertise the sitemap. See `./robots-policy.ts`.
    return ['User-agent: *', 'Allow: /', ''].join('\n');
  }

  const base = origin.replace(/\/+$/, '');
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/',
    'Disallow: /auth/',
    'Disallow: /account',
    'Disallow: /search',
    'Disallow: /preview/',
    '',
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
}
