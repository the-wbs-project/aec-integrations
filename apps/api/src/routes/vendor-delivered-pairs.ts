/**
 * `GET /api/vendor/products/:id/delivered-pairs` (AECI-2045,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §6.13a).
 *
 * On a Sync Service product, the live pairs recorded as delivered through it whose
 * owner is NOT the caller: unowned, or owned by another company. The portal lists
 * them read-only with one action, an `owner` contest naming the caller (§11b.2,
 * the connector-holder authority). The rows the caller owns are on `owned[]` of
 * `GET /api/vendor/integrations` already, so they are not repeated here.
 *
 * Any other product answers `{ pairs: [] }`: an Integration platform's rows are
 * curated by AEC Integrations and it may not ask to own them.
 *
 * `requireVendor()` at the route, then ownership of the product (404 otherwise).
 * A pure read: no rate limit, no audit row. Outside the AECI-516 cursor, like the
 * Connectors section (§6.13): the portal re-reads it after its own contest submit.
 */

import {
  ListVendorDeliveredPairsResponseSchema,
  isSyncService,
  type ListVendorDeliveredPairsResponse,
} from '@aeci/shared';
import { and, eq, inArray, or } from 'drizzle-orm';

import { getDb } from '../db/client';
import { integrationFieldChallenges } from '../db/schema';
import { ApiError } from '../errors';
import { json } from '../http';
import { linkOrStub, loadDeliveredPairs, vendorNamesById } from '../lib/delivered-pairs';
import { validateResponseInDev, type DbFactory } from '../lib/handler-utils';
import { requireOwnedProduct, sessionVendorId, type VendorContext } from './vendor-shared';

/** One connector's pairs are bounded by its own list; this is a safety cap. */
const MAX_PAIRS = 500;

export function createListVendorDeliveredPairsHandler(
  dbFor: DbFactory = getDb,
): (c: VendorContext) => Promise<Response> {
  return async (c) => {
    const vendorId = sessionVendorId(c);
    const productId = c.req.param('id');
    if (!productId) {
      throw new ApiError(400, 'VALIDATION_FAILED', 'Missing product id', { field: 'id' });
    }
    const { db } = dbFor(c.env);
    const { product } = await requireOwnedProduct(db, vendorId, productId);

    let body: ListVendorDeliveredPairsResponse = { pairs: [] };
    if (isSyncService(product.productRole, product.connectorKind)) {
      const { rows, links } = await loadDeliveredPairs(db, productId, MAX_PAIRS);
      const visible = rows.filter((r) => r.retiredAt === null && r.builtByVendorId !== vendorId);
      const pairIds = visible.filter((r) => r.anchor === 'evidenced_pair').map((r) => r.id);
      const rowIds = visible.filter((r) => r.anchor === 'integration').map((r) => r.id);
      const [names, open] = await Promise.all([
        vendorNamesById(
          db,
          visible.map((r) => r.builtByVendorId),
        ),
        visible.length === 0
          ? Promise.resolve([])
          : db
              .select({
                id: integrationFieldChallenges.id,
                integrationId: integrationFieldChallenges.integrationId,
                evidencedPairId: integrationFieldChallenges.evidencedPairId,
              })
              .from(integrationFieldChallenges)
              .where(
                and(
                  eq(integrationFieldChallenges.submitterVendorId, vendorId),
                  eq(integrationFieldChallenges.field, 'owner'),
                  eq(integrationFieldChallenges.status, 'open'),
                  or(
                    pairIds.length
                      ? inArray(integrationFieldChallenges.evidencedPairId, pairIds)
                      : undefined,
                    rowIds.length
                      ? inArray(integrationFieldChallenges.integrationId, rowIds)
                      : undefined,
                  ),
                ),
              ),
      ]);
      const openByAnchor = new Map<string, string>();
      for (const row of open) {
        const key = row.evidencedPairId
          ? `evidenced_pair:${row.evidencedPairId}`
          : `integration:${row.integrationId}`;
        openByAnchor.set(key, row.id);
      }
      body = {
        pairs: visible.map((r) => ({
          id: r.id,
          anchor: r.anchor,
          name: r.name,
          product_a: linkOrStub(links, r.productAId),
          product_b: linkOrStub(links, r.productBId),
          owner: r.builtByVendorId
            ? { id: r.builtByVendorId, name: names.get(r.builtByVendorId) ?? r.builtByVendorId }
            : null,
          claimed: r.builtByVendorId !== null && r.claimedAt !== null,
          open_request_id: openByAnchor.get(`${r.anchor}:${r.id}`) ?? null,
        })),
      };
    }
    validateResponseInDev(c.env, () => ListVendorDeliveredPairsResponseSchema.parse(body));
    return json(body);
  };
}
