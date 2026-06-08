/**
 * Resolver for `/integrations/:id`. Phase 2 Spec §3.1 / §6.5 / §7 / §9 / §10.
 *
 * Integrations are keyed by record ID, not slug (Phase 2 Spec §6.5), so this
 * is the ID-based sibling of `productDetailResolver` / `vendorDetailResolver`.
 *
 * The hydration / 404 / null-ctx SSR scaffold lives in `createDetailResolver`
 * (`../core/create-detail-resolver`). This file supplies only the integration
 * specifics: the fetch fn, `applyMeta` (head tags; no JSON-LD, runs on SSR and
 * on client navigations), and `pushEmbedded` (server-only Cache-Tag entities).
 *
 * On success → set page meta (no JSON-LD — Phase 2 Spec §9.2 defers integration
 * structured data to Stage 2); push embedded cache tags (both products, the
 * built-by vendor, and the powered-by product when set) onto `ctx.embedded` so
 * `Cache-Tag` covers data-derived dependencies.
 */
import type { IntegrationDetail } from '@aeci/shared';

import { fetchIntegrationById } from '../core/api/integrations';
import { createDetailResolver } from '../core/create-detail-resolver';

/**
 * Detail headline per Phase 2 Spec §6.5 — `"{source} → {target}"`. Built from
 * the hydrated source/target product names rather than the integration's own
 * `name` column (which is nullable at the DB level).
 */
function integrationHeadline(integration: IntegrationDetail): string {
  return `${integration.source.name} → ${integration.target.name}`;
}

export const integrationDetailResolver = createDetailResolver<IntegrationDetail>({
  statePrefix: 'aeci.integration-detail:',
  paramName: 'id',
  pathSegment: 'integrations',
  entityKind: 'integration',
  fetch: fetchIntegrationById,
  applyMeta: (meta, integration, canonical) => {
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
  },
  pushEmbedded: (ctx, integration) => {
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
  },
});
