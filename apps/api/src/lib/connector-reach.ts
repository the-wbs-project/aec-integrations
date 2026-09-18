/**
 * The REACHABLE tier's one public read (AECI-892 — `STAGE_1_5_SPEC.md` §13.7).
 *
 * Reachable is not a table (§13.1). It is derived at read time from the mapping
 * graph, gated for publication by `connector_pairs.surface`, and it **never
 * counts** — not in the `Integrations (N)` heading, not in `integration_count`,
 * not in a facet, not in the home stats (§13.5). It has two readers: one
 * unattributed sentence on the public endpoint product page
 * ({@link reachablePartnerProductIds}), and the private, read-only Connectors
 * section in the vendor portal ({@link reachablePartnersByConnector}, AECI-1013).
 * Neither one counts.
 *
 * ── WHY THIS EXISTS AT ALL ──────────────────────────────────────────────────
 * AECI-889 retires `integrations` rows that are also a reachable pair in the
 * same connector's catalogue. AECI-892 was filed as a fix to AECI-713's lane
 * split key, and that is not buildable: `routeIntegrationLane` reads `via` (from
 * `connector_evidenced_pairs`) and `powered_by_product` (from `integrations`),
 * both of which are delivered-tier, so once the row is gone neither relation
 * returns it and no predicate recovers it. The fact has to be re-derived from a
 * different source, which is this one. `connector-lane-grouping.ts` is untouched
 * by that work, deliberately.
 *
 * ── TWO UNION BRANCHES, NEVER AN `OR` ───────────────────────────────────────
 * `connector_pairs` stores a canonical pair (`stub_a_id < stub_b_id`), so "which
 * pairs involve stub X" has to look at both columns. Expressed as
 * `stub_a_id = ? OR stub_b_id = ?` SQLite uses NEITHER index and scans the
 * table. Split into two branches it uses `connector_pairs_pair_idx`
 * (`catalog_id, stub_a_id`) on one and `connector_pairs_stub_b_idx` on the
 * other.
 *
 * Two arms is well inside D1's `SQLITE_MAX_COMPOUND_SELECT` of **5** — not
 * better-sqlite3's 500, which is the trap that 500'd `/admin/system` after every
 * unit test passed (`TESTING_STRATEGY.md` §6.3). Adding a third catalogue-shaped
 * arm here would be four away from that ceiling, so count the arms before adding
 * one.
 *
 * ── NO `surface` PREDICATE, AND THAT IS THE RULE ────────────────────────────
 * §13.7 splits this in two and both halves fail silently. The **count** carries
 * no `surface` filter: all 669 of Kroo Connector's and Trimble AppXchange's
 * pairs are `derived`, so a `curated` filter leaking in here reports both
 * catalogues as reaching nothing. **Publication** always filters to `curated`,
 * because a `derived` pair has no vendor page to cite. This module is the count.
 */

import { and, eq, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { alias, union } from 'drizzle-orm/sqlite-core';

import type { Db } from '../db/client';
import { connectorCatalogs, connectorPairs, connectorStubMappings } from '../db/schema';

import { publishableMappingOn } from './admin-connectors';

/**
 * The distinct products reachable from `productId` through some connector's
 * catalogue, regardless of whether an integration between them is delivered.
 *
 * Returns **product ids, not a count**, and the caller subtracts the delivered
 * partners. See {@link reachOnlyPartnerCount} for why that subtraction does not
 * live in this query.
 *
 * Every row satisfying all of:
 *
 * - the page product has a **publishable** mapping to one stub of the pair;
 * - the partner product has a **publishable** mapping to the other stub;
 * - both mappings sit in the pair's own catalogue;
 * - the pair is not tombstoned (`removed_at IS NULL` — there is no
 *   `rejected_at` column on this side, only upstream);
 * - the partner is neither the page product nor the catalogue's own connector
 *   product. That last clause is the reach analogue of `routeIntegrationLane`'s
 *   Convention-A carve-out, and without it a product that ships a connector on
 *   platform C reads as "reachable via C, partner C".
 *
 * `union` rather than `unionAll` so the de-duplication happens in SQLite: one
 * product can map to two stubs in a catalogue via editions, and it is one
 * reachable partner either way.
 */
export async function reachablePartnerProductIds(db: Db, productId: string): Promise<string[]> {
  const branch = (entrySide: 'a' | 'b') => {
    // Distinct aliases per branch: the same table appears twice in each arm, and
    // the two arms are separate statements, so the names may repeat across them.
    const entry = alias(connectorStubMappings, `entry_${entrySide}`);
    const partner = alias(connectorStubMappings, `partner_${entrySide}`);
    const entryStub = entrySide === 'a' ? connectorPairs.stubAId : connectorPairs.stubBId;
    const partnerStub = entrySide === 'a' ? connectorPairs.stubBId : connectorPairs.stubAId;

    return (
      db
        // Selected through `sql<>` rather than as the bare column so both arms
        // declare the SAME result type. Drizzle bakes the table name into a
        // column's type, the two arms alias the table differently, and the union of
        // two differently-named columns resolves to `never`.
        .select({ productId: sql<string | null>`${partner.productId}`.as('product_id') })
        .from(connectorPairs)
        .innerJoin(
          entry,
          and(eq(entry.stubId, entryStub), eq(entry.catalogId, connectorPairs.catalogId)),
        )
        .innerJoin(
          partner,
          and(eq(partner.stubId, partnerStub), eq(partner.catalogId, connectorPairs.catalogId)),
        )
        .innerJoin(connectorCatalogs, eq(connectorCatalogs.id, connectorPairs.catalogId))
        .where(
          and(
            isNull(connectorPairs.removedAt),
            eq(entry.productId, productId),
            publishableMappingOn(entry),
            publishableMappingOn(partner),
            isNotNull(partner.productId),
            ne(partner.productId, productId),
            ne(partner.productId, connectorCatalogs.connectorProductId),
          ),
        )
    );
  };

  const rows = await union(branch('a'), branch('b'));
  // `product_id` is nullable in the column type and non-null by predicate. The
  // narrowing is the type system catching up, not a defensive filter.
  return rows.map((r) => r.productId).filter((id): id is string => id !== null);
}

/** One reachable (connector, partner) edge — see {@link reachablePartnersByConnector}. */
export interface ReachByConnector {
  connectorProductId: string;
  partnerProductId: string;
}

/**
 * The same reach as {@link reachablePartnerProductIds}, kept **per connector**
 * (AECI-1013 — the vendor portal's read-only Connectors section).
 *
 * Every predicate is the public count's, clause for clause: both branches, both
 * `publishableMappingOn` ends, the tombstone, the self and connector-product
 * exclusions, and **no `surface` predicate**. The only difference is the grain.
 * The public count de-duplicates by partner, because its question is "how many
 * more partners"; this read de-duplicates by `(connector, partner)`, because its
 * question is "which connector reaches which partner". A partner reachable through
 * two connectors is one row there and two rows here, which is why this is a
 * second function rather than a flag on the first.
 *
 * Still two arms, so still three away from D1's compound-SELECT ceiling of 5.
 * The caller subtracts delivered partners exactly as the public page does
 * ({@link reachOnlyPartnerCount}'s contract): off the product-detail arrays,
 * never off a hand-written `NOT EXISTS`.
 */
export async function reachablePartnersByConnector(
  db: Db,
  productId: string,
): Promise<ReachByConnector[]> {
  const branch = (entrySide: 'a' | 'b') => {
    const entry = alias(connectorStubMappings, `entry_${entrySide}`);
    const partner = alias(connectorStubMappings, `partner_${entrySide}`);
    const entryStub = entrySide === 'a' ? connectorPairs.stubAId : connectorPairs.stubBId;
    const partnerStub = entrySide === 'a' ? connectorPairs.stubBId : connectorPairs.stubAId;

    return db
      .select({
        // `sql<>` on both columns for the reason given in the function above: the
        // two arms alias the table differently, and bare columns would type the
        // union as `never`.
        connectorProductId: sql<string>`${connectorCatalogs.connectorProductId}`.as(
          'connector_product_id',
        ),
        partnerProductId: sql<string | null>`${partner.productId}`.as('partner_product_id'),
      })
      .from(connectorPairs)
      .innerJoin(
        entry,
        and(eq(entry.stubId, entryStub), eq(entry.catalogId, connectorPairs.catalogId)),
      )
      .innerJoin(
        partner,
        and(eq(partner.stubId, partnerStub), eq(partner.catalogId, connectorPairs.catalogId)),
      )
      .innerJoin(connectorCatalogs, eq(connectorCatalogs.id, connectorPairs.catalogId))
      .where(
        and(
          isNull(connectorPairs.removedAt),
          eq(entry.productId, productId),
          publishableMappingOn(entry),
          publishableMappingOn(partner),
          isNotNull(partner.productId),
          ne(partner.productId, productId),
          ne(partner.productId, connectorCatalogs.connectorProductId),
        ),
      );
  };

  const rows = await union(branch('a'), branch('b'));
  const out: ReachByConnector[] = [];
  for (const r of rows) {
    if (r.partnerProductId === null) continue;
    out.push({ connectorProductId: r.connectorProductId, partnerProductId: r.partnerProductId });
  }
  return out;
}

/**
 * How many reachable partners are **not already delivered**, which is the N in
 * §13.7's *"N more pairs reachable via connectors"*.
 *
 * `deliveredPartnerIds` must span **both** delivered tables in **both**
 * orientations. Getting either half wrong over-counts, renders a partner the
 * reader can already see in the table above, and reports nothing — the same
 * silent shape as AECI-882's single-table retraction consumer and AECI-795's
 * orientation-blind prune guard.
 *
 * The caller therefore derives that set from `integrations_as_source` +
 * `integrations_as_target`, which already union `integrations` with
 * `connector_evidenced_pairs` and are already oriented per endpoint
 * (`evidencedPairsForEndpoint`). A two-table, two-orientation `NOT EXISTS` in
 * the query above would satisfy the same rule while being a fourth independent
 * copy of it, and copies of this rule are exactly what has gone wrong twice.
 */
export function reachOnlyPartnerCount(
  reachablePartnerIds: readonly string[],
  deliveredPartnerIds: ReadonlySet<string>,
): number {
  let n = 0;
  for (const id of reachablePartnerIds) {
    if (!deliveredPartnerIds.has(id)) n += 1;
  }
  return n;
}
