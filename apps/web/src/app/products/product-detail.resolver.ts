/**
 * Resolver for `/products/:slug`. Phase 2 Spec §3.1 / §7 / §9 / §10.
 *
 * The hydration / 404 / null-ctx SSR scaffold lives in `createDetailResolver`
 * (`../core/create-detail-resolver`). This file supplies only the product
 * specifics: the fetch fn, `applyMeta` (head tags + JSON-LD, runs on SSR and
 * on client navigations), and `pushEmbedded` (server-only Cache-Tag entities).
 *
 * The title carries a search-intent modifier (§9.1 / AECI-802) — see
 * `productMetaName`. The meta description runs a four-rung ladder whose first
 * rung is still the role-varied connector variant (§13.6) — see
 * `productMetaDescription`.
 *
 * On success → set page meta + JSON-LD; push embedded cache tags
 * (`vendor:{slug}` + `integration:{id}` + `product:{slug}` for each shown
 * integration's partner product, and for each connector a "Via {connector}"
 * heading names — §13.4(3)) onto `ctx.embedded` so `Cache-Tag` covers
 * data-derived dependencies.
 */
import type { ProductDetail, ProductIntegrationItem } from '@aeci/shared';

import { fetchProductBySlug } from '../core/api/products';
import { createDetailResolver } from '../core/create-detail-resolver';
import { metaTrustLine } from '../core/meta-copy';
import { composeEntityDescription, integrationPartnerNames } from '../core/meta.helpers';

import { routeIntegrationLane } from './connector-lane-grouping';
import { connectedProductCount } from './powered-hub-grouping';

/**
 * `<title>` name for a product page: `"{name} integrations"`, which
 * `MetaService` suffixes into `"{name} integrations · AEC Integrations"`
 * (Phase 2 Spec §9.1, AECI-802).
 *
 * The bare product name WAS the whole title until AECI-802. A title carrying
 * only the vendor's brand competes with the vendor's own domain for a pure brand
 * query, which a directory loses by definition, and it matches no long-tail
 * phrase at all. The modifier is the cheapest change that makes the title answer
 * a question someone actually types.
 *
 * Composed here rather than in `MetaService` because the service's only title
 * fork is `isBrowseKind`; adding a per-kind branch there would move the pair,
 * browse and index titles too. `products-pair.resolver.ts` already composes its
 * own name this way, so this is the established seam.
 */
function productMetaName(product: ProductDetail): string {
  const name = product.name;
  return $localize`:@@products.detail.meta.title:${name}:name: integrations`;
}

/**
 * `<meta name="description">` for a product page — the four-rung ladder of
 * Phase 2 Spec §9.1, as rewritten by AECI-802.
 *
 * 1. **Connector variant** (Stage 1.5 Addendum C §13.6 / AECI-707), unchanged.
 *    Gated on `product_role === 'connector'` AND a non-zero catalog reach, and
 *    it targets *"«connector» for construction"*-class queries. **Pair-shaped
 *    queries stay on pair pages** (Addendum A §11.2) so the two addenda never
 *    compete for one SERP with two different pages. `N` is
 *    `connectedProductCount`'s figure, the same number the hero line renders,
 *    so the snippet and the page agree.
 * 2. **Composed from our own integration data**, which is what AECI-802 added.
 *    Before it, every non-connector product shipped the vendor's own blurb —
 *    text the vendor already publishes on its own site and on every competing
 *    directory, which is precisely the aggregator signature the 2026 core
 *    updates demoted.
 * 3. The vendor's blurb, for a product with no integrations to describe. It is
 *    still unique text, and a composed sentence there would only advertise the
 *    absence.
 * 4. `MetaService`'s `@@meta.defaultDescription`, reached by returning `null`.
 *    Last resort, and now genuinely last: rung 3 catches everything with a
 *    description and rung 2 everything with an integration.
 *
 * The count is `integration_count`, the denormalized column, so the snippet
 * agrees with the product card, the hero `IntegrationStat`, the Algolia numeric
 * facet and both sort replicas. Deriving a separate figure here would add a
 * fifteenth site to the `STAGE_1_5_SPEC.md` §13.5 count lockstep for no reader
 * benefit.
 *
 * `SoftwareApplication.description` in the JSON-LD is deliberately NOT varied by
 * any of this (`buildProductJsonLd` reads `product.description` directly): the
 * structured data states a factual entity property, while this is a SERP
 * snippet. §13.6 is explicit on the point.
 */
function productMetaDescription(product: ProductDetail): string | null {
  if (product.product_role === 'connector') {
    const reach = connectedProductCount(product.integrations_as_connector, product.slug);
    if (reach > 0) {
      const name = product.name;
      return $localize`:@@products.detail.meta.connector:${name}:name: connects ${reach}:count: construction and AEC products. See the integrations it powers and reviews from the teams using them.`;
    }
  }

  const count = product.integration_count;
  if (count > 0) {
    const name = product.name;
    // `composeEntityDescription` returns null when there is no partner to name —
    // a stale `integration_count`, or a connector whose count comes entirely
    // from edges it powers. Falling through then is deliberate: a sentence
    // promising integrations it cannot name is worse than the vendor's blurb.
    const composed = composeEntityDescription({
      // Capped at the count so the sentence can never name more partners than
      // it claims integrations. Distinct partners are always <= edges, so this
      // is a no-op on coherent data and a guard against a drifted column.
      names: integrationPartnerNames(product).slice(0, count),
      trustLine: metaTrustLine(),
      render: (list) =>
        count === 1
          ? $localize`:@@products.detail.meta.description.one:${name}:name: has 1 integration in the AEC stack, with ${list}:list:.`
          : $localize`:@@products.detail.meta.description.other:${name}:name: has ${count}:count: integrations in the AEC stack, including ${list}:list:.`,
    });
    if (composed) return composed;
  }

  return product.description;
}

/**
 * Tag the connector a "Via {connector}" heading names (Stage 1.5 §13.4(3)).
 *
 * A linked group heading makes the connector a **rendered entity** on an
 * endpoint's page, so `CACHE_STRATEGY.md` §3's embedded-entity rule reaches it —
 * this is that existing rule applied, not a new one, and it is §12.4's first
 * bullet pointing the other way. Without it, editing a connector leaves every
 * endpoint page naming it stale until the TTL expires.
 *
 * `routeIntegrationLane` decides, rather than a local `via ?? powered_by` test:
 * a Convention-A self-reference carries a `powered_by` and renders NO heading
 * (§13.2(a) keeps it in the direct lane), so tagging on the raw FK would tag a
 * connector the page never names. One rule, one place.
 *
 * The reverse purge needs no change — `promote-cache-tags.ts` already emits
 * `product:{poweredBySlug}` (§13.4(4)).
 */
function pushConnector(
  embedded: Array<{ type: string; slug?: string; id?: string }>,
  integration: ProductIntegrationItem,
): void {
  const route = routeIntegrationLane(integration);
  if (route.lane === 'via' && route.connector) {
    embedded.push({ type: 'product', slug: route.connector.slug });
  }
}

export const productDetailResolver = createDetailResolver<ProductDetail>({
  statePrefix: 'aeci.product-detail:',
  paramName: 'slug',
  pathSegment: 'products',
  entityKind: 'product',
  fetch: fetchProductBySlug,
  applyMeta: (meta, product, canonical) => {
    meta.setEntityMeta({
      entity: 'product',
      name: productMetaName(product),
      description: productMetaDescription(product),
      canonical,
      ogImage: product.logo_url ?? undefined,
    });
    // `canonical` gives the node a stable `@id` (AECI-518) — the URI the pair
    // page's `about[]` entries reference so the two describe ONE product.
    meta.setProductJsonLd(product, canonical);
  },
  pushEmbedded: (ctx, product) => {
    // Embedded cache-tag entities — vendor, every integration shown, and
    // each partner product rendered in the integrations list. Per
    // CACHE_STRATEGY.md §3: "any entity rendered in the response — even
    // transitively — contributes a tag." Partner product names / slugs appear
    // as links in the integrations section, so their product:{slug} tags are
    // required for purge correctness when those products are updated.
    // `buildCacheTags` deduplicates; pushing the same slug twice is harmless.
    // `vendor` is nullable (AECI-115) — only tag it when the product has one.
    if (product.vendor) ctx.embedded.push({ type: 'vendor', slug: product.vendor.slug });
    for (const i of product.integrations_as_source) {
      ctx.embedded.push({ type: 'integration', id: i.id });
      ctx.embedded.push({ type: 'product', slug: i.target.slug });
      pushConnector(ctx.embedded, i);
    }
    for (const i of product.integrations_as_target) {
      ctx.embedded.push({ type: 'integration', id: i.id });
      ctx.embedded.push({ type: 'product', slug: i.source.slug });
      pushConnector(ctx.embedded, i);
    }
    // Powered edges (Stage 1.5 Addendum B): this product is the connector, so
    // BOTH endpoints are rendered — the hub heading links one and the chip links
    // the other — and each contributes a tag under the same §3 rule.
    for (const i of product.integrations_as_connector) {
      ctx.embedded.push({ type: 'integration', id: i.id });
      ctx.embedded.push({ type: 'product', slug: i.source.slug });
      ctx.embedded.push({ type: 'product', slug: i.target.slug });
    }
  },
});
