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
 *
 * ─── Blocked SEO-tool crawlers (AECI-747) ───────────────────────────────────
 *
 * {@link BLOCKED_SEO_CRAWLERS} get their own `Disallow: /` groups. In August 2026
 * SemrushBot alone made **4,698 requests across 1,644 distinct paths** — wider
 * coverage than Googlebot (983 / 177) and Bingbot (4,824 / 940) — including 1,265
 * integration-PAIR pages, which are the most expensive route we serve (each
 * hydrates every mechanism's claims and attestations). It sends no visitors, puts
 * us in no index, and feeds no AI answer surface. Same for Ahrefs and MJ12.
 *
 * A crawler obeys only the MOST SPECIFIC matching group, so a named group here
 * fully replaces the `User-agent: *` group for that bot — which is why these are
 * plain `Disallow: /` rather than a copy of the shared rules.
 *
 * This is voluntary compliance: all three publish that they honour robots.txt by
 * name, and all three are well-behaved enough that this works. It is NOT a
 * security control and must not be treated as one — a scraper that ignores
 * robots.txt needs the WAF (AECI-659), which is still unbuilt on production.
 *
 * Deliberately NOT blocked: `GPTBot` / `OAI-SearchBot` (AI answer surfaces are a
 * real distribution channel for a directory), `Applebot`, `DuckDuckBot`, and
 * every search engine. Do not add a crawler here because it is merely noisy —
 * the bar is "brings no traffic and appears in no index anyone uses".
 */
/**
 * SEO-tool crawlers that get a blanket `Disallow: /`.
 *
 * Exported so `robots.spec.ts` asserts the emitted groups against this list
 * rather than a second hand-written copy that can silently drift from it.
 */
export const BLOCKED_SEO_CRAWLERS: readonly string[] = ['SemrushBot', 'AhrefsBot', 'MJ12bot'];

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
    // One group per blocked crawler. A compliant bot reads only its own group,
    // so these need no copy of the shared `Disallow:` lines above.
    ...BLOCKED_SEO_CRAWLERS.flatMap((agent) => [`User-agent: ${agent}`, 'Disallow: /', '']),
    `Sitemap: ${base}/sitemap.xml`,
    '',
  ].join('\n');
}
