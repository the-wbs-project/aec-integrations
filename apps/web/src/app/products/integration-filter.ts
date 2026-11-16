import type { ContextDirection, IntegrationTerm } from '@aeci/shared';
import { TEXT_SORT_LOCALE, compareText } from '@aeci/shared/text-sort';

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
 * AECI-1782: the reader's whole filter on the endpoint section, as one value.
 *
 * Every field is a choice the READER makes. Nothing here has a default other than
 * "no filter", and no field may be set from anything a paid plan can change: a
 * default filter on a plan input is placement (`PLAN.md` §7.7, the AECI-1814
 * firewall). The agreement state is deliberately absent. "Confirmed by both
 * companies" is a row label only (ruling R1).
 *
 * The state lives in component memory, never in the URL, for the AECI-841 reason:
 * `/products/:slug` is cached by URL, and a filtered URL would mint a cache entry
 * for HTML that does not vary with it. The server always renders the unfiltered
 * section, so every row is in the server HTML.
 */
export interface IntegrationFilterState {
  /** The free-text name filter. */
  readonly query: string;
  /** Context-relative directions. A row matches ANY of them. */
  readonly directions: readonly ContextDirection[];
  /**
   * Data-object slugs. A row must move EVERY one ("must move invoices and RFIs").
   * A row with no data object on record never matches a data-object filter. About a
   * third of live integrations have none (AECI-1816), so whatever renders this
   * filter must say those rows are left out, not that they do not move the object.
   */
  readonly dataObjects: readonly string[];
  /** Partner category slugs. A row matches when its partner is in ANY of them. */
  readonly partnerCategories: readonly string[];
}

/** No filter: the section as the data has it. */
export const NO_INTEGRATION_FILTER: IntegrationFilterState = {
  query: '',
  directions: [],
  dataObjects: [],
  partnerCategories: [],
};

function toState(filter: IntegrationFilterState | string): IntegrationFilterState {
  return typeof filter === 'string' ? { ...NO_INTEGRATION_FILTER, query: filter } : filter;
}

/** Whether a filter state narrows anything. Whitespace alone is not a query. */
export function isIntegrationFilterActive(filter: IntegrationFilterState): boolean {
  return (
    isFilterActive(filter.query) ||
    filter.directions.length > 0 ||
    filter.dataObjects.length > 0 ||
    filter.partnerCategories.length > 0
  );
}

/**
 * The non-text half of a row test: direction, data objects and partner category.
 * AND across the three ("Outbound" AND "Accounting").
 */
function matchesFacets(row: IntegrationLaneRow, filter: IntegrationFilterState): boolean {
  if (filter.directions.length > 0) {
    if (row.direction === null || !filter.directions.includes(row.direction)) return false;
  }
  if (filter.dataObjects.length > 0) {
    const moved = new Set(row.dataObjectSlugs);
    if (!filter.dataObjects.every((slug) => moved.has(slug))) return false;
  }
  if (filter.partnerCategories.length > 0) {
    const categories = row.integration.partner_categories ?? [];
    if (!categories.some((c) => filter.partnerCategories.includes(c.slug))) return false;
  }
  return true;
}

/**
 * Filter the endpoint Integrations section (§13.3's two lanes).
 *
 * Takes the reader's whole filter state (AECI-1782). A bare string is still
 * accepted as a query-only state, so the name-filter cases read as they did.
 *
 * **A group whose own name matches the query keeps every row the other filters
 * keep.** Typing `agave` on an endpoint page is a request for the Agave lane, not
 * for a partner that happens to be called Agave. The connector name is the group's
 * subject, so matching it matches everything filed under it. A group with no name
 * (§13.2(c)'s unnamed bucket) can only be reached through its rows, which is
 * correct: it has no subject to name.
 *
 * Group order, row order and the `via`-after-`direct` lane order are untouched.
 * Filtering removes; it never reorders. A state that filters nothing returns the
 * input view by identity.
 */
export function filterIntegrationLanes(
  view: IntegrationLaneView,
  filter: IntegrationFilterState | string,
): IntegrationLaneView {
  const state = toState(filter);
  if (!isIntegrationFilterActive(state)) return view;
  const needle = normalizeFilterText(state.query);

  const keep = (row: IntegrationLaneRow, groupMatched: boolean): boolean =>
    (needle === '' || groupMatched || matchesRow(row, needle)) && matchesFacets(row, state);

  const direct = view.direct.filter((row) => keep(row, false));

  const via: ConnectorLaneGroup[] = [];
  for (const group of view.via) {
    const groupMatched =
      needle !== '' && group.connector !== null && matches(group.connector.name, needle);
    const rows = group.rows.filter((row) => keep(row, groupMatched));
    if (rows.length === 0) continue;
    via.push(rows.length === group.rows.length ? group : { ...group, rows });
  }

  return {
    direct,
    via,
    rowCount: direct.length + via.reduce((total, group) => total + group.rows.length, 0),
  };
}

/** Every row of a lane view, in render order. */
export function allRows(view: IntegrationLaneView): IntegrationLaneRow[] {
  return [...view.direct, ...view.via.flatMap((group) => [...group.rows])];
}

/** A chip facet whose count leaves its own choices out. */
export type CountedFacet = 'directions' | 'partnerCategories';

/**
 * AECI-1783: the rows a chip of one facet counts. Every other filter applies, the
 * facet's own choices do not, because a row matches ANY chip within a facet. So a
 * chip's count is how many rows the list shows once that chip is the facet's only
 * choice, whatever else the reader pressed in the same facet. In render order.
 */
export function rowsForFacetCount(
  view: IntegrationLaneView,
  filter: IntegrationFilterState,
  facet: CountedFacet,
): IntegrationLaneRow[] {
  return allRows(filterIntegrationLanes(view, { ...filter, [facet]: [] }));
}

/**
 * How many of `rows` move one data object: a data chip's count (AECI-1783). Data chips
 * AND together, so the caller passes the rows every filter keeps, and the count is the
 * rows the list would show with this chip pressed as well.
 */
export function countRowsMovingDataObject(
  rows: readonly IntegrationLaneRow[],
  slug: string,
): number {
  return rows.reduce((total, row) => total + (row.dataObjectSlugs.includes(slug) ? 1 : 0), 0);
}

/** How many of `rows` flow in one direction: a direction chip's count. */
export function countRowsWithDirection(
  rows: readonly IntegrationLaneRow[],
  direction: ContextDirection,
): number {
  return rows.reduce((total, row) => total + (row.direction === direction ? 1 : 0), 0);
}

/** Slug order for a tie on name. Slugs are lowercase ASCII, so a code-unit compare is total. */
function compareSlug(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The chip options for a term facet, built from the rows (AECI-1782).
 *
 * A chip list is a NEW on-page list, so it is A to Z by name with the slug as the
 * tie-break (ruling R1). The wire carries each row's terms in curated
 * `display_order`, but not the order value itself, so a merged list across rows
 * cannot recover it. Never by count: how many rows carry a term is not an order
 * input.
 */
function termOptions(terms: Iterable<IntegrationTerm>): IntegrationTerm[] {
  const bySlug = new Map<string, IntegrationTerm>();
  for (const term of terms) if (!bySlug.has(term.slug)) bySlug.set(term.slug, term);
  return [...bySlug.values()].sort(
    (a, b) => compareText(a.name, b.name) || compareSlug(a.slug, b.slug),
  );
}

/** The partner categories on the section's rows, A to Z. */
export function partnerCategoryOptions(view: IntegrationLaneView): IntegrationTerm[] {
  return termOptions(allRows(view).flatMap((row) => row.integration.partner_categories ?? []));
}

/** The data objects the section's rows move, A to Z. */
export function dataObjectOptions(view: IntegrationLaneView): IntegrationTerm[] {
  return termOptions(allRows(view).flatMap((row) => [...row.dataObjects]));
}

/** The fixed order of the direction chips: the `ContextDirection` vocabulary's own. */
const DIRECTION_ORDER: readonly ContextDirection[] = ['outbound', 'inbound', 'both'];

/** The directions present on the section's rows, in vocabulary order. A row with
 *  no direction on record offers no chip. */
export function directionOptions(view: IntegrationLaneView): ContextDirection[] {
  const present = new Set(allRows(view).map((row) => row.direction));
  return DIRECTION_ORDER.filter((direction) => present.has(direction));
}

/** Rows with no data object on record. A data-object filter leaves every one out,
 *  and the copy that renders that filter has to say so (AECI-1816). */
export function rowsWithoutDataObjects(view: IntegrationLaneView): number {
  return allRows(view).filter((row) => row.dataObjectSlugs.length === 0).length;
}

/** Add a value to a facet if absent, or remove it if present. Keeps first-chosen order. */
export function toggleFacetValue<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
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
