/**
 * Phase 2.8 (AECI-54) integrations endpoints — Drizzle/D1 (ADR 0016 / AECI-253).
 *
 *   GET /api/integrations       — paginated, filterable (search,
 *                                 sourceProductId, targetProductId,
 *                                 mechanism_kind, direction), sortable list.
 *   GET /api/integrations/:id   — single integration detail with vendor/connector
 *                                 hydration.
 *
 * Default sort is `name ASC` (§7.4). `search` expands to an OR across the explicit
 * `name` column AND both product-name columns (rows without an explicit name have
 * their display name synthesised from source/target at the API layer, so a plain
 * `name LIKE` would miss them) — expressed as `product_id IN (subquery)`.
 */

import {
  IntegrationDetailSchema,
  IntegrationsListQuerySchema,
  IntegrationsListResponseSchema,
  PairTimelineResponseSchema,
  ProductPairResponseSchema,
  type IntegrationDetail,
  type IntegrationListItem,
  type IntegrationsListResponse,
  type PairTimelineResponse,
  type ProductPairResponse,
} from '@aeci/shared';
import { vendorTiersFromMirror } from '@aeci/shared/version-diff';
import { and, asc, count, eq, inArray, like, or, sql, type SQL } from 'drizzle-orm';
import { unionAll } from 'drizzle-orm/sqlite-core';
import type { Context } from 'hono';

import { getDb, type Db } from '../db/client';
import { connectorEvidencedPairs, integrations, products, productVersions } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import {
  coerceDirection,
  connectorEvidencedPairPairConfig,
  integrationDetailConfig,
  integrationListConfig,
  integrationPairConfig,
  integrationTimelineConfig,
  pickPrimaryVendor,
  productListConfig,
  productVersionDiffGateConfig,
  productLinkColumns,
  toIntegrationDetail,
  toMechanismKind,
  toPairTimelines,
  toProductLink,
  toProductPairResponse,
  VERSION_ORDER,
} from '../lib/drizzle-helpers';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import {
  CONTEXT_VERSION_PARAM,
  OTHER_VERSION_PARAM,
  resolveDiffAccess,
  resolveVersionSelection,
} from '../lib/pair-version-diff';
import { resolveIntegrationOrderBy } from '../lib/sort';

// ---------------------------------------------------------------------------
// `GET /api/integrations` union plumbing (AECI-721)
//
// The delivered tier lives in two tables (`STAGE_1_5_SPEC.md` §13.1), and this
// endpoint publishes the whole tier. Everything below exists to make one paged,
// sorted, filtered list out of both — see the comment at the call site for why a
// UNION and not two page reads.
//
// The shape is deliberately narrow: ids only, hydrated in a second bounded read.
// A union that also joined both endpoint products and the connector would repeat
// three joins per arm for rows the page may not even return.
// ---------------------------------------------------------------------------

/** One row of the union: the columns both tables can agree on, plus `viaProductId`
 *  as the discriminant. Product links are hydrated afterwards. */
interface UnionRow {
  id: string;
  name: string | null;
  mechanismKind: string | null;
  mechanismName: string | null;
  direction: string | null;
  sourceProductId: string;
  targetProductId: string;
  viaProductId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Sentinel: this query cannot match an evidenced pair at all, so the second arm
 *  is dropped rather than run with an impossible predicate. */
const EXCLUDE_EVIDENCED = Symbol('exclude-evidenced');

function integrationsListSelect(db: Db, where: SQL | undefined) {
  return db
    .select({
      id: integrations.id,
      name: integrations.name,
      mechanismKind: integrations.mechanismKind,
      mechanismName: integrations.mechanismName,
      direction: integrations.direction,
      sourceProductId: integrations.sourceProductId,
      targetProductId: integrations.targetProductId,
      viaProductId: sql<string | null>`NULL`.as('via_product_id'),
      createdAt: integrations.createdAt,
      updatedAt: integrations.updatedAt,
    })
    .from(integrations)
    .where(where);
}

/**
 * The evidenced arm, re-oriented into the `source`/`target` frame the wire shape
 * speaks. Same inverse CASE as `orientEvidencedPair`, expressed in SQL because the
 * ORDER BY and the pagination have to see the oriented values, not the canonical
 * ones. `mechanism_kind` is a literal NULL — the table has no such column.
 */
function evidencedListSelect(db: Db, where: SQL | undefined) {
  return db
    .select({
      id: connectorEvidencedPairs.id,
      name: connectorEvidencedPairs.name,
      mechanismKind: sql<string | null>`NULL`.as('mechanism_kind'),
      mechanismName: connectorEvidencedPairs.mechanismName,
      direction: sql<string | null>`CASE "connector_evidenced_pairs"."direction"
          WHEN 'a_to_b' THEN 'one-way'
          WHEN 'b_to_a' THEN 'one-way'
          WHEN 'both' THEN 'bidirectional'
        END`.as('direction'),
      sourceProductId: sql<string>`CASE WHEN "connector_evidenced_pairs"."direction" = 'b_to_a'
          THEN "connector_evidenced_pairs"."product_b_id"
          ELSE "connector_evidenced_pairs"."product_a_id" END`.as('source_product_id'),
      targetProductId: sql<string>`CASE WHEN "connector_evidenced_pairs"."direction" = 'b_to_a'
          THEN "connector_evidenced_pairs"."product_a_id"
          ELSE "connector_evidenced_pairs"."product_b_id" END`.as('target_product_id'),
      viaProductId: connectorEvidencedPairs.connectorProductId,
      createdAt: connectorEvidencedPairs.createdAt,
      updatedAt: connectorEvidencedPairs.updatedAt,
    })
    .from(connectorEvidencedPairs)
    .where(where);
}

/**
 * Translate the list filters onto the evidenced table, or refuse the arm entirely.
 *
 * `?mechanism_kind=` returns `EXCLUDE_EVIDENCED` for every value: an evidenced pair
 * carries no kind, so it matches none of them. That is the honest answer rather
 * than a quiet inconsistency — filtering by kind narrows to `integrations` by
 * definition, and a caller asking for `?mechanism_kind=native` should not receive
 * rows whose kind is null.
 *
 * The endpoint filters need the same orientation CASE as the select, because
 * `?sourceProductId=` means "source in the rendered frame", not "slot A".
 */
function evidencedListPredicate(
  db: Db,
  query: {
    search?: string;
    sourceProductId?: string;
    targetProductId?: string;
    mechanism_kind?: string;
    direction?: string;
  },
): SQL | undefined | typeof EXCLUDE_EVIDENCED {
  if (query.mechanism_kind) return EXCLUDE_EVIDENCED;

  const conds: SQL[] = [];
  if (query.search) {
    const term = `%${query.search}%`;
    const matchByProductName = () =>
      db.select({ id: products.id }).from(products).where(like(products.name, term));
    conds.push(
      or(
        like(connectorEvidencedPairs.name, term),
        inArray(connectorEvidencedPairs.productAId, matchByProductName()),
        inArray(connectorEvidencedPairs.productBId, matchByProductName()),
      )!,
    );
  }
  if (query.sourceProductId) {
    conds.push(
      sql`CASE WHEN "connector_evidenced_pairs"."direction" = 'b_to_a'
            THEN "connector_evidenced_pairs"."product_b_id"
            ELSE "connector_evidenced_pairs"."product_a_id" END = ${query.sourceProductId}`,
    );
  }
  if (query.targetProductId) {
    conds.push(
      sql`CASE WHEN "connector_evidenced_pairs"."direction" = 'b_to_a'
            THEN "connector_evidenced_pairs"."product_a_id"
            ELSE "connector_evidenced_pairs"."product_b_id" END = ${query.targetProductId}`,
    );
  }
  if (query.direction === 'one-way') {
    conds.push(inArray(connectorEvidencedPairs.direction, ['a_to_b', 'b_to_a']));
  } else if (query.direction === 'bidirectional') {
    conds.push(eq(connectorEvidencedPairs.direction, 'both'));
  }
  return conds.length ? and(...conds) : undefined;
}

/** `resolveIntegrationOrderBy` addresses `integrations` columns, which a union has
 *  no access to — order by the union's own OUTPUT column names instead. Same two
 *  sorts, same total-order id tiebreak, so paging stays stable. */
function resolveUnionOrderBy(sort: 'name' | 'created'): SQL[] {
  return sort === 'created'
    ? [sql`"created_at" DESC`, sql`"id" ASC`]
    : [sql`"name" ASC`, sql`"id" ASC`];
}

/** Adapt a relational-builder row to the union shape, for the fast path that skips
 *  the union because the query excluded the evidenced arm. */
function toUnionRow(raw: {
  id: string;
  name: string | null;
  mechanismKind: string | null;
  mechanismName: string | null;
  direction: string | null;
  createdAt: string;
  updatedAt: string;
  sourceProduct: { id: string };
  targetProduct: { id: string };
}): UnionRow {
  return {
    id: raw.id,
    name: raw.name,
    mechanismKind: raw.mechanismKind,
    mechanismName: raw.mechanismName,
    direction: raw.direction,
    sourceProductId: raw.sourceProduct.id,
    targetProductId: raw.targetProduct.id,
    viaProductId: null,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
  };
}

/** Hydrate the page's product links in ONE bounded read (≤ 3 ids per row) and map
 *  to the wire shape. A missing product is impossible — every id is a NOT NULL FK
 *  with `ON DELETE CASCADE` — so an absent row is a data-integrity failure, not a
 *  case to render around. */
async function hydrateUnionRows(db: Db, rows: UnionRow[]): Promise<IntegrationListItem[]> {
  if (rows.length === 0) return [];
  const ids = new Set<string>();
  for (const row of rows) {
    ids.add(row.sourceProductId);
    ids.add(row.targetProductId);
    if (row.viaProductId) ids.add(row.viaProductId);
  }
  const linkRows = await db.query.products.findMany({
    columns: productLinkColumns,
    where: inArray(products.id, [...ids]),
  });
  const byId = new Map(linkRows.map((p) => [p.id, p]));
  const link = (id: string, rowId: string) => {
    const found = byId.get(id);
    if (!found)
      throw new Error(`Data integrity: integration ${rowId} references missing product ${id}`);
    return toProductLink(found);
  };
  return rows.map((row) => {
    const source = link(row.sourceProductId, row.id);
    const target = link(row.targetProductId, row.id);
    return {
      id: row.id,
      name: row.name && row.name.length > 0 ? row.name : `${source.name} → ${target.name}`,
      mechanism_kind: toMechanismKind(row.mechanismKind, row.id),
      mechanism_name: row.mechanismName,
      direction: coerceDirection(row.direction),
      source,
      target,
      via: row.viaProductId ? link(row.viaProductId, row.id) : null,
      created_at: row.createdAt,
      updated_at: row.updatedAt,
    };
  });
}

export function createIntegrationsListHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const query = IntegrationsListQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );

    const { db } = dbFor(c.env);
    const conds: SQL[] = [];
    if (query.search) {
      const term = `%${query.search}%`;
      const matchByProductName = () =>
        db.select({ id: products.id }).from(products).where(like(products.name, term));
      conds.push(
        or(
          like(integrations.name, term),
          inArray(integrations.sourceProductId, matchByProductName()),
          inArray(integrations.targetProductId, matchByProductName()),
        )!,
      );
    }
    if (query.sourceProductId) conds.push(eq(integrations.sourceProductId, query.sourceProductId));
    if (query.targetProductId) conds.push(eq(integrations.targetProductId, query.targetProductId));
    if (query.mechanism_kind) conds.push(eq(integrations.mechanismKind, query.mechanism_kind));
    if (query.direction) conds.push(eq(integrations.direction, query.direction));
    const where = conds.length ? and(...conds) : undefined;

    // ── The AECI-721 second source ────────────────────────────────────────────
    // The delivered tier spans two tables (§13.1), so this list spans two tables.
    // Skipping the evidenced arm is not a cosmetic omission: `sitemap.ts` paginates
    // THIS endpoint to emit pair-page URLs, so 19 real production pages would fall
    // out of the sitemap as a side effect of an internal storage move.
    //
    // Composed with `unionAll` rather than by merging two page reads in memory,
    // because `limit`/`offset` and `ORDER BY` have to apply to the COMBINED set —
    // paginating each table separately and concatenating produces a page that is
    // neither correctly ordered nor correctly sized.
    const evidencedWhere = evidencedListPredicate(db, query);

    const unionRows =
      evidencedWhere === EXCLUDE_EVIDENCED
        ? null
        : unionAll(integrationsListSelect(db, where), evidencedListSelect(db, evidencedWhere));

    const [rows, countRows] = await Promise.all([
      unionRows
        ? unionRows
            .orderBy(...resolveUnionOrderBy(query.sort))
            .limit(query.perPage)
            .offset((query.page - 1) * query.perPage)
        : db.query.integrations
            .findMany({
              ...integrationListConfig,
              where,
              orderBy: resolveIntegrationOrderBy(query.sort),
              limit: query.perPage,
              offset: (query.page - 1) * query.perPage,
            })
            .then((found) => found.map(toUnionRow)),
      Promise.all([
        db.select({ value: count() }).from(integrations).where(where),
        evidencedWhere === EXCLUDE_EVIDENCED
          ? Promise.resolve([{ value: 0 }])
          : db.select({ value: count() }).from(connectorEvidencedPairs).where(evidencedWhere),
      ]),
    ]);

    const body: IntegrationsListResponse = {
      data: await hydrateUnionRows(db, rows),
      page: query.page,
      perPage: query.perPage,
      total: (countRows[0][0]?.value ?? 0) + (countRows[1][0]?.value ?? 0),
    };

    validateResponseInDev(c.env, () => {
      IntegrationsListResponseSchema.parse(body);
    });

    return json(body);
  };
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createIntegrationDetailHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const id = c.req.param('id');
    if (!id) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing integration id', { field: 'id' });
    }
    if (!UUID_REGEX.test(id)) {
      throw notFoundError('integration', { id });
    }

    const { db } = dbFor(c.env);
    const row = await db.query.integrations.findFirst({
      ...integrationDetailConfig,
      where: eq(integrations.id, id),
    });

    if (!row) throw notFoundError('integration', { id });

    const body: IntegrationDetail = toIntegrationDetail(row);

    validateResponseInDev(c.env, () => {
      IntegrationDetailSchema.parse(body);
    });

    return json(body);
  };
}

/**
 * `GET /api/products/:contextSlug/integrations/:otherSlug` — the product-PAIR
 * read (Stage 1.5 §7 — AECI-294). Resolves the two products by slug and returns
 * every integration between them (either source/target orientation) as
 * mechanisms, with each mechanism's direction translated into the context
 * product's frame. 404 when either slug is missing/unknown or the two are equal;
 * a valid-but-unconnected pair is a 200 with `mechanisms: []`.
 *
 * **AECI-303 (§9)** adds the two version selectors:
 * `?context_version=<label>&other_version=<label>`, defaulting to latest × latest.
 * Selection resolves in `resolveVersionSelection`, which also makes the single API
 * consult of the `canViewVersionDiff` seam. An unknown/renamed/over-long label
 * **degrades to latest and never 404s** — the pair exists, only the selection is
 * stale, and the resolved values are echoed in `version_diff.selected` so the UI
 * shows what was actually served. `version_diff` is `null` (and the response is the
 * pre-AECI-303 shape) whenever the diff does not apply, which is the ordinary case
 * for the whole catalog today.
 */
export function createProductPairHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    // The first path segment reuses the `:slug` param name shared by the other
    // `/api/products/:slug…` routes (Hono rejects differing param names at the
    // same position); it carries the *context* product slug for the pair.
    const contextSlug = c.req.param('slug');
    const otherSlug = c.req.param('otherSlug');
    if (!contextSlug || !otherSlug) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing product slug', { field: 'slug' });
    }
    // The two endpoints of a pair are always distinct (the integrations table's
    // distinct-endpoints check guarantees no self-integration), so equal slugs
    // can never yield a pair — 404 without touching the DB.
    if (contextSlug === otherSlug) {
      throw notFoundError('product', { slug: otherSlug });
    }

    const { db } = dbFor(c.env);
    const [contextProduct, otherProduct] = await Promise.all([
      db.query.products.findFirst({ ...productListConfig, where: eq(products.slug, contextSlug) }),
      db.query.products.findFirst({ ...productListConfig, where: eq(products.slug, otherSlug) }),
    ]);
    if (!contextProduct) throw notFoundError('product', { slug: contextSlug });
    if (!otherProduct) throw notFoundError('product', { slug: otherSlug });

    // All three reads depend only on the two product ids, so they share one wave —
    // each adds a subrequest, never a round-trip of depth.
    //
    // The evidenced-pair read is the AECI-721 second source (§13.1's delivered
    // tier). It is NOT an optimisation to fold away: after the migration, 19
    // production pairs live only in `connector_evidenced_pairs`, and querying
    // `integrations` alone would render "no integrations" for a pair that has a
    // working one. Its `where` needs no orientation `or` — the table stores the
    // pair canonically (`product_a_id < product_b_id`, a CHECK), so the two ids
    // sorted is the only key that can match.
    const [pairA, pairB] =
      contextProduct.id < otherProduct.id
        ? [contextProduct.id, otherProduct.id]
        : [otherProduct.id, contextProduct.id];

    const [rows, evidencedRows, versionRows] = await Promise.all([
      db.query.integrations.findMany({
        ...integrationPairConfig,
        where: or(
          and(
            eq(integrations.sourceProductId, contextProduct.id),
            eq(integrations.targetProductId, otherProduct.id),
          ),
          and(
            eq(integrations.sourceProductId, otherProduct.id),
            eq(integrations.targetProductId, contextProduct.id),
          ),
        ),
        orderBy: resolveIntegrationOrderBy('name'),
      }),
      db.query.connectorEvidencedPairs.findMany({
        ...connectorEvidencedPairPairConfig,
        where: and(
          eq(connectorEvidencedPairs.productAId, pairA),
          eq(connectorEvidencedPairs.productBId, pairB),
        ),
        orderBy: [asc(connectorEvidencedPairs.name), asc(connectorEvidencedPairs.id)],
      }),
      db.query.productVersions.findMany({
        columns: {
          id: true,
          productId: true,
          label: true,
          releasedAt: true,
          sortKey: true,
          createdAt: true,
        },
        where: inArray(productVersions.productId, [contextProduct.id, otherProduct.id]),
        orderBy: VERSION_ORDER,
      }),
    ]);

    // Whether ANY live attestation on this pair is version-stamped. Both products
    // can have releases while nothing on this pair varies by them, and selectors
    // that cannot change anything are worse than none — so this decides, with the
    // claims in hand, whether §9 applies at all.
    const hasVersionStamps = rows.some((row) =>
      row.claims.some((claim) =>
        claim.attestations.some(
          (a) => a.introducedVersionId !== null || a.deprecatedVersionId !== null,
        ),
      ),
    );

    const versions = resolveVersionSelection({
      versionRows,
      contextProductId: contextProduct.id,
      otherProductId: otherProduct.id,
      contextParam: c.req.query(CONTEXT_VERSION_PARAM),
      otherParam: c.req.query(OTHER_VERSION_PARAM),
      // AECI-304: the gate reads the PAIR'S vendors, never the reader — so it stays
      // a pure function of the two slugs in the URL and the page stays edge-cacheable.
      // `verified` is the mirror of an `active` entitlement row; the entitlement
      // table is never queried on a read path (`STAGE_2_PAID_TIERS_SPEC.md` §2.5).
      pairVendorTiers: vendorTiersFromMirror([
        pickPrimaryVendor(contextProduct.productVendors),
        pickPrimaryVendor(otherProduct.productVendors),
      ]),
      hasVersionStamps,
    });

    const body: ProductPairResponse = toProductPairResponse(
      contextProduct,
      otherProduct,
      rows,
      evidencedRows,
      versions ?? undefined,
    );

    validateResponseInDev(c.env, () => {
      ProductPairResponseSchema.parse(body);
    });

    return json(body);
  };
}

/**
 * `GET /api/products/:slug/integrations/:otherSlug/timeline` — the per-claim
 * attestation **history** for a pair (AECI-303 / §9.1).
 *
 * Pair-scoped rather than claim-scoped so one browser fetch serves every provenance
 * popover on the page. Deliberately a **separate, lazy** read rather than inline on
 * the pair response, for one decisive reason: history is the gateable depth (§9.3),
 * and the pair page is stored in a shared, URL-keyed edge cache. AECI-304 put that
 * gate on the PAIR'S vendors rather than the reader, so it stayed URL-derived and
 * `STAGE_1_SPEC.md` §9.1a holds — but the separation still earns its keep: `/api/*`
 * responses are `private, no-store`, and this is the only unbounded payload in the
 * system, since the append-only log grows forever.
 *
 * 404 rules mirror the pair read exactly (unknown slug, equal slugs), so a reader
 * who can see the pair can ask for its history and no more.
 */
export function createPairTimelineHandler(
  dbFor: DbFactory = getDb,
): (c: Context<{ Bindings: Env }>) => Promise<Response> {
  return async (c) => {
    const contextSlug = c.req.param('slug');
    const otherSlug = c.req.param('otherSlug');
    if (!contextSlug || !otherSlug) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing product slug', { field: 'slug' });
    }
    if (contextSlug === otherSlug) {
      throw notFoundError('product', { slug: otherSlug });
    }

    const { db } = dbFor(c.env);
    // `productVersionDiffGateConfig` widens the old `{ id: true }` by exactly the
    // vendor links the §9.3 gate reads (AECI-304). Same config + same
    // `pickPrimaryVendor` as the pair read, so the two endpoints cannot disagree
    // about which vendor of a multi-vendor product decides the gate.
    const [contextProduct, otherProduct] = await Promise.all([
      db.query.products.findFirst({
        ...productVersionDiffGateConfig,
        where: eq(products.slug, contextSlug),
      }),
      db.query.products.findFirst({
        ...productVersionDiffGateConfig,
        where: eq(products.slug, otherSlug),
      }),
    ]);
    if (!contextProduct) throw notFoundError('product', { slug: contextSlug });
    if (!otherProduct) throw notFoundError('product', { slug: otherSlug });

    // The timeline IS history, so `historical` is unconditionally true. Routed
    // through `resolveDiffAccess` rather than calling `canViewVersionDiff` directly,
    // which is what keeps the seam at exactly two consult sites repo-wide (§9.3).
    // The tiers are the PAIR'S, never the reader's (AECI-304).
    const access = resolveDiffAccess(
      true,
      vendorTiersFromMirror([
        pickPrimaryVendor(contextProduct.productVendors),
        pickPrimaryVendor(otherProduct.productVendors),
      ]),
    );
    if (access === 'latest_only') {
      const gated: PairTimelineResponse = { claims: [], diff_access: access };
      validateResponseInDev(c.env, () => {
        PairTimelineResponseSchema.parse(gated);
      });
      return json(gated);
    }

    const [rows, versionRows] = await Promise.all([
      db.query.integrations.findMany({
        ...integrationTimelineConfig,
        where: or(
          and(
            eq(integrations.sourceProductId, contextProduct.id),
            eq(integrations.targetProductId, otherProduct.id),
          ),
          and(
            eq(integrations.sourceProductId, otherProduct.id),
            eq(integrations.targetProductId, contextProduct.id),
          ),
        ),
      }),
      db.query.productVersions.findMany({
        columns: { id: true, label: true },
        where: inArray(productVersions.productId, [contextProduct.id, otherProduct.id]),
      }),
    ]);

    // Only the label lookup is needed here — presence and ordering are the pair
    // read's job, and a history row is rendered, never compared.
    const labelById = new Map(versionRows.map((row) => [row.id, row.label]));
    const body: PairTimelineResponse = {
      claims: toPairTimelines(rows, contextProduct.id, {
        versionLabel: (versionId) => (versionId === null ? undefined : labelById.get(versionId)),
      }),
      diff_access: access,
    };

    validateResponseInDev(c.env, () => {
      PairTimelineResponseSchema.parse(body);
    });

    return json(body);
  };
}
