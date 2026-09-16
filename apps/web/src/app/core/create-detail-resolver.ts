/**
 * Shared SSR resolver factory for the entity detail routes — `/products/:slug`
 * and `/vendors/:slug`. Phase 2 Spec §3.1 / §7 / §9 / §10. (AECI-294 retired the
 * standalone `/integrations/:id` detail route; the product-PAIR page has its own
 * resolver in `products-pair.resolver.ts`.)
 *
 * The three detail resolvers are mechanically identical apart from the fetch
 * function, the per-entity meta/JSON-LD logic, and the embedded cache tags. This
 * factory holds the common scaffold so each resolver supplies only its `fetch`,
 * an `applyMeta` callback (head tags + JSON-LD), and a `pushEmbedded` callback
 * (server-only Cache-Tag entities) — mirroring `createTaxonomyBrowseResolver` in
 * `taxonomy-browse.resolver.ts`.
 *
 * Server flow (RenderMode.Server):
 *   1. Fetch the entity via the service binding using `AeciRequestContext.api`.
 *   2. On `NOT_FOUND` (fetch resolves `null`) → set `RESPONSE_INIT.status = 404`
 *      so the SSR runtime emits a real HTTP 404 + `NOT_FOUND_TTL`; set noindex
 *      meta; return `null` so the route component renders its NotFound state.
 *   3. On success → run `applyMeta` (head tags + JSON-LD) and `pushEmbedded`
 *      (Cache-Tag entities), queue the fire-and-forget `POST /api/page-views`
 *      payload, and store the result in `TransferState` so hydration skips the
 *      fetch.
 *
 * Client flow (AECI-151):
 *   - Initial hydration (or a back-nav to the SSR-rendered page) → the SSR
 *     branch already stored the entity (or a real `null`) under this key; reuse
 *     it. The SSR HTML already carries the head tags, so re-running `applyMeta`
 *     is an idempotent upsert.
 *   - A genuine client navigation to a route SSR never rendered has no
 *     TransferState key → fetch the entity from the browser via the same-origin
 *     `/api/*` passthrough (`httpGetOrNull`; ADR 0001 — the sanctioned browser
 *     data path) and apply meta client-side. Without this the resolver returned
 *     `null` and every in-app link rendered the not-found shell.
 *
 * What stays server-only: `RESPONSE_INIT.status` (a SPA nav has no HTTP status),
 * `ctx.embedded` cache tags (edge concern), and the page-view payload (client
 * navigations are counted by `PageViewTracker`, not here).
 *
 * ── AECI-978: A MISS MAY BE A RETIRED SLUG ──────────────────────────────────
 * A route that opts in with `followSlugRedirect` asks `slug_redirects` before it
 * 404s, and 301s to the surviving slug on a hit (`STAGE_3_SPEC.md` §2.6 option B).
 * Three things about it are load-bearing:
 *
 *   1. **It runs AFTER the entity read, never before.** A live row must beat a
 *      mapping, which is what lets a redirect be deployed ahead of the data op that
 *      retires the row — the same "no window where the URL 404s" property the two
 *      hardcoded 301s it replaces had. It also means the map costs nothing on the
 *      hot path: the lookup fires only on a request already headed for a 404.
 *   2. **It is `RESPONSE_INIT`, not `RedirectCommand`** — the same reasoning
 *      AECI-953 wrote out in `products-pair.resolver.ts`: Angular's own redirect
 *      path sets `Vary: X-Forwarded-Prefix`, which `CLAUDE.md` forbids, and
 *      `applySeoHeaders` (the thing that strips it) does not run on a 3xx.
 *   3. **It is OPT-IN per route, not automatic.** `/products/:slug/review` reuses
 *      this scaffold with the same fetch and the same `entityKind`, and a redirect
 *      there would send a reader to `/products/{to}` — dropping the `/review`
 *      segment they asked for. Only a route that IS the entity's canonical page
 *      sets the flag.
 */
import { isPlatformServer } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
  PLATFORM_ID,
  REQUEST_CONTEXT,
  RESPONSE_INIT,
  TransferState,
  inject,
  makeStateKey,
} from '@angular/core';
import { ResolveFn, Router } from '@angular/router';

import type { ServerApiClient } from '../../server-api-client';
import type { AeciRequestContext } from '../../server/request-context';
import { httpGetOrNull } from './api/http-get-or-null';
import {
  fetchSlugRedirect,
  httpGetSlugRedirect,
  lookUpRedirect,
  type RedirectableEntity,
} from './api/slug-redirects';
import { canonicalUrl } from './canonical';
import { MetaService, type EntityKind } from './meta.service';

/**
 * `Cache-Control` for a retired-slug 301 (AECI-978).
 *
 * The same `public, max-age=3600, s-maxage=86400` every other permanent redirect in
 * the app carries — the SSR Worker's `/integrations/:id` and `/disciplines` routes,
 * and AECI-953's moved-pair 301. A redirect is a mapping, not content: it changes
 * only when an operator edits `slug_redirects`, and the `Cache-Tag` below is the
 * handle for that. No `stale-while-revalidate` — redirects deliberately omit it.
 *
 * Written as a literal because `buildCacheControl` lives in `server-runtime.ts`,
 * which app code cannot import (it pulls in the Worker `Bindings` types).
 */
const SLUG_REDIRECT_CACHE_CONTROL = 'public, max-age=3600, s-maxage=86400';

export interface DetailResolverConfig<T extends { id: string }> {
  /** TransferState key prefix, e.g. `aeci.product-detail:`. The route param is
   *  appended so a future cross-route prefetch can't collide with the active
   *  page's data. */
  statePrefix: string;
  /** Route param this resolver reads, e.g. `slug` or `id`. */
  paramName: string;
  /** URL/API path segment for canonical + the `/api/{segment}/:param` fetch +
   *  page-view route, e.g. `products`. */
  pathSegment: string;
  /** Entity kind for the meta title, NOT_FOUND meta, and page-view payload. */
  entityKind: EntityKind;
  /** Fetches the entity by its raw (un-encoded) param; resolves `null` on NOT_FOUND. */
  fetch: (api: ServerApiClient, param: string) => Promise<T | null>;
  /** Head metadata + JSON-LD for a resolved entity. Runs on BOTH platforms —
   *  SSR bakes it into the initial HTML; the client re-applies it on an in-app
   *  navigation (idempotent upserts). MUST NOT touch server-only context.
   *  Optional: omit on a route that owns its own `<head>` and is NOT the
   *  entity's canonical page (e.g. the review form, which sets its own title +
   *  `robots: noindex`) — it must not emit the entity's canonical / JSON-LD. */
  applyMeta?: (meta: MetaService, entity: T, canonical: string) => void;
  /** Server-only embedded `Cache-Tag` pushes onto `ctx.embedded`. Never runs on
   *  the client (a SPA navigation produces no HTTP response to tag). Optional:
   *  omit on a non-cacheable route, which has no `Cache-Tag` to contribute. */
  pushEmbedded?: (ctx: AeciRequestContext, entity: T) => void;
  /**
   * Opt in to the retired-slug 301 (AECI-978). The value is the `slug_redirects`
   * entity kind to look the param up under — `'product'` or `'vendor'` — which is
   * narrower than `entityKind` on purpose: only those two routes are wired to the
   * map, and naming the kind here rather than reusing `entityKind` keeps a route
   * that is NOT the entity's canonical page (the review form) from opting in by
   * accident. Omitted → the resolver 404s exactly as before.
   */
  followSlugRedirect?: RedirectableEntity;
  /** Whether a successful server-side resolve records a `POST /api/page-views`
   *  for this entity. Defaults to `true`. Set `false` on a route that reuses an
   *  entity fetch but is NOT that entity's canonical page (e.g. the review form
   *  under `/products/:slug/review`), so its landings don't inflate the
   *  entity's view count / trending signal (AECI-177/179). */
  trackPageView?: boolean;
}

/**
 * Builds a detail-route resolver from an entity config. The hydration / client-
 * fetch / 404 / null-ctx scaffold lives here; the config supplies the entity-
 * specific bits.
 */
export function createDetailResolver<T extends { id: string }>(
  config: DetailResolverConfig<T>,
): ResolveFn<T | null> {
  return async (route) => {
    const param = route.paramMap.get(config.paramName) ?? '';
    const platformId = inject(PLATFORM_ID);
    const transferState = inject(TransferState);
    const meta = inject(MetaService);
    const stateKey = makeStateKey<T | null>(`${config.statePrefix}${param}`);
    const canonical = canonicalUrl(`/${config.pathSegment}/${param}`);

    // ── Client path: in-app navigation or initial hydration. ────────────────
    if (!isPlatformServer(platformId)) {
      // Both injected HERE, before any await — `inject()` only works while the
      // injection context is live. `Router` is `optional` because the
      // component-spec harness runs these resolvers without one; the app always
      // has a router, and a null one simply skips the redirect and renders the
      // not-found shell (the pre-AECI-978 behaviour).
      const http = inject(HttpClient);
      const router = inject(Router, { optional: true });

      // Hydration / back-nav → reuse the SSR-stored value (entity or real null).
      // Genuine client nav (no key) → fetch from the browser via the same-origin
      // `/api/*` passthrough.
      const entity = transferState.hasKey(stateKey)
        ? transferState.get(stateKey, null)
        : await httpGetOrNull<T>(http, `/api/${config.pathSegment}/${encodeURIComponent(param)}`);

      // AECI-978 — the client half of the retired-slug redirect. A SPA navigation
      // has no HTTP status, so the equivalent of a 301 is a `replaceUrl`
      // navigation: the retired URL must not sit in the history stack, or Back
      // from the surviving page lands on the one that just redirected and bounces
      // forward again. Same shape as AECI-953's moved-pair redirect.
      if (!entity && config.followSlugRedirect && router) {
        const moved = await lookUpRedirect(() =>
          httpGetSlugRedirect(http, config.followSlugRedirect!, param),
        );
        if (moved) {
          void router.navigateByUrl(`/${config.pathSegment}/${moved.to_slug}`, {
            replaceUrl: true,
          });
          return null;
        }
      }

      // Re-apply head metadata client-side. Idempotent on hydration; on a client
      // navigation it is the ONLY thing that refreshes <title>/canonical/JSON-LD
      // (the server branch never ran). Page-views fire from `PageViewTracker`.
      // A resolver without `applyMeta` owns its own head (e.g. the review form).
      if (entity) config.applyMeta?.(meta, entity, canonical);
      else meta.setNotFoundMeta({ kind: config.entityKind, slug: param, canonical });
      return entity;
    }

    // ── Server path (RenderMode.Server). ────────────────────────────────────
    const ctx = inject(REQUEST_CONTEXT) as AeciRequestContext | null;
    const responseInit = inject(RESPONSE_INIT, { optional: true });

    // `REQUEST_CONTEXT` is only provided by `@angular/ssr` when the route uses
    // `RenderMode.Server`. The detail routes sit under the catch-all server
    // route in `app.routes.server.ts`, so this branch should never hit in
    // production — bail gracefully if it does (prerender / future render-mode
    // changes).
    if (!ctx) {
      transferState.set(stateKey, null);
      return null;
    }

    const entity = await config.fetch(ctx.api, param);
    transferState.set(stateKey, entity);

    if (!entity) {
      // AECI-978 — ask the retired-slug map before committing to the 404. This is
      // the ONLY place it is consulted, which is what makes §2.6's "never the hot
      // path" literally true: the read has already missed by the time we get here.
      const moved = config.followSlugRedirect
        ? await lookUpRedirect(() => fetchSlugRedirect(ctx.api, config.followSlugRedirect!, param))
        : null;
      if (moved && responseInit) {
        responseInit.status = 301;
        // `ResponseInit.headers` is typed `HeadersInit | undefined`, though
        // `@angular/ssr` always builds a real `Headers` and hands the SAME object
        // to both DI and the final `new Response(...)`. Normalising rather than
        // casting keeps that an assumption we can be wrong about without losing
        // the headers.
        const headers =
          responseInit.headers instanceof Headers ? responseInit.headers : new Headers();
        responseInit.headers = headers;
        // The origin comes off `canonical`, built ABOVE while the injection
        // context was still live. Calling `canonicalUrl` here would throw — it
        // injects `REQUEST`, and the awaits above have ended that context.
        //
        // The query string is deliberately DROPPED. WC-4 strips the query from the
        // shared edge cache key on a non-listing path like `/products/:slug`, so a
        // `Location` that varied by query would collapse onto whichever one warmed
        // the entry first — the trap the `/disciplines` redirect had to go
        // `private` to avoid. A detail URL carries no content-bearing params.
        headers.set(
          'Location',
          `${new URL(canonical).origin}/${config.pathSegment}/${moved.to_slug}`,
        );
        // Set HERE rather than left to the SSR Worker: `withCacheHeaders` hands a
        // 3xx to `ensureNoStore`, which only fills in a MISSING directive, so a
        // permanent mapping would otherwise be re-rendered on every crawler hit.
        headers.set('Cache-Control', SLUG_REDIRECT_CACHE_CONTROL);
        // BOTH slugs, per `CACHE_STRATEGY.md` §2. The map is mutable — unlike every
        // other redirect in the app, whose mapping is immutable — so it needs a
        // purge handle, and each slug answers a different way this 301 goes wrong:
        //
        //   - `{to_slug}` — the survivor is renamed or retired in turn, so the
        //     destination stops being right.
        //   - `{from_slug}` — the retired row COMES BACK. A re-promote of that slug
        //     purges `product:{from_slug}` and nothing else, so without this tag the
        //     edge keeps redirecting readers away from a page that is live again,
        //     for the full 24h `s-maxage`. AECI-953 tags the OLD pair for exactly
        //     this reason.
        headers.set(
          'Cache-Tag',
          `${config.followSlugRedirect}:${param},${config.followSlugRedirect}:${moved.to_slug}`,
        );
        return null;
      }
      if (responseInit) responseInit.status = 404;
      meta.setNotFoundMeta({ kind: config.entityKind, slug: param, canonical });
      return null;
    }

    config.applyMeta?.(meta, entity, canonical);
    config.pushEmbedded?.(ctx, entity);

    // Record the page-view UNLESS the route opts out. A route that reuses an
    // entity fetch but is not that entity's canonical page (e.g. the review
    // form) sets `trackPageView: false` so its landings aren't miscounted as
    // views of the entity.
    if (config.trackPageView !== false) {
      ctx.pageView = {
        route: `/${config.pathSegment}/:${config.paramName}`,
        entity_type: config.entityKind,
        entity_id: entity.id,
      };
    }

    return entity;
  };
}
