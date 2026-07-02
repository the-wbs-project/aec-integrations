/**
 * Derive the public URLs a promote should submit to IndexNow (AECI-236).
 *
 * `POST /api/promote` mutates public product / vendor / integration / taxonomy
 * pages; after the transaction commits, the handler submits the affected URLs to
 * IndexNow (Bing, Yandex, Seznam, Naver) so they re-crawl quickly — the same
 * write-event hook that fires the Cloudflare cache purge (§20.2 / §20.5). This
 * module is the URL counterpart to `cacheTagsForPromote` (`promote-cache-tags.ts`):
 * the purge speaks the edge's `Cache-Tag` vocabulary, IndexNow speaks absolute
 * URLs, but both model the same "what changed" set.
 *
 * URLs are built against `baseUrl` (the API Worker's `PUBLIC_SITE_URL`, e.g.
 * `https://aecintegrations.com`). The API Worker is private — its own request URL
 * is NOT the public origin — so the canonical host must be configured, not derived
 * from the request. At launch `PUBLIC_SITE_URL` is set to the same canonical host
 * the SSR Worker serves (canonicals are self-referential to the serving origin,
 * ADR 0011), so these URLs match the indexed `<link rel="canonical">` forms.
 *
 * Composition (mirrors `cacheTagsForPromote`, expressed as URLs):
 *   - product → `/products/{slug}` detail + `/products` index.
 *   - each vendor → `/vendors/{slug}` detail.
 *   - each integration with both endpoint slugs → the canonical pair page
 *     `/products/{context}/integrations/{other}` (Stage 1.5, §6.2 / §7.3; context =
 *     alphabetically-first slug; the other orientation canonicalises to it). This is
 *     the *only* URL an integration contributes — the retired `/integrations/{id}`
 *     detail route (Stage 1.5 / AECI-294) now 301-redirects to the pair page, and
 *     submitting a redirecting URL to indexing services is undesirable, so AECI-298
 *     dropped it. An integration missing either endpoint slug contributes nothing.
 *   - each touched taxonomy term (created *and* reused — the product's facet
 *     membership changed either way) → `/{categories|audiences|phases}/{slug}`
 *     browse page.
 *   - a *newly created* taxonomy term also changes the global taxonomy nav →
 *     home (`/`) + the three taxonomy index pages.
 *   - **No sitemap URL.** `sitemap.xml` is not an IndexNow target; engines
 *     re-fetch it on their own and `updated_at`/`<lastmod>` covers it (§20.5
 *     step 5).
 *
 * This now models the same "what changed" set as `cacheTagsForPromote` for
 * integrations — both point at the pair page, not the retired detail route
 * (AECI-298 resolved the earlier interim asymmetry).
 */

import type { PromoteResponse } from '@aeci/shared';

import { sortedPairSlugs } from './promote-pair';

/**
 * Returns the deduplicated set of absolute public URLs to submit to IndexNow for
 * a promote `response`, or an empty array when nothing public changed (e.g. an
 * all-skipped push). Pure — depends only on the response and the base URL.
 */
export function affectedUrlsForPromote(response: PromoteResponse, baseUrl: string): string[] {
  const base = baseUrl.replace(/\/+$/, '');
  const urls = new Set<string>();

  // Product detail + products index.
  if (response.product) {
    urls.add(`${base}/products/${response.product.slug}`);
    urls.add(`${base}/products`);
  }

  // Vendor detail pages. (No `/vendors` index — AECI-165 removed it; it
  // 301-redirects to `/products`.)
  for (const vendor of response.vendors) {
    urls.add(`${base}/vendors/${vendor.slug}`);
  }

  // Pair pages (Stage 1.5, §6.2 / §7.3): an integration contributes only the
  // consolidated product-pair page at the canonical default-context URL
  // `/products/{context}/integrations/{other}` (context = alphabetically-first
  // slug; the other orientation canonicalises to it). The legacy
  // `/integrations/{id}` route is a 301 redirect now, so it is not submitted
  // (AECI-298). Slugs come from the response integration results (populated by the
  // claims ingest, AECI-297); guard on both — an integration missing either slug
  // contributes no URL.
  for (const integration of response.integrations) {
    if (integration.sourceSlug && integration.targetSlug) {
      const [context, other] = sortedPairSlugs(integration.sourceSlug, integration.targetSlug);
      urls.add(`${base}/products/${context}/integrations/${other}`);
    }
  }

  // Taxonomy browse pages: one per touched term (created and reused). The URL
  // segment is the plural facet name, matching the Angular routes.
  const taxonomy: ReadonlyArray<
    ['categories' | 'audiences' | 'phases', typeof response.taxonomy.categories]
  > = [
    ['categories', response.taxonomy.categories],
    ['audiences', response.taxonomy.audiences],
    ['phases', response.taxonomy.phases],
  ];
  let taxonomyCreated = false;
  for (const [segment, results] of taxonomy) {
    for (const result of results) {
      urls.add(`${base}/${segment}/${result.slug}`);
      if (result.operation === 'created') taxonomyCreated = true;
    }
  }

  // Global taxonomy nav (home + the three taxonomy index pages) only changes when
  // a new term was minted — a reused term is already in the nav. Home is the
  // canonical `${origin}/` form (trailing slash; see `meta.helpers.ts`).
  if (taxonomyCreated) {
    urls.add(`${base}/`);
    urls.add(`${base}/categories`);
    urls.add(`${base}/audiences`);
    urls.add(`${base}/phases`);
  }

  return [...urls];
}
