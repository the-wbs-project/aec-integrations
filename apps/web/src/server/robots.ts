/**
 * `GET /robots.txt` body generation for the SSR Worker (AECI-63 / Phase 2.17).
 *
 * Allows the full public surface (`/products`, `/vendors`, `/integrations`,
 * `/categories`, `/audiences`, `/phases` are all covered by `Allow: /`) and
 * disallows the non-cacheable / private routes (mirrors the non-cacheable list
 * in `server-runtime.ts` and `docs/CACHE_STRATEGY.md` §4). Points crawlers at
 * the sitemap.
 *
 * `origin` is the absolute request origin so the `Sitemap:` line is
 * self-referential per environment (e.g. staging points at the staging
 * sitemap).
 */
export function buildRobotsTxt(origin: string): string {
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
