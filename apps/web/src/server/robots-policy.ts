/**
 * Crawler-indexing policy for the SSR Worker.
 *
 * AECi is launched. Exactly ONE env is indexed: `production`, which serves the
 * apex + `www.aecintegrations.com` and sets `ALLOW_INDEXING="true"` (the apex
 * cutover, AECI-247/277). `demo.aecintegrations.com` is public but stays
 * no-index by decision, and staging + PR previews sit behind Cloudflare Access.
 *
 * Indexing is FAIL-CLOSED: every environment blocks crawlers unless
 * `ALLOW_INDEXING` is explicitly the string `"true"`. It is keyed on that var
 * rather than on the `ENV` label because "is this the real build?" and "should
 * this be indexed?" are different questions — `demo` is the standing
 * counter-example.
 *
 * The gate is per-ENV, not per-host, and an env may serve several hostnames.
 * That is not a hole to plug here; it is a constraint on what you may route to
 * an indexed env. `prod.aecintegrations.com` rode `production`'s `"true"` for
 * the whole post-launch period and became an indexable, self-canonicalising
 * duplicate of `www.` before AECI-807 retired it.
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
