/**
 * Crawler-indexing policy for the SSR Worker.
 *
 * AECi is pre-launch. The audience-facing web surfaces are the two real-build
 * tiers — `prod.aecintegrations.com` (the `production` Worker env, behind
 * Cloudflare Access until launch per ADR 0017) and `demo.aecintegrations.com`
 * (the `demo` env, the public showcase — NOT behind Access). The public demo
 * host is genuinely crawlable, so until we deliberately launch (the apex
 * cutover), NO environment should be indexed.
 *
 * Indexing is therefore FAIL-CLOSED: every environment blocks crawlers unless
 * `ALLOW_INDEXING` is explicitly the string `"true"`. Keying on the `ENV` label
 * would be wrong here — both public tiers are pre-launch no-index. When the
 * public site launches, set `ALLOW_INDEXING=true` on (only) the env that should
 * be indexed; both enforcement layers below then revert to the normal
 * allow-with-per-page-`<meta robots>` behavior.
 *
 * Two layers consume this, both gated on `indexingAllowed`:
 *   1. `X-Robots-Tag: noindex, nofollow` HTTP header on every non-`/api/*`
 *      response (the egress middleware in `server-runtime.ts`). This is the
 *      authoritative index block — it covers redirects / 404s / non-HTML and
 *      governs URLs reached via an external link too. For a compliant crawler to
 *      honor it, the page must be crawlable, which is exactly why layer 2 does
 *      NOT disallow crawling.
 *   2. `robots.txt` → `Allow: /` with no `Sitemap:` line (`./robots.ts`).
 *      Deliberately does not `Disallow: /`: blocking the crawl would stop the
 *      noindex header from ever being seen (Google's documented behavior),
 *      leaving externally-linked URLs eligible to appear as URL-only results.
 */

/** The `X-Robots-Tag` / `<meta robots>` directive used to block indexing. */
export const NOINDEX_DIRECTIVE = 'noindex, nofollow';

/**
 * Whether this environment may be crawled and indexed. Fail-closed: only the
 * explicit string `"true"` enables it. Absent / `"false"` / anything else →
 * blocked. Accepts the minimal shape so it's trivially testable.
 */
export function indexingAllowed(env: { ALLOW_INDEXING?: string }): boolean {
  return env.ALLOW_INDEXING === 'true';
}
