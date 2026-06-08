/**
 * Shared SSR resolver factory for the entity detail routes — `/products/:slug`,
 * `/vendors/:slug`, `/integrations/:id`. Phase 2 Spec §3.1 / §7 / §9 / §10.
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
import { ResolveFn } from '@angular/router';

import type { ServerApiClient } from '../../server-api-client';
import type { AeciRequestContext } from '../../server/request-context';
import { httpGetOrNull } from './api/http-get-or-null';
import { canonicalUrl } from './canonical';
import { MetaService, type EntityKind } from './meta.service';

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
   *  navigation (idempotent upserts). MUST NOT touch server-only context. */
  applyMeta: (meta: MetaService, entity: T, canonical: string) => void;
  /** Server-only embedded `Cache-Tag` pushes onto `ctx.embedded`. Never runs on
   *  the client (a SPA navigation produces no HTTP response to tag). */
  pushEmbedded: (ctx: AeciRequestContext, entity: T) => void;
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
      // Hydration / back-nav → reuse the SSR-stored value (entity or real null).
      // Genuine client nav (no key) → fetch from the browser via the same-origin
      // `/api/*` passthrough. `inject()` runs before the await, in context.
      const entity = transferState.hasKey(stateKey)
        ? transferState.get(stateKey, null)
        : await httpGetOrNull<T>(
            inject(HttpClient),
            `/api/${config.pathSegment}/${encodeURIComponent(param)}`,
          );

      // Re-apply head metadata client-side. Idempotent on hydration; on a client
      // navigation it is the ONLY thing that refreshes <title>/canonical/JSON-LD
      // (the server branch never ran). Page-views fire from `PageViewTracker`.
      if (entity) config.applyMeta(meta, entity, canonical);
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
      if (responseInit) responseInit.status = 404;
      meta.setNotFoundMeta({ kind: config.entityKind, slug: param, canonical });
      return null;
    }

    config.applyMeta(meta, entity, canonical);
    config.pushEmbedded(ctx, entity);

    ctx.pageView = {
      route: `/${config.pathSegment}/:${config.paramName}`,
      entity_type: config.entityKind,
      entity_id: entity.id,
    };

    return entity;
  };
}
