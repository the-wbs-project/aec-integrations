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
  type IntegrationsListResponse,
  type PairTimelineResponse,
  type ProductPairResponse,
} from '@aeci/shared';
import { vendorTiersFromMirror } from '@aeci/shared/version-diff';
import { and, count, eq, inArray, like, or, type SQL } from 'drizzle-orm';
import type { Context } from 'hono';

import { getDb } from '../db/client';
import { integrations, products, productVersions } from '../db/schema';
import type { Env } from '../env';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import {
  integrationDetailConfig,
  integrationListConfig,
  integrationPairConfig,
  integrationTimelineConfig,
  pickPrimaryVendor,
  productListConfig,
  productVersionDiffGateConfig,
  toIntegrationDetail,
  toIntegrationListItem,
  toPairTimelines,
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

    const [rows, countRows] = await Promise.all([
      db.query.integrations.findMany({
        ...integrationListConfig,
        where,
        orderBy: resolveIntegrationOrderBy(query.sort),
        limit: query.perPage,
        offset: (query.page - 1) * query.perPage,
      }),
      db.select({ value: count() }).from(integrations).where(where),
    ]);

    const body: IntegrationsListResponse = {
      data: rows.map(toIntegrationListItem),
      page: query.page,
      perPage: query.perPage,
      total: countRows[0]?.value ?? 0,
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

    // Both reads depend only on the two product ids, so they share one wave — the
    // versions read adds a subrequest, never a round-trip of depth.
    const [rows, versionRows] = await Promise.all([
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
