/**
 * How many rows a product page lists under its two integrations sections (AECI-1827).
 *
 * The product page's facts card prints the stored `integration_count`. That column is
 * recomputed after each write, so it can lag. A stored zero never wins over listed rows:
 * the card then prints the rows the page lists, "Integrations" plus "Integrations it
 * powers" (`apps/web/src/app/products/integrations-on-record.ts`). The empty pair page
 * prints the same figure for each product, but its payload carries no rows, so the API
 * counts them with this function and sends the number.
 *
 * The rules are the web's, kept here as one pure function over the smallest row shape:
 *
 *  - **Endpoint rows** (`splitIntegrationLanes`, `STAGE_1_5_SPEC.md` §13.2 and §13.3). An
 *    edge whose connector is one of its own endpoints, or with no connector and not an
 *    iPaaS kind, is a direct row, one per edge. Any other edge is a Via row, collapsed to
 *    one per (connector, partner). An iPaaS edge with no connector groups under the
 *    unnamed key.
 *  - **Powered rows** (`groupPoweredIntegrations`, §13.4(2)). One per distinct unordered
 *    endpoint pair, skipping an edge the product is itself an endpoint of, and a
 *    self-edge.
 *
 * Framework-agnostic and pure, so the API and the web specs share it.
 */

import { orderedPairSlugs } from './integration-context';

/** One edge on the product's own endpoint list. Slugs, never names. */
export interface ListedEndpointEdge {
  /** The endpoint that is not the product. */
  readonly partnerSlug: string;
  /** The two endpoints' slugs, to recognise a self-powered (Convention A) edge. */
  readonly sourceSlug: string;
  readonly targetSlug: string;
  /** `integrations.powered_by` or the evidenced pair's connector, or `null`. */
  readonly connectorSlug: string | null;
  /** `true` for a `connector_evidenced_pairs` row: connector-delivered by construction. */
  readonly evidenced: boolean;
  /** The stored mechanism kind, for the unnamed iPaaS bucket. */
  readonly mechanismKind: string | null;
}

/** One edge the product powers as the connector. */
export interface ListedPoweredEdge {
  readonly sourceSlug: string;
  readonly targetSlug: string;
}

/** The rows the product page lists for `selfSlug`. */
export function countListedIntegrationRows(
  selfSlug: string,
  endpoint: readonly ListedEndpointEdge[],
  powered: readonly ListedPoweredEdge[],
): number {
  let direct = 0;
  const via = new Set<string>();
  for (const edge of endpoint) {
    const connector = edge.connectorSlug;
    const selfPowered =
      !edge.evidenced &&
      connector !== null &&
      (connector === edge.sourceSlug || connector === edge.targetSlug);
    if (selfPowered) {
      direct += 1;
    } else if (connector !== null) {
      via.add(`${connector}::${edge.partnerSlug}`);
    } else if (edge.mechanismKind === 'iPaaS') {
      via.add(`::${edge.partnerSlug}`);
    } else {
      direct += 1;
    }
  }

  const pairs = new Set<string>();
  for (const edge of powered) {
    if (edge.sourceSlug === selfSlug || edge.targetSlug === selfSlug) continue;
    if (edge.sourceSlug === edge.targetSlug) continue;
    const [a, b] = orderedPairSlugs(edge.sourceSlug, edge.targetSlug);
    pairs.add(`${a}::${b}`);
  }

  return direct + via.size + pairs.size;
}
