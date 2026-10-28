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
 * ── THE ANSWER IS ONLY USED ON AN EMPTY PAIR ─────────────────────────────────
 *
 * Since AECI-1506 the read itself runs on every pair request, as one statement in
 * the pair handler's single `db.batch` — one indexed lookup is cheaper than the
 * extra round trip it would take to ask only after the pair came back empty. The
 * caller applies the answer only when both anchor tables returned nothing. That is
 * also what makes the Smartsheet case right: AECI-726 moved one of Smartsheet's
 * two Procore Project Management edges and left the other, so the old URL still has
 * content, is not empty, and must not redirect. A move row exists for it and stays
 * inert.
 */

import { and, desc, eq, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';

import type { Db } from '../db/client';
import {
  connectorEvidencedPairs,
  integrationEndpointMoves,
  integrations,
  products,
} from '../db/schema';
import { liveEvidencedPairOn, liveIntegrationOn } from './live-integration';

/** The pair URL to 301 to, already oriented for the requesting URL. */
export interface MovedPairTarget {
  context_slug: string;
  other_slug: string;
}

/** One move record with the CURRENT slugs of its edge's live endpoints. Both slugs
 *  are `null` when the edge is in neither anchor table (deleted or retired), and one
 *  is `null` when that endpoint has no product row left. */
export interface MovedPairCandidate {
  integrationId: string;
  aSlug: string | null;
  bSlug: string | null;
}

/**
 * How many move rows one empty pair will chase. A pair that accumulates more than a
 * handful is a curation problem, not a redirect problem, and an unbounded join here
 * would let one bad pair fan out a read on every pair request.
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
 * The moved-pair read as ONE unexecuted statement, so the pair handler can put it in
 * the same `db.batch` as the pair reads (AECI-1506). It used to be three serial
 * reads: the move rows, then the live edges, then the destination slugs.
 *
 * Both anchor tables are joined, because the delivered tier spans both (§13.1) and
 * AECI-888 lets an edge cross between them while keeping its id. Live rows only
 * (AECI-1010 / AECI-1091): never 301 a reader onto a page whose only edge is
 * retired. When an id somehow resolves in both tables the evidenced row wins, and
 * both endpoint ids always come from the same row.
 */
export function movedPairCandidatesQuery(db: Db, contextSlug: string, otherSlug: string) {
  const [fromA, fromB] = canonicalPairSlugs(contextSlug, otherSlug);

  const moves = db
    .select({
      integrationId: integrationEndpointMoves.integrationId,
      movedAt: integrationEndpointMoves.movedAt,
    })
    .from(integrationEndpointMoves)
    .where(
      and(
        eq(integrationEndpointMoves.fromProductASlug, fromA),
        eq(integrationEndpointMoves.fromProductBSlug, fromB),
      ),
    )
    // Newest first: if two edges left this pair for different destinations, the most
    // recent departure is the better guess at where a reader wanted to end up.
    .orderBy(desc(integrationEndpointMoves.movedAt), integrationEndpointMoves.integrationId)
    .limit(MAX_CANDIDATES)
    .as('moves');

  const productA = alias(products, 'moved_product_a');
  const productB = alias(products, 'moved_product_b');
  const liveA = sql`CASE WHEN ${connectorEvidencedPairs.id} IS NOT NULL THEN ${connectorEvidencedPairs.productAId} ELSE ${integrations.sourceProductId} END`;
  const liveB = sql`CASE WHEN ${connectorEvidencedPairs.id} IS NOT NULL THEN ${connectorEvidencedPairs.productBId} ELSE ${integrations.targetProductId} END`;

  return (
    db
      // Every output column needs a distinct NAME, not just a distinct key: in a D1
      // batch drizzle rebuilds each row from the column names, so two bare `slug`
      // columns collapse into one and every field after it shifts.
      .select({
        integrationId: moves.integrationId,
        aSlug: sql<string | null>`${productA.slug}`.as('a_slug'),
        bSlug: sql<string | null>`${productB.slug}`.as('b_slug'),
      })
      .from(moves)
      .leftJoin(
        integrations,
        and(eq(integrations.id, moves.integrationId), liveIntegrationOn(integrations)),
      )
      .leftJoin(
        connectorEvidencedPairs,
        and(
          eq(connectorEvidencedPairs.id, moves.integrationId),
          liveEvidencedPairOn(connectorEvidencedPairs),
        ),
      )
      .leftJoin(productA, eq(productA.id, liveA))
      .leftJoin(productB, eq(productB.id, liveB))
      // Again on the outer query: SQLite does not promise a subquery's order survives.
      .orderBy(desc(moves.movedAt), moves.integrationId)
  );
}

/**
 * Pick the pair page that now holds the content of `(contextSlug, otherSlug)` from
 * the rows {@link movedPairCandidatesQuery} returned, or `null` when there is nothing
 * to redirect to.
 *
 * Orientation is preserved rather than canonicalised. A reader who asked for
 * `/products/procore-project-management/integrations/okta` gets
 * `/products/procore/integrations/okta`, keeping Okta in the frame they chose, because
 * the canonical form is a `<link rel=canonical>` concern and a redirect that also
 * flipped the frame would look like two changes.
 */
export function pickMovedPair(
  candidates: readonly MovedPairCandidate[],
  contextSlug: string,
  otherSlug: string,
): MovedPairTarget | null {
  const [fromA, fromB] = canonicalPairSlugs(contextSlug, otherSlug);

  let destination: readonly [string, string] | null = null;
  for (const { aSlug: a, bSlug: b } of candidates) {
    // No live edge, or an endpoint with no product row: it cannot name a URL. Skip
    // rather than guess.
    if (!a || !b) continue;
    const [liveA, liveB] = canonicalPairSlugs(a, b);
    // A move row whose edge came BACK is not a destination — it would 301 this page
    // to itself. (The caller only applies this on an empty pair, so this should not
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

/**
 * {@link movedPairCandidatesQuery} run on its own, then {@link pickMovedPair}. One
 * round trip. The pair handler batches the query instead.
 *
 * Takes slugs, not product rows: the answer must survive either endpoint being
 * retracted (AECI-991), and the slugs are what the URL — and now the table — is
 * keyed on.
 */
export async function resolveMovedPair(
  db: Db,
  contextSlug: string,
  otherSlug: string,
): Promise<MovedPairTarget | null> {
  return pickMovedPair(
    await movedPairCandidatesQuery(db, contextSlug, otherSlug),
    contextSlug,
    otherSlug,
  );
}
