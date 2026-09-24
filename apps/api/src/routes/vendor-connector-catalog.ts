/**
 * The connector catalogue seat's own catalogue (AECI-1083 —
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.16, `STAGE_2_SPEC.md` §8.9(1)).
 *
 *   GET /api/vendor/products/:id/connector-catalog?page&perPage&state&search
 *
 * The read behind the portal's Catalogue tab on a `connector`-role product. It lists
 * the listings in that product's catalogue, each with its mappings, so the seat can
 * reach `PATCH /api/vendor/connector-stub-mappings/:id` (AECI-724) from a screen
 * instead of through the API.
 *
 * ── GATES ───────────────────────────────────────────────────────────────────
 * `requireVendor()` at the route. Then, in order, every miss the same 404 (the
 * AECI-520 non-disclosure rule):
 *
 *   1. `requireOwnedProduct` — the caller's vendor holds `:id`;
 *   2. the product is `connector`-role — the PATCH's own ownership clause, so a
 *      vendor holding the product in another role reads nothing it could not edit.
 *
 * No `requireCapability` and no entitlement read (§8.9(2): the seat is not an
 * entitlement row). Not rate-limited: reads never are (ADR 0026). A pure read, so no
 * `audit_log` row (ADR 0022). `/vendor/*` is uncacheable, so no `Cache-Tag`.
 *
 * A connector product with no catalogue answers 200 with `catalog: null`. That is a
 * real state: AECi holds catalogues for a handful of connectors, not all of them.
 *
 * ── WHAT IS NOT ON THE WIRE ────────────────────────────────────────────────
 * `notes` and the raw `decided_by` stay server-side; `decided_by` crosses as a kind.
 * Removed listings are not returned. `packages/shared/src/api/vendor-connector-catalog.ts`
 * has the argument.
 *
 * ── INSIDE THE AECI-516 CURSOR ─────────────────────────────────────────────
 * Unlike `GET /api/vendor/products/:id/connectors`, this data moves on something the
 * vendor does: its own seats' edits. So it has a scope, `catalogue`, read under the
 * SAME `ownedConnectorCatalogIds` predicate this handler resolves its catalogue with
 * (`STAGE_2_REALTIME_SPEC.md` §2.2).
 */

import {
  VendorConnectorCatalogQuerySchema,
  VendorConnectorCatalogResponseSchema,
  connectorDeciderKind,
  type VendorConnectorCatalogResponse,
  type VendorConnectorListing,
  type VendorConnectorMapping,
} from '@aeci/shared';
import { and, asc, count, eq, inArray, isNull, max, sql } from 'drizzle-orm';

import { getDb } from '../db/client';
import {
  connectorCatalogSurfaces,
  connectorCatalogs,
  connectorStubMappings,
  connectorStubs,
  products,
} from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { isPublishable, publishableMapping, stubFilterWhere } from '../lib/admin-connectors';
import { textAsc } from '../lib/collation';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { ownedConnectorCatalogIds } from '../lib/vendor-connector-catalog';
import { requireOwnedProduct, sessionVendorId, type VendorContext } from './vendor-shared';

export function createVendorConnectorCatalogHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const productId = c.req.param('id');
    if (!productId) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing product id', { field: 'id' });
    }
    const query = VendorConnectorCatalogQuerySchema.parse(
      Object.fromEntries(new URL(c.req.url).searchParams),
    );
    const { db } = dbFor(c.env);

    // ── 1–2. Ownership, then role. Both misses are the same 404. ──────────────
    const owned = await requireOwnedProduct(db, vendorId, productId);
    if (owned.product.productRole !== 'connector') {
      throw notFoundError('product', { id: productId });
    }

    // The catalogue, resolved THROUGH the shared predicate rather than beside it, so
    // this read and the `catalogue` cursor cannot scope differently.
    const catalog = await db
      .select({ id: connectorCatalogs.id, managedBy: connectorCatalogs.managedBy })
      .from(connectorCatalogs)
      .where(
        and(
          eq(connectorCatalogs.connectorProductId, productId),
          inArray(connectorCatalogs.id, ownedConnectorCatalogIds(db, vendorId)),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (!catalog) {
      return respond(c, {
        data: [],
        page: query.page,
        perPage: query.perPage,
        total: 0,
        product_id: productId,
        catalog: null,
      });
    }

    const where = stubFilterWhere(catalog.id, {
      state: query.state,
      search: query.search,
      includeRemoved: false,
    });
    const live = and(eq(connectorStubs.catalogId, catalog.id), isNull(connectorStubs.removedAt));

    const [surfaceRows, listingRows, unmatchedRows, publishableRows, pageRows, totalRows] =
      await db.batch([
        db
          .select({ value: max(connectorCatalogSurfaces.lastIngestedAt) })
          .from(connectorCatalogSurfaces)
          .where(eq(connectorCatalogSurfaces.catalogId, catalog.id)),
        db.select({ value: count() }).from(connectorStubs).where(live),
        // §9a.4: "the absence of a row is pending", so this is an anti-join.
        db
          .select({ value: count() })
          .from(connectorStubs)
          .where(
            and(
              live,
              sql`not exists (select 1 from ${connectorStubMappings} where ${connectorStubMappings.stubId} = ${connectorStubs.id})`,
            ),
          ),
        db
          .select({ value: count() })
          .from(connectorStubMappings)
          .innerJoin(connectorStubs, eq(connectorStubs.id, connectorStubMappings.stubId))
          .where(and(live, publishableMapping)),
        db
          .select({
            id: connectorStubs.id,
            slug: connectorStubs.slug,
            label: connectorStubs.label,
            url: connectorStubs.url,
          })
          .from(connectorStubs)
          .where(where)
          // A catalogue the vendor maintains reads as an index, so by name. `id`
          // is the tiebreaker that keeps page boundaries stable.
          .orderBy(
            textAsc(sql`coalesce(${connectorStubs.label}, ${connectorStubs.slug})`),
            asc(connectorStubs.id),
          )
          .limit(query.perPage)
          .offset((query.page - 1) * query.perPage),
        db.select({ value: count() }).from(connectorStubs).where(where),
      ]);

    const stubIds = pageRows.map((r) => r.id);
    const mappingRows =
      stubIds.length === 0
        ? []
        : await db
            .select({
              id: connectorStubMappings.id,
              stubId: connectorStubMappings.stubId,
              status: connectorStubMappings.status,
              productId: connectorStubMappings.productId,
              confidence: connectorStubMappings.confidence,
              evidenceUrl: connectorStubMappings.evidenceUrl,
              decidedBy: connectorStubMappings.decidedBy,
              decidedAt: connectorStubMappings.decidedAt,
            })
            .from(connectorStubMappings)
            .where(inArray(connectorStubMappings.stubId, stubIds))
            .orderBy(asc(connectorStubMappings.id));

    const productIds = [
      ...new Set(mappingRows.map((m) => m.productId).filter((v): v is string => v !== null)),
    ];
    const productRows =
      productIds.length === 0
        ? []
        : await db
            .select({ id: products.id, name: products.name, slug: products.slug })
            .from(products)
            .where(inArray(products.id, productIds));
    const productById = new Map(productRows.map((p) => [p.id, p]));

    const byStub = new Map<string, VendorConnectorMapping[]>();
    for (const m of mappingRows) {
      const list = byStub.get(m.stubId) ?? [];
      const product = m.productId ? productById.get(m.productId) : undefined;
      list.push({
        id: m.id,
        status: m.status as VendorConnectorMapping['status'],
        product: product ? { id: product.id, name: product.name, slug: product.slug } : null,
        confidence: (m.confidence as VendorConnectorMapping['confidence']) ?? null,
        evidence_url: m.evidenceUrl ?? null,
        decided_by: connectorDeciderKind(m.decidedBy ?? null),
        decided_at: m.decidedAt ?? null,
        publishable: isPublishable(m),
      });
      byStub.set(m.stubId, list);
    }

    return respond(c, {
      data: pageRows.map(
        (r): VendorConnectorListing => ({
          id: r.id,
          slug: r.slug,
          label: r.label ?? null,
          url: r.url ?? null,
          mappings: byStub.get(r.id) ?? [],
        }),
      ),
      page: query.page,
      perPage: query.perPage,
      total: totalRows[0]?.value ?? 0,
      product_id: productId,
      catalog: {
        id: catalog.id,
        managed_by: catalog.managedBy as 'review' | 'vendor',
        last_ingested_at: surfaceRows[0]?.value ?? null,
        listings: listingRows[0]?.value ?? 0,
        unmatched: unmatchedRows[0]?.value ?? 0,
        publishable: publishableRows[0]?.value ?? 0,
      },
    });
  };
}

function respond(c: VendorContext, body: VendorConnectorCatalogResponse): Response {
  validateResponseInDev(c.env, () => {
    VendorConnectorCatalogResponseSchema.parse(body);
  });
  return json(body);
}
