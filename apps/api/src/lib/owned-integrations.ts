/**
 * The owned-rows read (AECI-1089 / AECI-1040 / `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5 /
 * `STAGE_2_REALTIME_SPEC.md` §2.2).
 *
 * `GET /api/vendor/integrations` was scoped by `ownedEndpointJoin` alone, so a vendor
 * saw only rows whose endpoint products it holds. The AECI-1040 carve-out lets an
 * owner claim (and later edit and retire) its connector-powered rows, and 35 of those
 * rows in production belong to a third party that holds neither endpoint. Every one of
 * them is a `connector_evidenced_pairs` row, which the list never read. So the list
 * now also returns the rows the caller OWNS (`built_by_vendor_id`), from both tables.
 *
 * **The predicates here are the authorization, and the freshness cursor imports them.**
 * Behind `/api/vendor/*` there is no RLS, so a `WHERE` clause is the whole scoping
 * rule. `routes/vendor-updates.ts` reads its owned-rows statement through the same two
 * functions, so the §2.2 invariant ("every cursor query reuses the scoping predicate of
 * the handler it is a cursor for") is enforced by the module graph, not by review.
 *
 * The cursor statement covers every owned row, including owned `integrations` rows on
 * which the caller also holds an endpoint and which the attestable surface already
 * lists. That is wider than the `owned` array but never wider than what the caller may
 * read: every row it counts is the caller's own, and each one appears somewhere in the
 * same response. So the cursor cannot leak another vendor's row.
 */

import {
  INTEGRATION_CONTEST_FIELDS,
  effectiveRetiredBy,
  type ContestableFields,
  type OwnedIntegration,
} from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';
import { eq } from 'drizzle-orm';

import type { Db } from '../db/client';
import { connectorEvidencedPairs, integrations } from '../db/schema';
import { isConnectorPoweredEdge } from './connector-powered';
import { storedFieldValue, toWireValue } from './integration-contests';
import { productLinkColumns, toMechanismKind, toProductLink } from './drizzle-helpers';

/** The owned-rows predicate on `integrations`. */
export function ownedIntegrationsWhere(vendorId: string) {
  return eq(integrations.builtByVendorId, vendorId);
}

/** The owned-rows predicate on `connector_evidenced_pairs`. */
export function ownedEvidencedPairsWhere(vendorId: string) {
  return eq(connectorEvidencedPairs.builtByVendorId, vendorId);
}

/**
 * Every row the caller owns that the attestable surface does not already list, in
 * `OwnedIntegration` wire form. `listedIntegrationIds` is the set of `integrations` ids
 * the endpoint-scoped surface returned: an owned row on which the caller holds an
 * endpoint is already there, with its claims and slots, and must not be listed twice.
 *
 * Retired rows are listed, not filtered: the owner needs a retired row to restore it
 * (AECI-1010, and AECI-1091 on the evidenced table), and the cursor must move on the
 * write that retires it.
 *
 * Two reads, each on an index (`integrations_built_by_idx`,
 * `connector_evidenced_pairs_built_by_idx`). They run in parallel. D1 binding calls
 * are not `fetch` subrequests, so the Worker connection limit does not apply.
 */
export async function loadOwnedIntegrations(
  db: Db,
  vendorId: string,
  listedIntegrationIds: ReadonlySet<string>,
): Promise<OwnedIntegration[]> {
  const [rows, pairs] = await Promise.all([
    db.query.integrations.findMany({
      columns: {
        id: true,
        name: true,
        mechanismKind: true,
        mechanismName: true,
        poweredByProductId: true,
        claimedAt: true,
        retiredAt: true,
        retiredBy: true,
        // AECI-1090: the edit form's starting values.
        builtByVendorId: true,
        direction: true,
        description: true,
        listingUrl: true,
        docsUrl: true,
        website: true,
        mechanismUrl: true,
        pricingModel: true,
        maturity: true,
      },
      with: {
        sourceProduct: { columns: productLinkColumns },
        targetProduct: { columns: productLinkColumns },
        poweredByProduct: { columns: productLinkColumns },
      },
      where: ownedIntegrationsWhere(vendorId),
    }),
    db.query.connectorEvidencedPairs.findMany({
      columns: {
        id: true,
        name: true,
        mechanismName: true,
        claimedAt: true,
        retiredAt: true,
        retiredBy: true,
        // AECI-1090: the edit form's starting values.
        builtByVendorId: true,
        direction: true,
        description: true,
        listingUrl: true,
        docsUrl: true,
        website: true,
        mechanismUrl: true,
        pricingModel: true,
        maturity: true,
      },
      with: {
        productA: { columns: productLinkColumns },
        productB: { columns: productLinkColumns },
        connectorProduct: { columns: productLinkColumns },
      },
      where: ownedEvidencedPairsWhere(vendorId),
    }),
  ]);

  const owned: OwnedIntegration[] = [];
  for (const row of rows) {
    if (listedIntegrationIds.has(row.id)) continue;
    owned.push({
      id: row.id,
      anchor: 'integration',
      name: row.name,
      mechanism_kind: toMechanismKind(row.mechanismKind, row.id),
      mechanism_name: row.mechanismName,
      product_a: toProductLink(row.sourceProduct),
      product_b: toProductLink(row.targetProduct),
      connector: row.poweredByProduct ? toProductLink(row.poweredByProduct) : null,
      connector_powered: isConnectorPoweredEdge(row),
      claimed_at: row.claimedAt,
      retired_at: row.retiredAt,
      retired_by: effectiveRetiredBy({ retired_at: row.retiredAt, retired_by: row.retiredBy }),
      contestable_fields: contestableFieldsOnA(row),
    });
  }
  for (const pair of pairs) {
    owned.push({
      id: pair.id,
      anchor: 'evidenced_pair',
      name: pair.name,
      mechanism_kind: null,
      mechanism_name: pair.mechanismName,
      product_a: toProductLink(pair.productA),
      product_b: toProductLink(pair.productB),
      connector: toProductLink(pair.connectorProduct),
      connector_powered: true,
      claimed_at: pair.claimedAt,
      retired_at: pair.retiredAt,
      retired_by: effectiveRetiredBy({ retired_at: pair.retiredAt, retired_by: pair.retiredBy }),
      // A pair has every standard column but `mechanism_kind`, and stores
      // `direction` against the canonical A, the same frame as `product_a` here.
      contestable_fields: contestableFieldsOnA({ ...pair, mechanismKind: null }),
    });
  }
  // Case never decides the order (`API_CONTRACTS.md` §3.2). The id is the final,
  // BINARY tiebreaker, so two rows with the same names still sort the same way.
  return owned.sort(
    (a, b) =>
      compareText(a.product_a.name, b.product_a.name) ||
      compareText(a.product_b.name, b.product_b.name) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

/**
 * The value on record of every contestable field, in wire form with `direction`
 * framed against `product_a` (AECI-1090). `product_a` is the row's source on
 * `integrations` and the canonical A on a pair, so "A is the context" is the one
 * frame both tables share. The portal's edit form sends `context_product_id =
 * product_a.id` to match.
 */
function contestableFieldsOnA(row: Parameters<typeof storedFieldValue>[0]): ContestableFields {
  return Object.fromEntries(
    INTEGRATION_CONTEST_FIELDS.map((field) => [
      field,
      toWireValue(field, storedFieldValue(row, field), true),
    ]),
  ) as ContestableFields;
}
