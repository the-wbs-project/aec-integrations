import { z } from 'zod';

import {
  paginatedResponseSchema,
  PageQuerySchema,
  ProductLinkSchema,
  VendorLinkSchema,
} from './common';

/**
 * Integration mechanism enum. Mirrors the `mechanism_kind` column on the
 * `integrations` table (docs/DATABASE_SCHEMA.md §3) and stays in lockstep with
 * the directory editorial taxonomy in PRODUCT.md.
 *
 * `integrator` replaces `partner` (AECI-698); both are listed while the review app
 * re-keys. A **connector-evidenced pair** carries no kind at all and serialises
 * `mechanism_kind: null` — see `via` on `IntegrationListItemSchema`.
 */
export const IntegrationMechanismKindSchema = z.enum([
  'native',
  'iPaaS',
  'marketplace-app',
  'api',
  'webhook',
  'partner',
  'integrator',
]);

export type IntegrationMechanismKind = z.infer<typeof IntegrationMechanismKindSchema>;

/**
 * The stored direction vocabulary, shared by every table that records which way
 * data moves: `integrations.direction` (since AECI-921), `claims.direction`, and
 * `connector_evidenced_pairs.direction`. Anchored to the row's own two endpoints
 * — **A = `source_product_id`, B = `target_product_id`** (`STAGE_1_5_SPEC.md`
 * §3.2).
 *
 * **Declared here rather than in `promote.ts`, deliberately.** `promote.ts` is a
 * large Zod module the browser never needs, and it is reached only through
 * `import type` from the client graph. Importing a *value* out of it — which an
 * enum is — drags the whole module into the eager web bundle, which put it 3.41 kB
 * over its budget the first time AECI-921 tried it. `promote.ts` re-exports these
 * two names so its own consumers are unaffected.
 */
export const CLAIM_DIRECTIONS = ['a_to_b', 'b_to_a', 'both'] as const;

/** A stored direction, relative to the row's own endpoints (§3.2). */
export type ClaimDirection = (typeof CLAIM_DIRECTIONS)[number];

/**
 * The **context-free** presentation vocabulary for an integration's direction:
 * "how many ways?", not "which way?".
 *
 * **This is no longer what the column stores.** AECI-921 moved
 * `integrations.direction` onto `CLAIM_DIRECTIONS` (`a_to_b | b_to_a | both`,
 * anchored to the row's own source/target) because the two-value form could not
 * express a reverse flow, and a whole class of edge needs to — see AECI-920 and
 * `STAGE_1_5_SPEC.md` §3.2. `presentedDirection()` in `integration-context.ts`
 * is the only bridge, and it is deliberately lossy.
 *
 * This spelling survives because three surfaces list integrations with **no
 * context product to frame an arrow against**: the home page's recent-integrations
 * tile, the Algolia integration record, and the `?direction=` filter below. On
 * those, `a_to_b` names nothing a reader can act on, and splitting "one-way" into
 * two values that differ only by an invisible endpoint ordering would be worse
 * than the collapse. Anything that DOES have a context product uses
 * `ContextDirectionSchema` instead.
 */
export const IntegrationDirectionSchema = z.enum(['one-way', 'bidirectional']);

export type IntegrationDirection = z.infer<typeof IntegrationDirectionSchema>;

/**
 * Direction of a mechanism (or, in Layer B, a claim) **relative to the page's
 * context product** (Stage 1.5 §3.2). The stored integration/claim direction is
 * canonical to the row's own endpoints; the API translates it into the visitor's
 * frame before it leaves the Worker (the browser never re-derives it). `outbound`
 * = flows from the context product to the other; `inbound` = the reverse; `both`
 * = bidirectional. Lives here (not in `product-pairs`) so both the pair page and
 * the product-detail integrations table can reference it without an import cycle.
 */
export const ContextDirectionSchema = z.enum(['outbound', 'inbound', 'both']);

export type ContextDirection = z.infer<typeof ContextDirectionSchema>;

/**
 * Public sort key for `GET /api/integrations`. Phase 2 Spec §7.4: default
 * `name ASC`. Server-side maps `name → ASC`, `created → DESC` per §7.4.
 */
export const IntegrationSortSchema = z.enum(['name', 'created']).default('name');

export type IntegrationSort = z.infer<typeof IntegrationSortSchema>;

/**
 * Lean shape returned by `GET /api/integrations` list rows and embedded in
 * `ProductDetail.integrations_as_source` / `integrations_as_target`. Source
 * and target products are hydrated as `ProductLink` (id + name + slug + logo)
 * per Phase 2 Spec §7.2.
 *
 * **Two storage tables, one shape (AECI-721).** A list item is either a row of
 * `integrations` — an accountable-party edge — or a row of
 * `connector_evidenced_pairs`, a delivered edge an iPaaS ships a listing for
 * (`STAGE_1_5_SPEC.md` §13.1). `via` is what tells them apart, and the shape is
 * deliberately common so the split is a sourcing question, not a rendering one
 * (§13.3 is written source-agnostically for exactly this reason).
 */
export const IntegrationListItemSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  // Nullable: the `mechanism_kind` column is nullable (AECI-115), mirroring
  // sibling `direction`. An absent value surfaces as `null` and the UI renders
  // an empty state, rather than silently coercing to `'native'`. An out-of-enum
  // *non-null* value is a data-integrity violation the mapper throws on.
  //
  // ALWAYS `null` when `via` is set: `connector_evidenced_pairs` has no
  // `mechanism_kind` column, because the lane answers "which mechanism". Read
  // `via` for that, never a synthesised kind.
  mechanism_kind: IntegrationMechanismKindSchema.nullable(),
  mechanism_name: z.string().nullable(),
  // The STORED direction, anchored to this item's own `source` / `target`
  // (AECI-921 — the same vocabulary as `claims.direction`). NOT the presentation
  // collapse: a consumer that HAS a context product frames it itself, and the
  // powered hub does exactly that (`powered-hub-grouping.ts`), so collapsing
  // here would throw away the one fact it needs. Consumers with no context —
  // the home page's recent-integrations tile — run it through
  // `directionLabel()`, which accepts both vocabularies.
  direction: z.enum(CLAIM_DIRECTIONS).nullable(),
  source: ProductLinkSchema,
  target: ProductLinkSchema,
  /**
   * The connector that delivers this edge — non-null **only** on a
   * connector-evidenced pair, and the discriminant for which table the row came
   * from (AECI-721 / §13.1's delivered tier).
   *
   * Distinct from `IntegrationDetail.powered_by_product`, which is the same fact
   * about a row still living in `integrations`: a self-referential Convention-A
   * edge (`powered_by` = one of its own endpoints, ~152 catalog-wide) stays put
   * and keeps `powered_by_product` with `via: null`. Both may not be set at once.
   */
  via: ProductLinkSchema.nullable().default(null),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});

export type IntegrationListItem = z.infer<typeof IntegrationListItemSchema>;

/**
 * Product-detail embed of an integration — the rows in
 * `ProductDetail.integrations_as_source` / `integrations_as_target`. Extends the
 * list item with `context_direction`: the effective flow direction **relative to
 * the page's product**, made claims-aware (Stage 1.5 §3.2). It is derived on the
 * server from the mechanism's `data_object` claims when it has them (the same
 * signal the pair page surfaces), else the stored row `direction` translated to
 * this product's frame, else `null` (unknown → the table renders an em-dash).
 *
 * Precomputed server-side and rendered verbatim so the table's Direction column
 * can never contradict the pair page (superseding the stored-`direction`-only
 * framing of §3.2). Only this embed carries it — the bare `IntegrationListItem`
 * used by `/api/integrations` and the home rail has no single context product.
 */
export const ProductIntegrationItemSchema = IntegrationListItemSchema.extend({
  context_direction: ContextDirectionSchema.nullable(),
  /**
   * The connector named by this row's `integrations.powered_by_product_id`, for
   * a row that is still in `integrations` (Stage 1.5 §13.4(1)). Added on the
   * product-detail embed only — `/api/integrations` and the home rail have no
   * lane to route and do not pay for the join.
   *
   * **Not a second `via`, and never set at the same time as one.** `via` is the
   * connector of a `connector_evidenced_pairs` row; this is the same fact about
   * a row that has NOT moved there. After AECI-721 that leaves two populations,
   * and the endpoint lane router (§13.2) reads them differently:
   *
   *   - a **Convention-A self-reference** — `powered_by` equal to one of the
   *     row's own endpoints — stays in the DIRECT lane per §13.2(a). It is the
   *     larger population (60 production rows) and it is deliberate, not dirt.
   *   - a row whose `powered_by` is neither endpoint routes to the Via lane per
   *     §13.2(b). Post-migration that set is empty in a migrated database, and
   *     that is exactly why this field is here: preview and staging D1 are not
   *     migrated by CI, and without it every connector edge in an un-migrated
   *     environment misfiles as direct — the failure AECI-706 guarded against.
   */
  powered_by_product: ProductLinkSchema.nullable().default(null),
  /**
   * The distinct `data_object` slugs this edge's claims cover (AECI-711, the depth
   * axis), from `distinctDataObjectSlugs` — the AECI-1042 counting rule the pair
   * page's sync headline uses. Empty when the edge has no claims, and an empty
   * list renders nothing: no "not specified" marker (the 2026-09-22 ruling).
   *
   * Slugs rather than a count because the Via lane collapses several edges into
   * one (connector, partner) row, and a merged row's coverage is the UNION of its
   * edges' objects. Two counts cannot be unioned; two slug lists can.
   */
  data_object_slugs: z.array(z.string()).default([]),
});

export type ProductIntegrationItem = z.infer<typeof ProductIntegrationItemSchema>;

/**
 * Product-detail embed of an edge the page product POWERS as the connector: the
 * rows in `ProductDetail.integrations_as_connector` (Stage 1.5 Addendum B). The
 * bare list item plus `data_object_slugs` only (AECI-1080). No
 * `context_direction`, because the page product is neither endpoint.
 *
 * `data_object_slugs` means exactly what it means on `ProductIntegrationItem`:
 * the distinct objects the edge's claims cover, `[]` when it has none. The hub
 * collapses several edges into one pair row and shows the union, which is why
 * the wire carries slugs rather than a count. `/api/integrations` does not carry
 * it and does not pay for the claims join.
 */
export const PoweredIntegrationItemSchema = IntegrationListItemSchema.extend({
  data_object_slugs: z.array(z.string()).default([]),
});

export type PoweredIntegrationItem = z.infer<typeof PoweredIntegrationItemSchema>;

/**
 * Full integration detail returned by `GET /api/integrations/:id`. Adds the
 * description, links, optional vendor / connector product, and editorial
 * metadata (pricing, maturity) on top of the list-item shape.
 */
export const IntegrationDetailSchema = IntegrationListItemSchema.extend({
  description: z.string().nullable(),
  listing_url: z.string().url().nullable(),
  docs_url: z.string().url().nullable(),
  mechanism_url: z.string().url().nullable(),
  built_by_vendor: VendorLinkSchema.nullable(),
  powered_by_product: ProductLinkSchema.nullable(),
  pricing_model: z.string().nullable(),
  maturity: z.string().nullable(),
});

export type IntegrationDetail = z.infer<typeof IntegrationDetailSchema>;

/**
 * `GET /api/integrations/:id` for a RETIRED row (AECI-1010, ruled 2026-09-22).
 *
 * The route stays unfiltered so the legacy `/integrations/:id` 301 keeps working,
 * but a retired row is off the public record. So it answers only what the redirect
 * needs: the two endpoint slugs. No name, description, notes or any other content.
 * `retired: true` is the discriminant.
 */
export const RetiredIntegrationDetailSchema = z.object({
  id: z.string().uuid(),
  retired: z.literal(true),
  source: z.object({ slug: z.string() }),
  target: z.object({ slug: z.string() }),
});

export type RetiredIntegrationDetail = z.infer<typeof RetiredIntegrationDetailSchema>;

/** The whole `GET /api/integrations/:id` response: a live row's detail, or a
 *  retired row's redirect-only shape. */
export const IntegrationDetailResponseSchema = z.union([
  RetiredIntegrationDetailSchema,
  IntegrationDetailSchema,
]);

export type IntegrationDetailResponse = z.infer<typeof IntegrationDetailResponseSchema>;

/**
 * Query for `GET /api/integrations`. Filter fields use the camelCase names
 * called out in the AECI-50 acceptance criteria (`sourceProductId`,
 * `targetProductId`); enum-valued filters keep the snake_case form that
 * matches the underlying columns.
 */
export const IntegrationsListQuerySchema = PageQuerySchema.extend({
  sort: IntegrationSortSchema,
  search: z.string().optional(),
  sourceProductId: z.string().uuid().optional(),
  targetProductId: z.string().uuid().optional(),
  mechanism_kind: IntegrationMechanismKindSchema.optional(),
  direction: IntegrationDirectionSchema.optional(),
});

export type IntegrationsListQuery = z.infer<typeof IntegrationsListQuerySchema>;

export const IntegrationsListResponseSchema = paginatedResponseSchema(IntegrationListItemSchema);

export type IntegrationsListResponse = z.infer<typeof IntegrationsListResponseSchema>;
