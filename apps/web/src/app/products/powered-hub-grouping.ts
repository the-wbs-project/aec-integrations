import type { IntegrationListItem, ProductLink } from '@aeci/shared';

/**
 * Stage 1.5 Addendum B — the grouping heuristic behind the connector product
 * page's "Powers these integrations" hub view (`ProductPoweredHub`).
 *
 * Kept in its own module, free of Angular imports, so the heuristic is unit
 * testable under the plain Vitest runner (importing the component would drag in
 * `@angular/router` → `@angular/common`, which needs the JIT compiler). Same
 * split as `core/taxonomy/taxonomy-rank.ts` and `search/search-facet-order.ts`.
 */

/**
 * One hub group: the endpoint product the connector links *everything else* to,
 * plus the partner products on the other side of those edges.
 */
export interface PoweredHubGroup {
  readonly hub: ProductLink;
  readonly partners: readonly ProductLink[];
}

/**
 * Group a connector's powered edges into hub → partners buckets.
 *
 * A powered edge is stored between two endpoint products; the connector is
 * neither of them, so — unlike the endpoint tables — there is no "context"
 * product to orient by, and the stored source/target orientation is arbitrary
 * (it reflects how the row was authored, not a hub/spoke truth). So we derive
 * the hub from the data: count how often each product appears across the whole
 * powered set and file every edge under its **more frequent** endpoint, with the
 * other endpoint becoming a partner chip. Ties break on slug (alphabetical) so
 * the output is deterministic — the same rule `defaultIntegrationContext` uses
 * to pick a canonical pair-page context.
 *
 * The result reads the way a connector is actually shopped for — "Connects
 * Procore with: Acumatica · Sage Intacct · …" — instead of a flat edge list that
 * repeats the same platform on every row.
 *
 * Multiple edges between the same two products (differing mechanism kinds)
 * collapse to a single partner chip; the pair page carries the per-mechanism
 * detail. Self-edges (same product both sides) are defensively skipped — the
 * promote handler rejects them, so one would be corrupt data, not a group.
 */
export function groupPoweredIntegrations(
  integrations: readonly IntegrationListItem[],
): readonly PoweredHubGroup[] {
  const frequency = new Map<string, number>();
  for (const i of integrations) {
    if (i.source.slug === i.target.slug) continue;
    frequency.set(i.source.slug, (frequency.get(i.source.slug) ?? 0) + 1);
    frequency.set(i.target.slug, (frequency.get(i.target.slug) ?? 0) + 1);
  }

  const groups = new Map<string, { hub: ProductLink; partners: Map<string, ProductLink> }>();
  for (const i of integrations) {
    if (i.source.slug === i.target.slug) continue;
    const sourceCount = frequency.get(i.source.slug) ?? 0;
    const targetCount = frequency.get(i.target.slug) ?? 0;
    const sourceIsHub =
      sourceCount === targetCount ? i.source.slug < i.target.slug : sourceCount > targetCount;
    const hub = sourceIsHub ? i.source : i.target;
    const partner = sourceIsHub ? i.target : i.source;

    let group = groups.get(hub.slug);
    if (!group) {
      group = { hub, partners: new Map<string, ProductLink>() };
      groups.set(hub.slug, group);
    }
    // Same-pair edges with different mechanism kinds collapse to one chip.
    if (!group.partners.has(partner.slug)) group.partners.set(partner.slug, partner);
  }

  return [...groups.values()]
    .map((g) => ({
      hub: g.hub,
      partners: [...g.partners.values()].sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => b.partners.length - a.partners.length || a.hub.name.localeCompare(b.hub.name));
}
