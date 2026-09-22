/**
 * Where a pair page's content went, for the 301 the pair resolver emits
 * (AECI-953 / `STAGE_1_5_SPEC.md` §7.2a).
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
 * ── THE LOOKUP KEY IS TWO SLUGS (AECI-991) ────────────────────────────────────
 *
 * It used to be two product **ids**, which made this function unreachable in the one
 * case it was written for. The caller has a URL, so an id-keyed lookup has to resolve
 * both slugs to product rows first — and a merge-then-retire deletes one of those
 * rows. No row, no id, no lookup, and the stored rows had cascaded away besides. The
 * table is now keyed on the slugs themselves, so this read needs nothing but the URL
 * and answers just as well for an endpoint that no longer exists.
 *
 * What it still does NOT answer is "that product's slug retired". That is
 * `slug_redirects` and the pair route's path-prefix rewrite (AECI-991,
 * `STAGE_3_SPEC.md` §2.6 option B), which runs on the pair route's not-found branch.
 * The two are different questions and are deliberately kept apart: this one is true
 * whatever happens to the products.
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

import { and, desc, eq, inArray } from 'drizzle-orm';

import type { Db } from '../db/client';
import {
  connectorEvidencedPairs,
  integrationEndpointMoves,
  integrations,
  products,
} from '../db/schema';
import { liveIntegrationWhere } from './live-integration';

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
 * The two slugs of a pair in the canonical order the table stores.
 *
 * A plain `.sort()` rather than `compareText` (AECI-825) on purpose: this is an
 * identity key compared against a SQLite column whose collation is `BINARY`, so the
 * two orderings have to agree bit for bit. `compareText` would case-fold and could
 * disagree with the CHECK. Slugs are lowercase ASCII, so nothing is at stake beyond
 * keeping the two sides identical.
 */
function canonicalPairSlugs(a: string, b: string): readonly [string, string] {
  return a < b ? [a, b] : [b, a];
}

/**
 * Resolve the pair page that now holds the content of `(contextSlug, otherSlug)`,
 * or `null` when there is nothing to redirect to.
 *
 * Takes slugs, not product rows: the answer must survive either endpoint being
 * retracted (AECI-991), and the slugs are what the URL — and now the table — is
 * keyed on.
 *
 * Orientation is preserved rather than canonicalised. A reader who asked for
 * `/products/procore-project-management/integrations/okta` gets
 * `/products/procore/integrations/okta`, keeping Okta in the frame they chose, because
 * the canonical form is a `<link rel=canonical>` concern and a redirect that also
 * flipped the frame would look like two changes.
 */
export async function resolveMovedPair(
  db: Db,
  contextSlug: string,
  otherSlug: string,
): Promise<MovedPairTarget | null> {
  const [fromA, fromB] = canonicalPairSlugs(contextSlug, otherSlug);

  const moves = await db.query.integrationEndpointMoves.findMany({
    columns: { integrationId: true },
    where: and(
      eq(integrationEndpointMoves.fromProductASlug, fromA),
      eq(integrationEndpointMoves.fromProductBSlug, fromB),
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
      // Live rows only (AECI-1010): never 301 a reader onto a page whose only
      // edge is retired.
      where: and(inArray(integrations.id, edgeIds), liveIntegrationWhere),
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
  if (!locationById.size) return null;

  // One read for every candidate destination's slugs, in the order `moves` gave —
  // which the two id-keyed reads above lost. The location is a pair of product IDS
  // (the anchor tables key on ids and always will, because an edge's endpoints are
  // live rows); only the MOVE record is slug-keyed.
  const destinationIds = new Set<string>();
  for (const move of moves) {
    const live = locationById.get(move.integrationId);
    if (live) for (const id of live) destinationIds.add(id);
  }
  const slugRows = await db.query.products.findMany({
    columns: { id: true, slug: true },
    where: inArray(products.id, [...destinationIds]),
  });
  const slugById = new Map(slugRows.map((p) => [p.id, p.slug]));

  let destination: readonly [string, string] | null = null;
  for (const move of moves) {
    const live = locationById.get(move.integrationId);
    if (!live) continue;
    const a = slugById.get(live[0]);
    const b = slugById.get(live[1]);
    // An endpoint with no product row cannot name a URL. Skip rather than guess.
    if (!a || !b) continue;
    const [liveA, liveB] = canonicalPairSlugs(a, b);
    // A move row whose edge came BACK is not a destination — it would 301 this page
    // to itself. (The caller only reaches here on an empty pair, so this should not
    // happen; it is cheap to be certain rather than to serve a redirect loop.)
    if (liveA === fromA && liveB === fromB) continue;
    destination = [a, b];
    break;
  }
  if (!destination) return null;

  const [a, b] = destination;
  // Keep whichever endpoint survived in the reader's own frame.
  if (b === otherSlug) return { context_slug: a, other_slug: b };
  if (a === otherSlug) return { context_slug: b, other_slug: a };
  // The OTHER endpoint moved and the context one survived.
  if (a === contextSlug) return { context_slug: a, other_slug: b };
  if (b === contextSlug) return { context_slug: b, other_slug: a };
  // Both endpoints moved — no frame to preserve, so fall back to the canonical
  // alphabetical context the pair page, canonical and sitemap all already use (§7.1).
  return a <= b ? { context_slug: a, other_slug: b } : { context_slug: b, other_slug: a };
}
