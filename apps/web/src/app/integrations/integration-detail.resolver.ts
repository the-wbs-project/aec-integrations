/**
 * Resolver for `/integrations/:id`. Phase 2 Spec §3.1 / §6.5 / §7 / §9 / §10.
 *
 * Integrations are keyed by record ID, not slug (Phase 2 Spec §6.5), so this
 * is the ID-based parallel to `productDetailResolver` / `vendorDetailResolver`.
 *
 * Server flow (RenderMode.Server, the only mode this route uses):
 *   1. Fetch `GET /api/integrations/:id` via the service binding (no public
 *      surface) using the `AeciRequestContext.api` client.
 *   2. On `NOT_FOUND` envelope → set `RESPONSE_INIT.status = 404` so the SSR
 *      runtime emits a real HTTP 404 + `NOT_FOUND_TTL`; set noindex meta;
 *      return `null` so the route component renders the global 404 shell.
 *   3. On success → set page meta (no JSON-LD — Phase 2 Spec §9.2 defers
 *      integration structured data to Stage 2); push embedded cache tags
 *      (both products, the built-by vendor, and the powered-by product when
 *      set) onto `ctx.embedded` so `Cache-Tag` covers data-derived
 *      dependencies; queue the fire-and-forget `POST /api/page-views`
 *      payload. Store the result in `TransferState` so client-hydration
 *      skips the fetch.
 *
 * Client flow (hydration): read the `IntegrationDetail` (or `null`) out of
 * `TransferState`. No fetch, no meta side-effects — the SSR-rendered HTML
 * already carries them.
 */
import { isPlatformServer } from '@angular/common';
import {
  PLATFORM_ID,
  REQUEST,
  REQUEST_CONTEXT,
  RESPONSE_INIT,
  TransferState,
  inject,
  makeStateKey,
} from '@angular/core';
import { ResolveFn } from '@angular/router';

import type { IntegrationDetail } from '@aeci/shared';

import type { AeciRequestContext } from '../../server/request-context';
import { fetchIntegrationById } from '../core/api/integrations';
import { MetaService } from '../core/meta.service';

const INTEGRATION_DETAIL_STATE_PREFIX = 'aeci.integration-detail:';

/**
 * Per-ID TransferState key. The ID is included so a future cross-route
 * prefetch (e.g. hover-prefetch on an integration card) can't collide with
 * the active page's data.
 */
function integrationStateKey(id: string) {
  return makeStateKey<IntegrationDetail | null>(`${INTEGRATION_DETAIL_STATE_PREFIX}${id}`);
}

/**
 * Detail headline per Phase 2 Spec §6.5 — `"{source} → {target}"`. Built from
 * the hydrated source/target product names rather than the integration's own
 * `name` column (which is nullable at the DB level).
 */
function integrationHeadline(integration: IntegrationDetail): string {
  return `${integration.source.name} → ${integration.target.name}`;
}

export const integrationDetailResolver: ResolveFn<IntegrationDetail | null> = async (route) => {
  const id = route.paramMap.get('id') ?? '';
  const platformId = inject(PLATFORM_ID);
  const transferState = inject(TransferState);
  const stateKey = integrationStateKey(id);

  // Client hydration path. SSR populated TransferState; just read it back.
  // Defensive `null` default: if a future navigation lands an ID the SSR
  // didn't render (e.g. client-side routing to a new integration), we return
  // null and let the component render the 404 shell — preferable to a crash.
  if (!isPlatformServer(platformId)) {
    return transferState.get(stateKey, null);
  }

  // Server path.
  const meta = inject(MetaService);
  const request = inject(REQUEST, { optional: true });
  const ctx = inject(REQUEST_CONTEXT) as AeciRequestContext | null;
  const responseInit = inject(RESPONSE_INIT, { optional: true });
  const origin = request ? new URL(request.url).origin : 'https://aecintegrations.com';
  const canonical = `${origin}/integrations/${id}`;

  // `REQUEST_CONTEXT` is only provided by `@angular/ssr` when the route uses
  // `RenderMode.Server`. The integrations route is registered under the
  // catch-all server route in `app.routes.server.ts`, so this branch should
  // never hit in production — bail gracefully if it does.
  if (!ctx) {
    transferState.set(stateKey, null);
    return null;
  }

  const integration = await fetchIntegrationById(ctx.api, id);
  transferState.set(stateKey, integration);

  if (!integration) {
    if (responseInit) responseInit.status = 404;
    meta.setNotFoundMeta({ kind: 'integration', slug: id, canonical });
    return null;
  }

  meta.setEntityMeta({
    entity: 'integration',
    name: integrationHeadline(integration),
    description: integration.description,
    canonical,
    // Integrations have no own logo; OG falls back to the site default.
    ogImage: undefined,
  });
  // No JSON-LD: Phase 2 Spec §9.2 defers integration structured data to Stage 2
  // ("no clean schema.org type exists").

  // Embedded cache-tag entities — every entity rendered (even transitively) on
  // the page contributes a tag (CACHE_STRATEGY.md §3). The path matcher already
  // emits `integration:{id}` and `route:detail`; the resolver pushes the linked
  // products + vendor so purges on those cascade here. `buildCacheTags`
  // deduplicates, so a source/target that share a slug is harmless.
  ctx.embedded.push({ type: 'product', slug: integration.source.slug });
  ctx.embedded.push({ type: 'product', slug: integration.target.slug });
  if (integration.built_by_vendor) {
    ctx.embedded.push({ type: 'vendor', slug: integration.built_by_vendor.slug });
  }
  // The "Powered by" connector product renders as a link, so it gets a tag too.
  // (The AECI-60 AC enumerates only source/target/built-by, but CACHE_STRATEGY.md
  // §3 requires a tag for every rendered entity — flagged in the PR.)
  if (integration.powered_by_product) {
    ctx.embedded.push({ type: 'product', slug: integration.powered_by_product.slug });
  }

  ctx.pageView = {
    route: '/integrations/:id',
    entity_type: 'integration',
    entity_id: integration.id,
  };

  return integration;
};
