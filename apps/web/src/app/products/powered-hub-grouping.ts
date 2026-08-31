import {
  integrationDirectionForContext,
  orderedPairSlugs,
  type ContextDirection,
  type IntegrationListItem,
  type IntegrationMechanismKind,
  type ProductLink,
} from '@aeci/shared';

/**
 * Stage 1.5 Addendum B — the grouping heuristic behind the connector product
 * page's "Integrations it powers" section (`ProductPoweredHub`).
 *
 * Kept in its own module, free of Angular imports, so the heuristic is unit
 * testable under the plain Vitest runner (importing the component would drag in
 * `@angular/router` → `@angular/common`, which needs the JIT compiler). Same
 * split as `core/taxonomy/taxonomy-rank.ts` and `search/search-facet-order.ts`.
 */

/**
 * A connector's edges collapse to **distinct product pairs** before anything
 * else: the same two products can be joined by several rows (different
 * mechanism kinds — or, in live data today, plain duplicates), and rendering a
 * row per edge would repeat the same pair. One pair = one rendered row.
 *
 * `a` / `b` are normalized to the canonical pair-page orientation — `a` is the
 * alphabetically-first slug, matching `defaultIntegrationContext` — so the
 * stored (arbitrary) source/target orientation never leaks into the UI.
 */
export interface PoweredConnection {
  /** `${aSlug}::${bSlug}`, alphabetical — stable `@for` track key. */
  readonly key: string;
  /** Endpoint A: the alphabetically-first slug of the pair. */
  readonly a: ProductLink;
  /** Endpoint B: the other endpoint. */
  readonly b: ProductLink;
  /**
   * Distinct mechanism kinds joining this pair, in enum-stable sorted order.
   * Empty when every collapsed edge had a null `mechanism_kind` (the column is
   * nullable — AECI-115).
   */
  readonly mechanismKinds: readonly IntegrationMechanismKind[];
  /**
   * Flow **relative to endpoint A**, merged across every collapsed edge:
   * `outbound` (A → B), `inbound` (A ← B), `both`, or `null` when no edge
   * carried a stored direction. Two one-way edges pointing opposite ways merge
   * to `both` — together they do describe a round trip.
   */
  readonly direction: ContextDirection | null;
  /** Edges that collapsed into this pair. `> 1` means duplicates or multiple mechanisms. */
  readonly edgeCount: number;
}

/** One partner row inside a hub card, already framed relative to that hub. */
export interface PoweredHubPartner extends PoweredConnection {
  /** The endpoint that is NOT the hub. */
  readonly partner: ProductLink;
  /** `direction` re-framed so it reads relative to the hub, not endpoint A. */
  readonly hubDirection: ContextDirection | null;
}

/** One hub card: a product that joins ≥ `MIN_PAIRS_FOR_HUB` partners. */
export interface PoweredHubGroup {
  readonly hub: ProductLink;
  readonly partners: readonly PoweredHubPartner[];
}

/** What `ProductPoweredHub` renders, and what the section heading counts. */
export interface PoweredHubView {
  /** Hub cards, richest first. */
  readonly groups: readonly PoweredHubGroup[];
  /** Pairs that never earned a hub — rendered as standalone `A ⇄ B` rows. */
  readonly others: readonly PoweredConnection[];
  /**
   * Distinct pairs across `groups` + `others` — i.e. the number of rows the UI
   * actually renders. The section heading counts THIS, not raw edges: a heading
   * that says 4 above 2 visible rows reads as a bug (and live data has exactly
   * that case — NetSuite Connector by Appficiency carries duplicate rows).
   */
  readonly pairCount: number;
}

/**
 * A product needs at least this many distinct pairs before it earns its own hub
 * card. Below it, a "hub" heading would be pure chrome over a single fact, and
 * — worse — a degree-1 product promoted to hub is what let the same product
 * appear as a hub heading AND a partner chip in the same section.
 */
const MIN_PAIRS_FOR_HUB = 2;

/** Mirror a direction across the pair (A-relative ↔ B-relative). */
function flipDirection(direction: ContextDirection | null): ContextDirection | null {
  if (direction === 'outbound') return 'inbound';
  if (direction === 'inbound') return 'outbound';
  return direction;
}

/** Merge two A-relative directions; opposing one-ways describe a round trip. */
function mergeDirections(
  left: ContextDirection | null,
  right: ContextDirection | null,
): ContextDirection | null {
  if (left === null) return right;
  if (right === null) return left;
  return left === right ? left : 'both';
}

interface MutableConnection {
  key: string;
  a: ProductLink;
  b: ProductLink;
  mechanismKinds: Set<IntegrationMechanismKind>;
  direction: ContextDirection | null;
  edgeCount: number;
}

/**
 * Enum-declaration order, so a pair's badges never reshuffle between renders.
 *
 * MUST list every member of `IntegrationMechanismKind`: `freeze()` uses this as a
 * FILTER, so a kind missing here is silently dropped from the badge rather than
 * ordered last. `integrator` is here for that reason (AECI-698 / AECI-721), even
 * though no row carries it until the review app re-keys.
 *
 * A pair whose edges all carry a NULL kind keeps its row and simply renders no
 * badge — the case a connector-evidenced pair always hits, since
 * `connector_evidenced_pairs` has no `mechanism_kind` column at all. Never drop a
 * pair for want of a kind: on a connector's own page those pairs are the subject.
 */
const MECHANISM_ORDER: readonly IntegrationMechanismKind[] = [
  'native',
  'iPaaS',
  'marketplace-app',
  'api',
  'webhook',
  'partner',
  'integrator',
];

function freeze(c: MutableConnection): PoweredConnection {
  return {
    key: c.key,
    a: c.a,
    b: c.b,
    mechanismKinds: MECHANISM_ORDER.filter((k) => c.mechanismKinds.has(k)),
    direction: c.direction,
    edgeCount: c.edgeCount,
  };
}

/**
 * Collapse a connector's powered edges into distinct pairs, then bucket those
 * pairs into hub cards.
 *
 * **Why a hub is picked per PRODUCT, not per edge.** Source/target orientation
 * on a powered edge is arbitrary — it records how the row was authored, not a
 * hub/spoke truth — so the hub has to be derived. The original heuristic did
 * that per edge (file each edge under its more frequent endpoint), which is
 * locally correct and globally incoherent: with edges `ACC↔QuickBooks` and
 * `QuickBooks↔Roofr`, ACC wins the first and QuickBooks wins the second, so
 * **QuickBooks renders as a partner chip AND as a hub heading** in the same
 * section — it reads as a data error. Deciding once per product makes that
 * impossible: a product is either a hub (for all of its pairs) or a partner
 * (for all of them), never both.
 *
 * Greedy, highest-degree-first, ties on slug (alphabetical — the same rule
 * `defaultIntegrationContext` uses, so the output is deterministic):
 *
 * 1. Count each product's **unclaimed** pairs, skipping products already spent
 *    as a partner — that exclusion is what enforces the invariant.
 * 2. The highest count wins, provided it clears `MIN_PAIRS_FOR_HUB`. That
 *    product becomes a hub and claims every unclaimed pair it touches; the far
 *    endpoints become its partners (and are now ineligible to be hubs).
 * 3. Repeat until no candidate clears the floor.
 *
 * Whatever is left has no shared hub, so it is returned as `others` — flat
 * `A ⇄ B` rows — rather than being forced under a one-partner heading.
 *
 * Self-edges (same product both sides) are defensively skipped: the promote
 * handler rejects them, so one would be corrupt data, not a group.
 */
export function groupPoweredIntegrations(
  integrations: readonly IntegrationListItem[],
): PoweredHubView {
  // 1 ─ collapse edges into distinct, canonically-oriented pairs.
  const pairs = new Map<string, MutableConnection>();
  for (const i of integrations) {
    if (i.source.slug === i.target.slug) continue;

    const [aSlug] = orderedPairSlugs(i.source.slug, i.target.slug);
    const sourceIsA = i.source.slug === aSlug;
    const a = sourceIsA ? i.source : i.target;
    const b = sourceIsA ? i.target : i.source;
    const key = `${a.slug}::${b.slug}`;
    // Stored direction is source→target; re-frame it onto endpoint A.
    const direction = integrationDirectionForContext(i.direction, sourceIsA);

    const existing = pairs.get(key);
    if (existing) {
      existing.edgeCount += 1;
      existing.direction = mergeDirections(existing.direction, direction);
      if (i.mechanism_kind) existing.mechanismKinds.add(i.mechanism_kind);
      continue;
    }
    pairs.set(key, {
      key,
      a,
      b,
      mechanismKinds: new Set(i.mechanism_kind ? [i.mechanism_kind] : []),
      direction,
      edgeCount: 1,
    });
  }

  // 2 ─ claim pairs into hub cards, one decision per product.
  const unclaimed = new Set(pairs.keys());
  const spentAsPartner = new Set<string>();
  const groups: PoweredHubGroup[] = [];

  for (;;) {
    const degree = new Map<string, number>();
    for (const key of unclaimed) {
      const pair = pairs.get(key)!;
      for (const slug of [pair.a.slug, pair.b.slug]) {
        if (spentAsPartner.has(slug)) continue;
        degree.set(slug, (degree.get(slug) ?? 0) + 1);
      }
    }

    let hubSlug: string | null = null;
    let hubDegree = 0;
    for (const [slug, count] of degree) {
      if (count > hubDegree || (count === hubDegree && hubSlug !== null && slug < hubSlug)) {
        hubSlug = slug;
        hubDegree = count;
      }
    }
    if (hubSlug === null || hubDegree < MIN_PAIRS_FOR_HUB) break;

    let hub: ProductLink | null = null;
    const partners: PoweredHubPartner[] = [];
    for (const key of [...unclaimed]) {
      const pair = pairs.get(key)!;
      const hubIsA = pair.a.slug === hubSlug;
      if (!hubIsA && pair.b.slug !== hubSlug) continue;

      hub ??= hubIsA ? pair.a : pair.b;
      const partner = hubIsA ? pair.b : pair.a;
      partners.push({
        ...freeze(pair),
        partner,
        // `direction` is A-relative; mirror it when the hub is endpoint B.
        hubDirection: hubIsA ? pair.direction : flipDirection(pair.direction),
      });
      spentAsPartner.add(partner.slug);
      unclaimed.delete(key);
    }

    groups.push({
      hub: hub!,
      partners: partners.sort((x, y) => x.partner.name.localeCompare(y.partner.name)),
    });
  }

  // 3 ─ whatever is left shares no hub; render it flat rather than inventing one.
  const others = [...unclaimed]
    .map((key) => freeze(pairs.get(key)!))
    .sort((x, y) => x.a.name.localeCompare(y.a.name) || x.b.name.localeCompare(y.b.name));

  return {
    groups: groups.sort(
      (x, y) => y.partners.length - x.partners.length || x.hub.name.localeCompare(y.hub.name),
    ),
    others,
    pairCount: pairs.size,
  };
}
