import { TEXT_SORT_LOCALE } from '@aeci/shared/text-sort';

import type {
  ConnectorLaneGroup,
  IntegrationLaneRow,
  IntegrationLaneView,
} from './connector-lane-grouping';
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
 *
 * **There is no row threshold (AECI-848), which is why this module exports no
 * constant for one.** A section renders its filter whenever it renders any rows
 * at all. AECI-841 shipped an `INTEGRATION_FILTER_MIN_ROWS = 10` gate on the
 * argument that a filter over a short list is chrome; reader feedback rejected
 * it. The two sections sit next to each other on a connector page, and the same
 * control appearing over one and not the other reads as a bug rather than as
 * restraint — a reader who learns the box exists on Procore should not have to
 * relearn whether the next page earned one. The filter now lives in the section
 * heading row, right-aligned opposite the `<h2>`, so an idle one costs no
 * vertical space at all, which is the only cost the threshold was buying back.
 *
 * **It matches the mechanism label as well as the product name (AECI-966).** It
 * originally matched names alone, which broke its own promise against text the
 * reader could see: `#integrations` renders `mechanism_name` in the Connection
 * column, which is visible from `md` up, so typing `DWG` on the AutoCAD
 * Architecture page
 * returned nothing while a row on screen read "Navisworks DWG file reader". The
 * mechanism label is where the specific, memorable detail lives — a file format,
 * a protocol, a named connector — and it is often the exact word the reader has
 * in mind. Algolia's integrations index already made it searchable
 * (`packages/shared/src/algolia.ts`), so site search found these rows and the
 * on-page filter did not.
 *
 * **The hub half matches a label it does not render, deliberately.** §12.3's
 * cards summarise a pair's mechanisms as a kind label or a count, never as the
 * curator's free text, so widening `filterPoweredHubView` adds an invisible
 * match rather than fixing a visible miss. It is widened anyway because the two
 * sections sit side by side on a connector page: one box finding "DWG" and its
 * neighbour not is the inconsistency AECI-848 spent a threshold to remove. See
 * `PoweredConnection.mechanismNames`.
 */

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
 *
 * `null` and blank never match. A blank would normalize to `''`, and `''` is a
 * substring of every string, so one edge with a whitespace-only
 * `mechanism_name` would make its row match whatever the reader typed.
 */
function matches(name: string | null | undefined, needle: string): boolean {
  if (!name) return false;
  return normalizeFilterText(name).includes(needle);
}

/**
 * Whether any of several fields matches — the row-level test.
 *
 * Exists because AECI-966 made every row multi-field: a row matches on the
 * partner name OR on the mechanism label beside it.
 */
function matchesAny(values: readonly (string | null | undefined)[], needle: string): boolean {
  return values.some((value) => matches(value, needle));
}

/**
 * Whether one endpoint-lane row matches — partner name, or the mechanism label
 * rendered beside it.
 *
 * **It reads the REPRESENTATIVE edge's `mechanism_name`, not every collapsed
 * edge's.** A Via row stands for several edges but renders exactly one label —
 * `ProductIntegrationRow` binds `integration().mechanism_name` — so testing the
 * representative is what keeps the filter and the screen agreeing. Matching the
 * whole collapsed set would surface a row whose visible label does not contain
 * the query, which is the same broken promise as the original defect, inverted.
 */
function matchesRow(row: IntegrationLaneRow, needle: string): boolean {
  return matchesAny([row.other.name, row.integration.mechanism_name], needle);
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

  const direct = view.direct.filter((row) => matchesRow(row, needle));

  const via: ConnectorLaneGroup[] = [];
  for (const group of view.via) {
    const groupMatched = group.connector !== null && matches(group.connector.name, needle);
    const rows = groupMatched ? group.rows : group.rows.filter((row) => matchesRow(row, needle));
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
      : group.partners.filter((row) =>
          matchesAny([row.partner.name, ...row.mechanismNames], needle),
        );
    if (partners.length === 0) continue;
    groups.push(partners === group.partners ? group : { ...group, partners });
  }

  const others = view.others.filter((pair) =>
    matchesAny([pair.a.name, pair.b.name, ...pair.mechanismNames], needle),
  );

  return {
    groups,
    others,
    // A partner row IS a pair, so summing rendered rows reproduces `pairCount`'s
    // own definition rather than approximating it.
    pairCount: groups.reduce((total, group) => total + group.partners.length, 0) + others.length,
  };
}
