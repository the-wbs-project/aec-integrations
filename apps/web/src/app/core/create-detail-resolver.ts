/**
 * Shared SSR resolver factory for the entity detail routes — `/products/:slug`,
 * `/vendors/:slug`, `/integrations/:id`. Phase 2 Spec §3.1 / §7 / §9 / §10.
 *
 * The three detail resolvers are mechanically identical apart from the fetch
 * function, the per-entity meta/JSON-LD + embedded-tag logic, and a handful of
 * constants (state-key prefix, route param name, path segment, entity kind).
 * This factory holds the common scaffold so each resolver supplies only its
 * `fetch` and an `onResolved` callback — mirroring `createTaxonomyBrowseResolver`
 * in `taxonomy-browse.resolver.ts`.
 *
 * Server flow (RenderMode.Server, the only mode these routes use):
 *   1. Fetch the entity via the service binding (no public surface) using
 *      `AeciRequestContext.api`.
 *   2. On `NOT_FOUND` (fetch resolves `null`) → set `RESPONSE_INIT.status = 404`
 *      so the SSR runtime emits a real HTTP 404 + `NOT_FOUND_TTL`; set noindex
 *      meta; return `null` so the route component renders its NotFound state.
 *   3. On success → run the entity's `onResolved` (meta + JSON-LD + embedded
 *      cache tags), queue the fire-and-forget `POST /api/page-views` payload,
 *      and store the result in `TransferState` so client-hydration skips the
 *      fetch.
 *
 * Client flow (hydration): read the entity (or `null`) out of `TransferState`.
 * No fetch, no meta side-effects — the SSR-rendered HTML already carries them.
 */
import { isPlatformServer } from '@angular/common';
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
import { canonicalUrl } from './canonical';
import { MetaService, type EntityKind } from './meta.service';

export interface DetailResolverConfig<T extends { id: string }> {
  /** TransferState key prefix, e.g. `aeci.product-detail:`. The route param is
   *  appended so a future cross-route prefetch can't collide with the active
   *  page's data. */
  statePrefix: string;
  /** Route param this resolver reads, e.g. `slug` or `id`. */
  paramName: string;
  /** URL path segment for canonical + page-view route, e.g. `products`. */
  pathSegment: string;
  /** Entity kind for the meta title, NOT_FOUND meta, and page-view payload. */
  entityKind: EntityKind;
  /** Fetches the entity by its raw (un-encoded) param; resolves `null` on NOT_FOUND. */
  fetch: (api: ServerApiClient, param: string) => Promise<T | null>;
  /** Entity-specific success side-effects: meta/JSON-LD + `ctx.embedded` pushes. */
  onResolved: (ctx: AeciRequestContext, meta: MetaService, entity: T, canonical: string) => void;
}

/**
 * Builds a detail-route resolver from an entity config. The hydration / 404 /
 * null-ctx scaffold lives here; the config supplies the entity-specific bits.
 */
export function createDetailResolver<T extends { id: string }>(
  config: DetailResolverConfig<T>,
): ResolveFn<T | null> {
  return async (route) => {
    const param = route.paramMap.get(config.paramName) ?? '';
    const platformId = inject(PLATFORM_ID);
    const transferState = inject(TransferState);
    const stateKey = makeStateKey<T | null>(`${config.statePrefix}${param}`);

    // Client hydration path. SSR populated TransferState; just read it back.
    // Defensive `null` default: if a future navigation lands a param the SSR
    // didn't render (e.g. client-side routing to a new entity), we return null
    // and let the component render its NotFound state — preferable to a crash.
    if (!isPlatformServer(platformId)) {
      return transferState.get(stateKey, null);
    }

    // Server path.
    const meta = inject(MetaService);
    const ctx = inject(REQUEST_CONTEXT) as AeciRequestContext | null;
    const responseInit = inject(RESPONSE_INIT, { optional: true });
    const canonical = canonicalUrl(`/${config.pathSegment}/${param}`);

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

    config.onResolved(ctx, meta, entity, canonical);

    ctx.pageView = {
      route: `/${config.pathSegment}/:${config.paramName}`,
      entity_type: config.entityKind,
      entity_id: entity.id,
    };

    return entity;
  };
}
