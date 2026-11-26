/**
 * The "What it syncs" roll-up (AECI-2046, ruling 15 on AECI-2035,
 * `docs/STAGE_1_5_SPEC.md` §13.13): the record types a Sync Service moves across the
 * pairs it delivers, with direction, so a buyer sees at a glance what moves.
 *
 * Pure. `toProductDetail` hands it one entry per delivered row, from both delivered
 * tables, with the row's PUBLIC flows only: the owner's answers already joined and
 * `publicClaims` already applied (`STAGE_2_ATTESTATIONS_SPEC.md` §14.10), refuted
 * flows already dropped. So a flow the owner removed is not here, and the roll-up
 * cannot name it.
 *
 * The pair set is the one "Integrations it delivers" counts (`groupPoweredIntegrations`
 * on the web): a row whose endpoint is the Sync Service itself is left out (§13.4(2)),
 * and rows for the same two products collapse to one pair. A pair's flows are the
 * union of its rows' flows.
 *
 * Direction per pair and record type: both ways when a flow says `both`, or when the
 * two one-way flows are both there. Otherwise one way. Each row's flows are read in
 * that row's own A/B frame (`aId` → `bId`) and turned into the pair's frame (lower id
 * first) before they are merged, so two rows that store a pair in opposite frames
 * agree.
 *
 * Order: record types A to Z by name through `compareText`, the slug breaking a tie.
 * It reads no plan input: names are the controlled vocabulary's, the counts only
 * describe. Registered with the on-page ordering firewall as
 * `product-page-what-it-syncs`.
 */
import type { WhatItSyncs, WhatItSyncsObject } from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';

/** One public flow on a delivered row, in the row's own A/B frame. */
export interface WhatItSyncsFlow {
  readonly slug: string;
  readonly name: string;
  /** `a_to_b`, `b_to_a` or `both`. Any other value reads as one way. */
  readonly direction: string;
}

/** One delivered row of the Sync Service. */
export interface WhatItSyncsRow {
  /** The endpoint the row's flows call A. */
  readonly aId: string;
  /** The endpoint the row's flows call B. */
  readonly bId: string;
  readonly flows: readonly WhatItSyncsFlow[];
}

type PairDirections = Set<'a_to_b' | 'b_to_a' | 'both'>;

function flip(direction: string): 'a_to_b' | 'b_to_a' | 'both' {
  if (direction === 'both') return 'both';
  return direction === 'a_to_b' ? 'b_to_a' : 'a_to_b';
}

function canonical(direction: string): 'a_to_b' | 'b_to_a' | 'both' {
  if (direction === 'both' || direction === 'b_to_a') return direction;
  return 'a_to_b';
}

/** Both ways when a flow says so, or when the two one-way flows are both recorded. */
function isBothWays(directions: PairDirections): boolean {
  return directions.has('both') || (directions.has('a_to_b') && directions.has('b_to_a'));
}

export function rollUpWhatItSyncs(rows: readonly WhatItSyncsRow[], selfId: string): WhatItSyncs {
  // pair key → record slug → directions, plus each slug's vocabulary name.
  const pairs = new Map<string, Map<string, PairDirections>>();
  const names = new Map<string, string>();
  for (const row of rows) {
    if (row.aId === selfId || row.bId === selfId || row.aId === row.bId) continue;
    const swapped = row.aId > row.bId;
    const key = swapped ? `${row.bId}|${row.aId}` : `${row.aId}|${row.bId}`;
    let byObject = pairs.get(key);
    if (!byObject) {
      byObject = new Map();
      pairs.set(key, byObject);
    }
    for (const flow of row.flows) {
      names.set(flow.slug, flow.name);
      const direction = swapped ? flip(flow.direction) : canonical(flow.direction);
      const set = byObject.get(flow.slug) ?? new Set();
      set.add(direction);
      byObject.set(flow.slug, set);
    }
  }

  const totals = new Map<string, { both: number; one: number }>();
  let pairsWithFlows = 0;
  for (const byObject of pairs.values()) {
    if (byObject.size > 0) pairsWithFlows += 1;
    for (const [slug, directions] of byObject) {
      const total = totals.get(slug) ?? { both: 0, one: 0 };
      if (isBothWays(directions)) total.both += 1;
      else total.one += 1;
      totals.set(slug, total);
    }
  }

  const objects: WhatItSyncsObject[] = [...totals.entries()].map(([slug, t]) => ({
    slug,
    name: names.get(slug) ?? slug,
    pair_count: t.both + t.one,
    both_ways: t.both,
    one_way: t.one,
  }));
  objects.sort(
    (a, b) => compareText(a.name, b.name) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
  return { pair_count: pairs.size, pairs_with_flows: pairsWithFlows, objects };
}
