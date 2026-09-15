/**
 * Where a pair page's content went, for the 301 the pair resolver emits
 * (AECI-953 / `STAGE_1_5_SPEC.md` §7.2).
 *
 * The pair page is keyed by two product slugs, not by an edge id. So a promote that
 * re-points an endpoint moves the page's URL while the edge keeps its id and updates
 * in place — AECI-726 did that to 37 live Procore edges on 2026-09-14 and AECI-950 to
 * 15 more. The old URL then serves 200 + `noindex` with no redirect, which is a silent
 * equity loss: the indexed page decays over weeks and the new one starts from nothing.
 *
 * `integration_endpoint_moves` records the pair an edge moved AWAY from. This module
 * is the read.
 *
 * ── THE DESTINATION IS NEVER STORED ────────────────────────────────────────────
 *
 * The table has no `moved_to`. Each candidate edge's CURRENT location is read here,
 * live, which removes three problems instead of handling them:
 *
 *   - **Chains resolve for free.** A → B → C leaves two rows; the live read on either
 *     one lands on C.
 *   - **A deleted edge cannot 301.** No live row, no destination, and the page falls
 *     back to the ordinary empty pair — which is what a retraction should look like.
 *   - **The target always has the edge.** We never redirect to a second dead page,
 *     because the row we read IS the edge we are redirecting to.
 *
 * ── THIS ONLY RUNS ON AN EMPTY PAIR ───────────────────────────────────────────
 *
 * The caller consults it only when both anchor tables returned nothing for the pair.
 * That is also what makes the Smartsheet case right: AECI-726 moved one of Smartsheet's
 * two Procore Project Management edges and left the other, so the old URL still has
 * content, is not empty, and must not redirect. A move row exists for it and stays
 * inert.
 */

import { and, desc, eq, inArray, or } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  connectorEvidencedPairs,
  integrationEndpointMoves,
  integrations,
  products,
} from '../db/schema';

/** The pair URL to 301 to, already oriented for the requesting URL. */
export interface MovedPairTarget {
  context_slug: string;
  other_slug: string;
}

/**
 * How many move rows one empty pair will chase. A pair that accumulates more than a
 * handful is a curation problem, not a redirect problem, and an unbounded `IN` here
 * would let one bad pair fan out a read on every 404-shaped request.
 */
const MAX_CANDIDATES = 8;

/**
 * Resolve the pair page that now holds the content of `(contextProduct, otherProduct)`,
 * or `null` when there is nothing to redirect to.
 *
 * Orientation is preserved rather than canonicalised. A reader who asked for
 * `/products/procore-project-management/integrations/okta` gets
 * `/products/procore/integrations/okta`, keeping Okta in the frame they chose, because
 * the canonical form is a `<link rel=canonical>` concern and a redirect that also
 * flipped the frame would look like two changes.
 */
export async function resolveMovedPair(
  db: Db,
  contextProduct: { id: string; slug: string },
  otherProduct: { id: string; slug: string },
): Promise<MovedPairTarget | null> {
  const [fromA, fromB] = [contextProduct.id, otherProduct.id].sort();

  const moves = await db.query.integrationEndpointMoves.findMany({
    columns: { integrationId: true },
    where: and(
      eq(integrationEndpointMoves.fromProductAId, fromA),
      eq(integrationEndpointMoves.fromProductBId, fromB),
    ),
    // Newest first: if two edges left this pair for different destinations, the most
    // recent departure is the better guess at where a reader wanted to end up.
    orderBy: [desc(integrationEndpointMoves.movedAt), integrationEndpointMoves.integrationId],
    limit: MAX_CANDIDATES,
  });
  if (!moves.length) return null;

  const edgeIds = moves.map((m) => m.integrationId);
  // Both anchor tables, because the delivered tier spans both (§13.1) and AECI-888
  // lets an edge cross between them while keeping its id. Two reads in one wave.
  const [liveIntegrations, livePairs] = await Promise.all([
    db.query.integrations.findMany({
      columns: { id: true, sourceProductId: true, targetProductId: true },
      where: inArray(integrations.id, edgeIds),
    }),
    db.query.connectorEvidencedPairs.findMany({
      columns: { id: true, productAId: true, productBId: true },
      where: inArray(connectorEvidencedPairs.id, edgeIds),
    }),
  ]);

  const locationById = new Map<string, readonly [string, string]>();
  for (const row of liveIntegrations) {
    locationById.set(row.id, [row.sourceProductId, row.targetProductId]);
  }
  for (const row of livePairs) locationById.set(row.id, [row.productAId, row.productBId]);

  // Preserve the newest-first order of `moves`, which the two id-keyed reads lost.
  let destination: readonly [string, string] | null = null;
  for (const move of moves) {
    const live = locationById.get(move.integrationId);
    if (!live) continue;
    const [liveA, liveB] = [...live].sort();
    // A move row whose edge came BACK is not a destination — it would 301 this page
    // to itself. (The caller only reaches here on an empty pair, so this should not
    // happen; it is cheap to be certain rather than to serve a redirect loop.)
    if (liveA === fromA && liveB === fromB) continue;
    destination = live;
    break;
  }
  if (!destination) return null;

  const slugs = await db.query.products.findMany({
    columns: { id: true, slug: true },
    where: or(eq(products.id, destination[0]), eq(products.id, destination[1])),
  });
  const slugById = new Map(slugs.map((p) => [p.id, p.slug]));
  const a = slugById.get(destination[0]);
  const b = slugById.get(destination[1]);
  if (!a || !b) return null;

  // Keep whichever endpoint survived in the reader's own frame.
  if (b === otherProduct.slug) return { context_slug: a, other_slug: b };
  if (a === otherProduct.slug) return { context_slug: b, other_slug: a };
  // The OTHER endpoint moved and the context one survived.
  if (a === contextProduct.slug) return { context_slug: a, other_slug: b };
  if (b === contextProduct.slug) return { context_slug: b, other_slug: a };
  // Both endpoints moved — no frame to preserve, so fall back to the canonical
  // alphabetical context the pair page, canonical and sitemap all already use (§7.1).
  return a <= b ? { context_slug: a, other_slug: b } : { context_slug: b, other_slug: a };
}
