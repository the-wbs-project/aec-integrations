/**
 * `GET /sitemap.xml` for the SSR Worker (AECI-63 / Phase 2.17; AECI-1505).
 *
 * Since AECI-1505 the document is assembled from two halves:
 *
 *   1. **The catalog** (products, vendors, integration pairs, taxonomy terms) is
 *      built by the API Worker's `sitemap-rebuild` cron and stored in
 *      `TAXONOMY_KV`. `GET /api/sitemap.xml` streams it back as `<url>` elements
 *      with the origin they were built on in `X-Sitemap-Base`. The catalog rules
 *      (the pair dedupe, the AECI-978 retired-slug filter, the AECI-546 trade
 *      floor) live in `apps/api/src/lib/sitemap-build.ts` now.
 *   2. **The static and docs entries** stay here, in `staticSitemapEntries`. The
 *      docs manifest imports `.md` files only the Angular build can load, so the
 *      API cannot see it.
 *
 * `streamSitemapXml` joins them without buffering the catalog: the prolog, this
 * Worker's elements, the piped KV body, then `</urlset>`. The pure renderer is
 * `@aeci/shared`'s `buildSitemapXml`, re-exported below. The route wiring
 * (headers, cache control) lives in `server-runtime.ts`.
 *
 * Every `<loc>` in one document shares the origin in `X-Sitemap-Base`, the API's
 * `PUBLIC_SITE_URL`. It used to be the request origin. The native cache key
 * carries no host (AECI-1441), so one host's copy was already served to all.
 */
import {
  SITEMAP_XML_HEAD,
  SITEMAP_XML_TAIL,
  type SitemapEntry,
  renderSitemapUrls,
} from '@aeci/shared';

export {
  SITEMAP_MAX_URLS,
  buildSitemapXml,
  renderSitemapUrls,
  type SitemapEntry,
} from '@aeci/shared';

/**
 * The indexable product-docs paths (AECI-1248): `/docs`, each non-empty section
 * index and each page, minus anything `pathForcesNoindex` covers. Derived from
 * the docs manifest (`src/app/docs/docs-content.ts`) by `indexableDocsPaths`.
 *
 * A dynamic `import()`, so the manifest, its inlined Markdown and `marked` sit
 * in a lazy chunk that loads on the first `/sitemap.xml` request rather than at
 * Worker startup. The manifest imports `.md` files, which only the Angular build
 * can load, so plain-Vitest specs pass their own loader instead.
 */
export type DocsPathsLoader = () => Promise<readonly string[]>;

const loadIndexableDocsPaths: DocsPathsLoader = async () =>
  (await import('../app/docs/docs-content')).indexableDocsPaths();

/**
 * The entries this Worker owns: the index pages, the static pages and the
 * indexable docs. `base` is the absolute origin (no trailing slash needed) the
 * `<loc>` URLs are built against. The catalog entries come from the API
 * (`GET /api/sitemap.xml`) and follow these in the document.
 */
export async function staticSitemapEntries(
  baseUrl: string,
  loadDocsPaths: DocsPathsLoader = loadIndexableDocsPaths,
): Promise<SitemapEntry[]> {
  const base = baseUrl.replace(/\/+$/, '');
  const docsPaths = await loadDocsPaths();

  const entries: SitemapEntry[] = [
    // Index pages. AECI-165 removed the `/vendors` and `/integrations` index
    // pages (they now 301-redirect to `/products`), so they are no longer listed
    // here — only their `:slug` DETAIL URLs (in the API fragment) remain. Three
    // taxonomy indexes (/categories, /audiences, /phases) exist since AECI-157;
    // /trades joined them in AECI-544.
    //
    // `/trades` is listed UNCONDITIONALLY, unlike the trade term pages the API
    // fragment carries.
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
    // Current versions only: an archived `/legal/<slug>/v<version>` is noindex
    // and canonicalises here, so it is never listed (AECI-1361).
    { loc: `${base}/legal/terms`, changefreq: 'yearly', priority: 0.3 },
    { loc: `${base}/legal/privacy`, changefreq: 'yearly', priority: 0.3 },
    { loc: `${base}/legal/review-guidelines`, changefreq: 'yearly', priority: 0.3 },
    { loc: `${base}/legal/listing-accuracy`, changefreq: 'yearly', priority: 0.3 },
    // AECI-1359 / AECI-1360: the vendor terms and the Managed plan agreement.
    { loc: `${base}/legal/vendor-terms`, changefreq: 'yearly', priority: 0.3 },
    { loc: `${base}/legal/managed-plan-agreement`, changefreq: 'yearly', priority: 0.3 },
    // AECI-804 — the editorial methodology page. The FIRST non-legal static page
    // in the sitemap: `/`, `/about`, `/updates` and `/roadmap` are all absent
    // (the first three by omission, `/roadmap` deliberately, being noindex).
    // This one is listed on purpose — it is the page an answer engine or a
    // quality rater is meant to find and cite, so discovery is the whole point.
    // Higher priority than the legal set and a shorter changefreq, because it is
    // revised whenever the product's verification posture moves.
    { loc: `${base}/methodology`, changefreq: 'monthly', priority: 0.5 },
    // AECI-1283 — the public vendor landing page (`VENDOR_PROGRAM_PAGE_SPEC.md`
    // §2.3). Listed on purpose: vendors searching "list my software" are meant
    // to find it. Same weight as /methodology, the other static page listed.
    { loc: `${base}/vendor-program`, changefreq: 'monthly', priority: 0.5 },
    // AECI-1474 — the listing request page (§2.5). Listed for the same reason:
    // "list my software" and "AEC software directory listing" searches.
    { loc: `${base}/vendor-program/list-your-product`, changefreq: 'monthly', priority: 0.5 },
    // AECI-1248 — the product docs, from the manifest: `/docs`, each indexable
    // section index and page. No `<lastmod>`, the `/legal/*` rule: the page's
    // `last_updated` is a display string, not a date. The vendor guide
    // (`/docs/vendors` and below) is listed since AECI-1253 emptied the
    // `pathForcesNoindex` list. A path that list covers is left out.
    ...docsPaths.map(
      (path): SitemapEntry => ({ loc: `${base}${path}`, changefreq: 'monthly', priority: 0.4 }),
    ),
  ];

  return entries;
}

/**
 * Joins this Worker's entries and the API's stored catalog fragment into one
 * `sitemap.xml` body, without buffering the fragment. The body is
 * `HEAD + own elements + fragment + TAIL`; `@aeci/shared`'s sitemap spec pins that
 * this equals one `buildSitemapXml` over both lists.
 *
 * If the fragment stream errors part-way, the returned body errors too, rather
 * than ending cleanly on a truncated document. An errored body is not stored by
 * the Workers Cache, so a broken sitemap is never pinned at the edge for its hour.
 * `waitUntil` keeps the pipe alive after the handler has returned the response.
 */
export function streamSitemapXml(
  ownEntries: readonly SitemapEntry[],
  fragment: ReadableStream<Uint8Array>,
  waitUntil: (promise: Promise<unknown>) => void,
): ReadableStream<Uint8Array> {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const encoder = new TextEncoder();

  // `pipeTo` aborts `writable` itself when the fragment errors (its default), so
  // the catch only has to abort when one of the two literal writes failed.
  let writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  const pump = async () => {
    try {
      writer = writable.getWriter();
      await writer.write(encoder.encode(SITEMAP_XML_HEAD + renderSitemapUrls(ownEntries)));
      writer.releaseLock();
      writer = null;
      await fragment.pipeTo(writable, { preventClose: true });
      writer = writable.getWriter();
      await writer.write(encoder.encode(SITEMAP_XML_TAIL));
      await writer.close();
    } catch (error) {
      console.warn('[sitemap] the catalog fragment stream failed', error);
      await (writer ?? writable).abort(error).catch(() => undefined);
    }
  };
  waitUntil(pump());
  return readable;
}
