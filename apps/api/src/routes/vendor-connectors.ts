/**
 * The connectors that reach one owned product (AECI-1013 —
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.13), Drizzle/D1.
 *
 *   GET /api/vendor/products/:id/connectors — read-only, grouped per connector.
 *
 * ── WHAT IT RETURNS ─────────────────────────────────────────────────────────
 * One group per connector that reaches the product, each carrying the two tiers
 * of `STAGE_1_5_SPEC.md` §13.1 side by side and never merged:
 *
 * - **delivered** — the product's `connector_evidenced_pairs` rows, taken from
 *   the SAME product-detail read the public page renders (`productDetailConfig`
 *   → `toProductDetail`), filtered to the rows whose `via` is set. The shape and
 *   the per-product framing are therefore the public page's, byte for byte.
 * - **reachable** — `reachablePartnersByConnector`, minus every partner already
 *   delivered by ANY path. The delivered set comes from `deliveredPartnerIdsOf`
 *   over the same two endpoint arrays the public "N more" line subtracts, so
 *   there is still exactly one copy of the two-table, two-orientation rule.
 *
 * A self-referential Convention-A edge (`integrations.powered_by_product_id` =
 * one of its own endpoints) and an `iPaaS` edge with no named connector are NOT
 * listed here: both stay in `integrations`, and the Integrations list above this
 * section already shows them read-only (`attestable: false`, AECI-705).
 *
 * ── GATES ───────────────────────────────────────────────────────────────────
 * `requireVendor()` at the route, then `requireOwnedProduct` → 404 for a product
 * the caller does not own (the AECI-520 non-disclosure rule). Not entitlement-
 * gated: reading your own product's data is not a paid capability. Not
 * rate-limited: reads never are (ADR 0026).
 *
 * ── OUTSIDE THE AECI-516 CURSOR, DELIBERATELY ───────────────────────────────
 * Nothing the reading vendor does moves this data. It changes only when an
 * operator's catalogue sync or a promote lands, or when a connector's seat edits a
 * mapping on its own vendor-managed catalogue (AECI-724), which is another vendor's
 * action. So a `GET /api/vendor/updates` scope for it
 * would poll every 20 s for a value that moves a few times a month, and adding
 * one means widening the cursor's scoping predicates, which ARE the
 * authorization on this surface (`STAGE_2_REALTIME_SPEC.md` §2.2). The client
 * fetches it when the tab mounts. It is a pure read, so no `audit_log` row.
 */

import {
  VendorProductConnectorsResponseSchema,
  type ProductLink,
  type VendorProductConnectorsResponse,
} from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';
import { eq, inArray, sql } from 'drizzle-orm';

import { getDb, type Db } from '../db/client';
import { connectorCatalogSurfaces, connectorCatalogs, products } from '../db/schema';
import { ApiError, notFoundError } from '../errors';
import { json } from '../http';
import { reachablePartnersByConnector } from '../lib/connector-reach';
import {
  deliveredPartnerIdsOf,
  productDetailConfig,
  productLinkColumns,
  toProductDetail,
  toProductLink,
} from '../lib/drizzle-helpers';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { chunked } from '../lib/promote-claims';
import { requireOwnedProduct, sessionVendorId, type VendorContext } from './vendor-shared';

function productIdParam(c: VendorContext): string {
  const productId = c.req.param('id');
  if (!productId) {
    throw new ApiError(400, 'VALIDATION_FAILED', 'Missing product id', { field: 'id' });
  }
  return productId;
}

/** Product links by id. Chunked because a Kroo-sized reach runs to hundreds of
 *  partners and D1 caps bound parameters per statement well below SQLite. */
async function productLinksById(db: Db, ids: readonly string[]): Promise<Map<string, ProductLink>> {
  const out = new Map<string, ProductLink>();
  if (ids.length === 0) return out;
  const pages = await Promise.all(
    chunked(ids).map((chunk) =>
      db.query.products.findMany({
        columns: productLinkColumns,
        where: inArray(products.id, chunk),
      }),
    ),
  );
  for (const row of pages.flat()) out.set(row.id, toProductLink(row));
  return out;
}

/** §13.1's "as of" stamp per connector product: the latest surface ingest of its
 *  catalogue. `MAX` ignores NULLs, as on the admin connector screen. */
async function catalogAsOfByConnector(
  db: Db,
  connectorProductIds: readonly string[],
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (connectorProductIds.length === 0) return out;
  const rows = await db
    .select({
      connectorProductId: connectorCatalogs.connectorProductId,
      asOf: sql<string | null>`max(${connectorCatalogSurfaces.lastIngestedAt})`,
    })
    .from(connectorCatalogs)
    .leftJoin(
      connectorCatalogSurfaces,
      eq(connectorCatalogSurfaces.catalogId, connectorCatalogs.id),
    )
    .where(inArray(connectorCatalogs.connectorProductId, [...connectorProductIds]))
    .groupBy(connectorCatalogs.connectorProductId);
  for (const r of rows) out.set(r.connectorProductId, r.asOf ?? null);
  return out;
}

export function createListVendorProductConnectorsHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const productId = productIdParam(c);
    const { db } = dbFor(c.env);

    await requireOwnedProduct(db, vendorId, productId);

    const [row, reach] = await Promise.all([
      db.query.products.findFirst({ ...productDetailConfig, where: eq(products.id, productId) }),
      reachablePartnersByConnector(db, productId),
    ]);
    // Deleted between the ownership read and this one.
    if (!row) throw notFoundError('product', { id: productId });

    const detail = toProductDetail(row, []);
    const delivered = [...detail.integrations_as_source, ...detail.integrations_as_target].filter(
      (item) => item.via !== null,
    );
    const deliveredPartners = deliveredPartnerIdsOf(
      detail.integrations_as_source,
      detail.integrations_as_target,
    );
    const reachOnly = reach.filter((r) => !deliveredPartners.has(r.partnerProductId));

    const connectorIds = new Set<string>();
    for (const item of delivered) if (item.via) connectorIds.add(item.via.id);
    for (const r of reachOnly) connectorIds.add(r.connectorProductId);

    const [links, asOf] = await Promise.all([
      productLinksById(db, [
        ...new Set([...connectorIds, ...reachOnly.map((r) => r.partnerProductId)]),
      ]),
      catalogAsOfByConnector(db, [...connectorIds]),
    ]);

    const partnerOf = (item: (typeof delivered)[number]) =>
      item.source.id === productId ? item.target : item.source;

    const connectors: VendorProductConnectorsResponse['connectors'] = [];
    for (const id of connectorIds) {
      const connector = links.get(id) ?? delivered.find((item) => item.via?.id === id)?.via ?? null;
      // A connector product deleted mid-read; its rows cascade with it.
      if (!connector) continue;
      const reachable: ProductLink[] = [];
      for (const r of reachOnly) {
        if (r.connectorProductId !== id) continue;
        const partner = links.get(r.partnerProductId);
        if (partner) reachable.push(partner);
      }
      connectors.push({
        connector,
        catalog_as_of: asOf.get(id) ?? null,
        delivered: delivered
          .filter((item) => item.via?.id === id)
          .sort((a, b) => compareText(partnerOf(a).name, partnerOf(b).name)),
        reachable: reachable.sort((a, b) => compareText(a.name, b.name)),
      });
    }
    // Delivered-heavy connectors first, then by size, then by name. Ranking
    // reads nothing paid (the no-pay-for-placement rule).
    connectors.sort(
      (a, b) =>
        b.delivered.length - a.delivered.length ||
        b.reachable.length - a.reachable.length ||
        compareText(a.connector.name, b.connector.name),
    );

    const body: VendorProductConnectorsResponse = { product_id: productId, connectors };
    validateResponseInDev(c.env, () => VendorProductConnectorsResponseSchema.parse(body));
    return json(body);
  };
}
