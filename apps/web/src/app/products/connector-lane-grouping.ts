import { MECHANISM_ORDER, mergeContextDirections } from './powered-hub-grouping';

import type {
  ContextDirection,
  IntegrationMechanismKind,
  ProductIntegrationItem,
  ProductLink,
} from '@aeci/shared';

/**
 * Stage 1.5 Addendum C §13.2 / §13.3 — the lane split behind the ENDPOINT
 * product page's Integrations section (`product-detail.ts`).
 *
 * The mirror image of `powered-hub-grouping.ts`, which groups a CONNECTOR's
 * page. Here the connector is *named by the data* rather than derived, so there
 * is no hub heuristic: the pair collapse and the direction merge carry over, the
 * greedy highest-degree search does not.
 *
 * Angular-free, so the routing rules are unit testable under the plain Vitest
 * runner — the same split `powered-hub-grouping.ts` and
 * `core/taxonomy/taxonomy-rank.ts` make.
 */

/** One rendered row. The direct lane keeps one row per edge; a Via group
 *  collapses to one row per (connector, partner) — §13.3's "row identity is per
 *  lane". */
export interface IntegrationLaneRow {
  /** Stable `@for` track key; unique across the whole section. */
  readonly key: string;
  /**
   * The edge this row renders. On a collapsed Via row it is the FIRST edge in
   * sort order — a representative, not a summary: `mechanismKinds` and
   * `direction` below carry the merged facts, and the component reads those
   * rather than the representative's own.
   */
  readonly integration: ProductIntegrationItem;
  /** The endpoint that is not this page's product. */
  readonly other: ProductLink;
  /**
   * Distinct mechanism kinds across the collapsed edges, in enum-stable order.
   * Empty when every edge carried a null kind — which every connector-evidenced
   * row does by construction (`connector_evidenced_pairs` has no such column),
   * so an empty set is the normal case in the Via lane, never a data smell.
   */
  readonly mechanismKinds: readonly IntegrationMechanismKind[];
  /**
   * Flow relative to THIS page's product, merged across the collapsed edges.
   * Already page-relative on the way in — `context_direction` is precomputed
   * server-side (§3.2) — so unlike the connector page's grouping there is no
   * frame to mirror here.
   */
  readonly direction: ContextDirection | null;
  /** Edges collapsed into this row. `> 1` means duplicates or several mechanisms. */
  readonly edgeCount: number;
}

/** One "Via {connector}" group. */
export interface ConnectorLaneGroup {
  /** Connector slug, or `''` for the unnamed bucket — a stable track key. */
  readonly key: string;
  /**
   * The connector, or `null` when the data names none. §13.2(c): an `iPaaS` edge
   * with no `powered_by` is connector-delivered but its connector has no
   * `products` row — 53 production rows, permanently, since AECI-700 parks
   * Zapier and Workato. It groups under an unnamed heading; **never invent a
   * name**. A non-empty unnamed group is a data-integrity signal to watch, not a
   * design state to style.
   */
  readonly connector: ProductLink | null;
  readonly rows: readonly IntegrationLaneRow[];
}

/** What the Integrations section renders, and what its heading counts. */
export interface IntegrationLaneView {
  /** The direct lane, one row per edge, alphabetical by partner name. */
  readonly direct: readonly IntegrationLaneRow[];
  /** Connector groups, by row count desc then connector name; unnamed last. */
  readonly via: readonly ConnectorLaneGroup[];
  /**
   * Rows rendered across BOTH lanes. §13.3: the heading counts this, and the
   * per-group sub-counts sum to it — a reader counting rows must never find
   * fewer than the heading promised.
   */
  readonly rowCount: number;
}

/** Where one edge belongs. Exported for the spec: the routing rule is the part
 *  of §13.2 that is worth asserting clause by clause. */
export type IntegrationLane =
  | { readonly lane: 'direct' }
  | { readonly lane: 'via'; readonly connector: ProductLink | null };

/**
 * §13.2's three clauses, applied in order, to ONE endpoint edge.
 *
 * **(a) Self-reference carve-out, ahead of every FK test.** An edge whose
 * `powered_by_product` is one of its own endpoints stays DIRECT. Review-side
 * Convention A stores *"product X ships a connector on platform C"* as one edge
 * — source `X`, target `C`, `powered_by = C` — deliberately, and it is the
 * population that SURVIVED the AECI-721 migration (60 production rows;
 * `connector_evidenced_pairs_distinct_connector` makes it unrepresentable in the
 * other table). Without this clause each renders a group whose only partner is
 * the connector itself: **"Via Aquifer → Aquifer"**.
 *
 * **(b) Then the connector, FK first.** `via` is the post-migration answer — the
 * row is a `connector_evidenced_pairs` row and names its connector. Failing
 * that, a `powered_by_product` that is neither endpoint routes here too: in a
 * migrated database that set is empty, but preview and staging D1 are not
 * migrated by CI, and misfiling every connector edge as direct there is exactly
 * the failure AECI-706 guarded against.
 *
 * **(c) `iPaaS` with no connector at all → the unnamed group; everything else is
 * direct.** Including an unset-mechanism edge carrying no `powered_by`: unset is
 * not a kind (AECI-698), and filing it under "Via" would invent an attribution
 * the data does not make.
 *
 * **Clause (c) is PERMANENT (AECI-735).** It is not a bridge waiting for the FK to
 * be backfilled. Its 53 production edges are `iPaaS` with a NULL `powered_by`
 * because their connector is unpromoted, they cannot move to
 * `connector_evidenced_pairs` (`connector_product_id` is NOT NULL), and AECI-700
 * parks Zapier and Workato indefinitely — so the set never drains and clause (c) is
 * the only thing keeping those edges off the "direct, first-party" lane. Its sibling
 * is `isConnectorPoweredEdge` (`apps/api/src/lib/connector-powered.ts`), which reads
 * `iPaaS` for the same population to gate AECI-705's attestation prompts; the two
 * change together or not at all.
 */
export function routeIntegrationLane(item: ProductIntegrationItem): IntegrationLane {
  const poweredBy = item.powered_by_product;
  if (poweredBy && (poweredBy.id === item.source.id || poweredBy.id === item.target.id)) {
    return { lane: 'direct' };
  }
  if (item.via) return { lane: 'via', connector: item.via };
  if (poweredBy) return { lane: 'via', connector: poweredBy };
  if (item.mechanism_kind === 'iPaaS') return { lane: 'via', connector: null };
  return { lane: 'direct' };
}

interface MutableRow {
  key: string;
  integration: ProductIntegrationItem;
  other: ProductLink;
  mechanismKinds: Set<IntegrationMechanismKind>;
  direction: ContextDirection | null;
  edgeCount: number;
}

function freeze(row: MutableRow): IntegrationLaneRow {
  return {
    key: row.key,
    integration: row.integration,
    other: row.other,
    mechanismKinds: MECHANISM_ORDER.filter((k) => row.mechanismKinds.has(k)),
    direction: row.direction,
    edgeCount: row.edgeCount,
  };
}

/** Today's ordering, unchanged: partner name, then edge name, then id (total, so
 *  the render order is stable across reloads). */
function compareRows(x: MutableRow, y: MutableRow): number {
  return (
    x.other.name.localeCompare(y.other.name) ||
    x.integration.name.localeCompare(y.integration.name) ||
    x.integration.id.localeCompare(y.integration.id)
  );
}

function seed(
  integration: ProductIntegrationItem,
  other: ProductLink,
  keyPrefix: string,
): MutableRow {
  return {
    key: `${keyPrefix}::${integration.id}`,
    integration,
    other,
    mechanismKinds: new Set(integration.mechanism_kind ? [integration.mechanism_kind] : []),
    direction: integration.context_direction,
    edgeCount: 1,
  };
}

/**
 * Split a product's endpoint edges into the direct lane and the "Via {connector}"
 * groups (§13.3).
 *
 * Takes the two payload buckets rather than a pre-flattened list because `other`
 * is bucket-derived: in `integrations_as_source` this product IS the source, so
 * the partner is the target, and vice versa. Both buckets already span BOTH
 * delivered-tier tables (AECI-713) — which table an edge lives in reaches this
 * function only as `via`.
 */
export function splitIntegrationLanes(
  asSource: readonly ProductIntegrationItem[],
  asTarget: readonly ProductIntegrationItem[],
): IntegrationLaneView {
  const direct: MutableRow[] = [];
  // Keyed by connector slug; `''` is §13.2(c)'s unnamed bucket.
  const groups = new Map<
    string,
    { connector: ProductLink | null; rows: Map<string, MutableRow> }
  >();

  const consider = (integration: ProductIntegrationItem, other: ProductLink): void => {
    const route = routeIntegrationLane(integration);
    if (route.lane === 'direct') {
      // One row per edge — the direct lane does NOT collapse (§13.3).
      direct.push(seed(integration, other, 'direct'));
      return;
    }
    const groupKey = route.connector?.slug ?? '';
    let group = groups.get(groupKey);
    if (!group) {
      group = { connector: route.connector, rows: new Map() };
      groups.set(groupKey, group);
    }
    const existing = group.rows.get(other.slug);
    if (!existing) {
      group.rows.set(other.slug, seed(integration, other, `via:${groupKey}`));
      return;
    }
    // Collapse: one row per (connector, partner).
    existing.edgeCount += 1;
    existing.direction = mergeContextDirections(existing.direction, integration.context_direction);
    if (integration.mechanism_kind) existing.mechanismKinds.add(integration.mechanism_kind);
    // Keep the representative deterministic rather than arrival-ordered: the
    // partner is identical by construction here, so name-then-id decides it.
    const isEarlier =
      (integration.name.localeCompare(existing.integration.name) ||
        integration.id.localeCompare(existing.integration.id)) < 0;
    if (isEarlier) existing.integration = integration;
  };

  for (const integration of asSource) consider(integration, integration.target);
  for (const integration of asTarget) consider(integration, integration.source);

  const via: ConnectorLaneGroup[] = [...groups.entries()]
    .map(([key, group]) => ({
      key,
      connector: group.connector,
      rows: [...group.rows.values()].sort(compareRows).map(freeze),
    }))
    .sort(
      (x, y) =>
        // Unnamed last: it is the weakest claim in the section, and sorting it by
        // a name it does not have would be arbitrary.
        Number(x.connector === null) - Number(y.connector === null) ||
        y.rows.length - x.rows.length ||
        (x.connector?.name ?? '').localeCompare(y.connector?.name ?? ''),
    );

  const directRows = direct.sort(compareRows).map(freeze);
  return {
    direct: directRows,
    via,
    rowCount: directRows.length + via.reduce((n, g) => n + g.rows.length, 0),
  };
}

/**
 * Rows rendered eagerly before the `@defer (on viewport)` boundary. Unchanged
 * from the single-table section; what changed is that it is now spent across the
 * whole section rather than per lane (see `applyDeferCut`).
 */
export const INTEGRATIONS_ABOVE_FOLD = 20;

/** One lane's rows, cut for `@defer`. */
export interface DeferredLane<T> {
  readonly lane: T;
  readonly above: readonly IntegrationLaneRow[];
  readonly deferred: readonly IntegrationLaneRow[];
}

/** The whole section, cut for `@defer`. */
export interface DeferredLaneView {
  readonly direct: DeferredLane<null>;
  readonly via: readonly DeferredLane<ConnectorLaneGroup>[];
}

/**
 * Apply §13.3's `@defer (on viewport)` cut to the **flattened** render order —
 * direct lane, then each group in order — so the boundary still lands after
 * `limit` visible rows rather than `limit` rows into every lane. A lane wholly
 * past the boundary defers in one piece.
 *
 * Pure and separately tested because the arithmetic is the kind that looks right
 * and is off by a lane: with a 20-row cut, a 15-row direct lane leaves 5 for the
 * first group, not 20.
 */
export function applyDeferCut(view: IntegrationLaneView, limit: number): DeferredLaneView {
  let remaining = Math.max(0, limit);
  const cut = <T>(lane: T, rows: readonly IntegrationLaneRow[]): DeferredLane<T> => {
    const take = Math.min(remaining, rows.length);
    remaining -= take;
    return { lane, above: rows.slice(0, take), deferred: rows.slice(take) };
  };
  return {
    direct: cut(null, view.direct),
    via: view.via.map((group) => cut(group, group.rows)),
  };
}
