import type { ProductIntegrationItem } from '@aeci/shared';
import { compareText } from '@aeci/shared/text-sort';

import { splitIntegrationLanes } from './connector-lane-grouping';

/** One partner category in the hero's category hub (AECI-1787). */
export interface CategoryHubEntry {
  readonly slug: string;
  readonly name: string;
  /** Integration rows whose partner carries this category. */
  readonly count: number;
}

/**
 * The hero's category hub (AECI-1787, ruling R3 decision 1): the partner categories of a
 * product's integrations, each with how many of its integrations reach a partner in it.
 *
 * What it counts. The rows the Integrations section lists, from `splitIntegrationLanes`:
 * one row per direct edge, and one row per (connector, partner) in a via group. That is
 * the section's own `rowCount`, so the hub and the list count the same things. A row is
 * counted once under EACH category its partner carries, the way a partner category
 * filter matches it. So the counts can add up to more than the row count. A partner with
 * no category adds to no entry. Connector-powered rows (`integrations_as_connector`)
 * carry no partner categories and are not read.
 *
 * What it orders. A new list, so ruling R1 applies: A to Z by category name through
 * `compareText`, with the slug as the tie-break. The count never orders and never cuts.
 * Every category with at least one row is listed. Nothing here reads an input a paid
 * plan can change: `partner_categories` is the partner's own categories, which the
 * Free plan edits (`product.categories.edit`). The firewall case is
 * `on-page-ordering-firewall.spec.ts` `[surface:product-page-hero-visual]`.
 */
export function categoryHub(
  asSource: readonly ProductIntegrationItem[],
  asTarget: readonly ProductIntegrationItem[],
): CategoryHubEntry[] {
  const view = splitIntegrationLanes(asSource, asTarget);
  const rows = [...view.direct, ...view.via.flatMap((g) => g.rows)];
  const bySlug = new Map<string, { name: string; count: number }>();
  for (const row of rows) {
    // A partner listed with one category twice still counts once for this row.
    const seen = new Set<string>();
    for (const term of row.integration.partner_categories) {
      if (seen.has(term.slug)) continue;
      seen.add(term.slug);
      const entry = bySlug.get(term.slug);
      if (entry) entry.count += 1;
      else bySlug.set(term.slug, { name: term.name, count: 1 });
    }
  }
  return [...bySlug.entries()]
    .map(([slug, { name, count }]) => ({ slug, name, count }))
    .sort(
      (a, b) => compareText(a.name, b.name) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
    );
}
