/**
 * `GET /api/sitemap.xml` — the stored catalog fragment of `sitemap.xml` (AECI-1505,
 * `docs/API_CONTRACTS.md` §6.2b, `docs/CACHE_STRATEGY.md` §5).
 *
 * The SSR Worker's `/sitemap.xml` route is the only intended caller. It streams the
 * body between its own prolog, static and docs entries and `</urlset>`. The body is
 * `<url>` elements only, not a document. Like every Phase 2.8 read it is public and
 * unauthenticated through the SSR `/api/*` proxy: it holds exactly the URLs the
 * public sitemap lists.
 *
 * - **KV hit** (the steady state): the stored value is streamed straight out of
 *   `TAXONOMY_KV`, unparsed. The headers carry the metadata.
 * - **KV miss** (the first request after the first deploy per env, or no binding):
 *   build inline in one D1 batch, store it when the binding exists, return it. Two
 *   cold misses at once both build; that is harmless and happens once.
 * - **A failed build** propagates to `errorHandler()` as `500 INTERNAL_ERROR`. The
 *   SSR route answers `private, no-store`, so a failure is never edge-cached.
 *
 * `private, no-store`, like every API response. Only the SSR document is cached.
 */
import { SITEMAP_FRAGMENT_HEADERS } from '@aeci/shared';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import type { Env } from '../env';
import type { DbFactory } from '../lib/handler-utils';
import { buildCatalogSitemap } from '../lib/sitemap-build';
import { sitemapBase } from '../lib/sitemap-rebuild';
import { SITEMAP_XML_KEY, type SitemapXmlMetadata, storeSitemap } from '../lib/sitemap-store';

function fragmentResponse(body: BodyInit, meta: SitemapXmlMetadata): Response {
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'private, no-store',
      [SITEMAP_FRAGMENT_HEADERS.base]: meta.base,
      [SITEMAP_FRAGMENT_HEADERS.builtAt]: meta.builtAt,
      [SITEMAP_FRAGMENT_HEADERS.urlCount]: String(meta.urlCount),
    },
  });
}

export function createSitemapFragmentHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const kv = c.env.TAXONOMY_KV;
    if (kv) {
      const stored = await kv.getWithMetadata<SitemapXmlMetadata>(SITEMAP_XML_KEY, {
        type: 'stream',
      });
      if (stored.value && stored.metadata?.base) {
        return fragmentResponse(stored.value, stored.metadata);
      }
      // A value without metadata cannot say which origin it was built on. Drain it
      // and rebuild rather than guess.
      await stored.value?.cancel();
    }

    const builtAt = new Date().toISOString();
    const { db } = dbFor(c.env, { constraint: 'first-primary' });
    const built = await buildCatalogSitemap(db, sitemapBase(c.env));
    // The store rides `waitUntil`: the caller is already waiting on the build.
    if (kv) {
      c.executionCtx.waitUntil(
        storeSitemap(kv, built, builtAt).catch((err: unknown) => {
          console.warn('[sitemap] inline build could not be stored', err);
        }),
      );
    }
    return fragmentResponse(built.xml, { base: built.base, builtAt, urlCount: built.urlCount });
  };
}
