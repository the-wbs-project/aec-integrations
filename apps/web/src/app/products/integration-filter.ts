import { TEXT_SORT_LOCALE } from '@aeci/shared/text-sort';

import type { ConnectorLaneGroup, IntegrationLaneView } from './connector-lane-grouping';
import type { PoweredHubGroup, PoweredHubView } from './powered-hub-grouping';

/**
 * AECI-841 — the client-side name filter behind both product-detail integration
 * sections (`#integrations` and `#powered-integrations`).
 *
 * Angular-free, so the matching rules are unit testable under the plain Vitest
 * runner — the same split `connector-lane-grouping.ts` and
 * `powered-hub-grouping.ts` make.
 *
 * **It filters a view, it does not build one.** Both functions take the grouped
 * view their section already renders and return the same shape with rows and
 * groups removed. Nothing re-sorts, nothing re-groups, and the recomputed count
 * field keeps the §12.3 / §13.3 invariant that the count and the rendered rows
 * are the same set. An empty query returns the input object by identity, so a
 * page that never uses the filter allocates nothing.
 *
 * **The query never reaches the URL.** `/products/:slug` is a cacheable SSR
 * route keyed on path + query (`cacheKeyFor`), so a `?q=` would mint an edge
 * cache entry per keystroke against a page whose HTML does not vary with it.
 * The query lives in component state and dies with the page.
 */

/**
 * Rows a section must render before its filter box appears.
 *
 * Below this a filter is chrome: the whole list is already on one screen, and an
 * input that can only ever remove three rows costs more attention than it saves.
 * Ten is the point where the endpoint table stops fitting a laptop viewport
 * alongside the section heading and the scope note.
 */
export const INTEGRATION_FILTER_MIN_ROWS = 10;

/**
 * Fold a display name to its comparison form: accents stripped, lowercased
 * against the pinned catalog locale.
 *
 * The locale is pinned for the same reason `compareText` pins it — SSR runs in
 * workerd and the client runs in the visitor's browser, so an ambient locale
 * makes the two disagree. Filtering is client-only today, but the rule costs
 * nothing and removes the trap if a future caller runs it server-side.
 *
 * Accent folding matters on this catalog: a reader typing `procore` should not
 * be beaten by a partner recorded with a diacritic they cannot type.
 */
export function normalizeFilterText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase(TEXT_SORT_LOCALE)
    .trim();
}

/** Whether a raw input string is a filter at all. Whitespace is not a query. */
export function isFilterActive(query: string): boolean {
  return normalizeFilterText(query) !== '';
}

/**
 * Substring match, not token match.
 *
 * Product names here are short proper nouns ("Sage 300 CRE", "eSUB Cloud"), so a
 * reader types a prefix of ONE name rather than a bag of words. Splitting the
 * query on whitespace would make `sage 300` match a product called
 * `300 Sage Road`, which is a worse answer than no answer.
 */
function matches(name: string, needle: string): boolean {
  return normalizeFilterText(name).includes(needle);
}

/**
 * Filter the endpoint Integrations section (§13.3's two lanes).
 *
 * **A group whose own name matches keeps every row.** Typing `agave` on an
 * endpoint page is a request for the Agave lane, not for a partner that happens
 * to be called Agave — the connector name is the group's subject, so matching it
 * matches everything filed under it. A group with no name (§13.2(c)'s unnamed
 * bucket) can only be reached through its rows, which is correct: it has no
 * subject to name.
 *
 * Group order, row order and the `via`-after-`direct` lane order are untouched.
 * Filtering removes; it never reorders.
 */
export function filterIntegrationLanes(
  view: IntegrationLaneView,
  query: string,
): IntegrationLaneView {
  const needle = normalizeFilterText(query);
  if (needle === '') return view;

  const direct = view.direct.filter((row) => matches(row.other.name, needle));

  const via: ConnectorLaneGroup[] = [];
  for (const group of view.via) {
    const groupMatched = group.connector !== null && matches(group.connector.name, needle);
    const rows = groupMatched
      ? group.rows
      : group.rows.filter((row) => matches(row.other.name, needle));
    if (rows.length === 0) continue;
    via.push(rows === group.rows ? group : { ...group, rows });
  }

  return {
    direct,
    via,
    rowCount: direct.length + via.reduce((total, group) => total + group.rows.length, 0),
  };
}

/**
 * Filter the "Integrations it powers" hub view (§12.3).
 *
 * The hub-name rule above applies to a hub card. A hubless pair in `others`
 * matches on EITHER endpoint, because neither of the two has been promoted to
 * the row's subject — that is the whole reason it is in `others`.
 */
export function filterPoweredHubView(view: PoweredHubView, query: string): PoweredHubView {
  const needle = normalizeFilterText(query);
  if (needle === '') return view;

  const groups: PoweredHubGroup[] = [];
  for (const group of view.groups) {
    const hubMatched = matches(group.hub.name, needle);
    const partners = hubMatched
      ? group.partners
      : group.partners.filter((row) => matches(row.partner.name, needle));
    if (partners.length === 0) continue;
    groups.push(partners === group.partners ? group : { ...group, partners });
  }

  const others = view.others.filter(
    (pair) => matches(pair.a.name, needle) || matches(pair.b.name, needle),
  );

  return {
    groups,
    others,
    // A partner row IS a pair, so summing rendered rows reproduces `pairCount`'s
    // own definition rather than approximating it.
    pairCount: groups.reduce((total, group) => total + group.partners.length, 0) + others.length,
  };
}
