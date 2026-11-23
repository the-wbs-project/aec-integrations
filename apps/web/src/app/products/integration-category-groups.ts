import type { IntegrationTerm } from '@aeci/shared';

import type { IntegrationLaneRow, IntegrationLaneView } from './connector-lane-grouping';
import { partnerCategoryOptions } from './integration-filter';

/**
 * AECI-1783: the long integration list on the product page, grouped by partner
 * category (ruling R3 decision 20, ruling R5 departures 2 and 3).
 *
 * Angular-free, so the grouping rules are unit testable under the plain Vitest runner,
 * the same split `connector-lane-grouping.ts` and `integration-filter.ts` make.
 *
 * **It groups a list, it never orders one.** Rows reach a group in the order they
 * arrive, which is the direct lane's order (partner name A to Z, then edge name, then
 * id). The groups are a new list, so they run A to Z by category name with the slug
 * breaking a tie (ruling R1), through the same `partnerCategoryOptions` the filter
 * chips use. Nothing here reads the agreement state, the data objects, an edit stamp
 * or any other input a paid plan can change. Category membership is the partner's
 * own categories, which the Free plan edits (`product.categories.edit`).
 *
 * **A row sits in every one of its categories.** A partner in two categories is a
 * card in both groups and counts in both. That is the only placement under which the
 * rail, the group heading and the filter chip for one category show the same number:
 * the chip filters rows that carry the category ANYWHERE in their list, so the group
 * must hold exactly those rows. The mock-up filed each partner once under its first
 * category, which is why its rail and chips disagreed (PLAN.md §10.2). Every count
 * for one category comes from {@link rowsInCategory}.
 *
 * **Rows with no category** form one group, last, and only while no category chip is
 * pressed (a pressed chip asks for named categories only).
 */

/**
 * The size from which a list may group: more rows than one page of the one-list mode.
 * Ruled by Chris on 2026-11-16 (ruling 62). A list of {@link ONE_LIST_PAGE_SIZE} or
 * fewer renders as it did before AECI-1783.
 */
export const GROUPED_LIST_MIN_ROWS = 13;

/** The one-list mode shows this many rows, then a "Load more" button adds this many more. */
export const ONE_LIST_PAGE_SIZE = 12;

/**
 * Rows a closed group shows before its "Show more" button: two rows of the widest grid,
 * three rows of the two-column one. Ruled by Chris on 2026-11-16 (was 3). A group of
 * this many or fewer shows every card and has no button. A fixed number, never read
 * from the viewport, so the server HTML is the same for every visitor.
 */
export const GROUP_PEEK_ROWS = 6;

/**
 * Rows a closed group shows below `md`, where the grid is one column (AECI-1720). The
 * 6-card peek was ruled to avoid a lone card in a two- or three-column row, a reason
 * that does not apply to one column, and 6 full-height cards a group made the phone
 * list about 24,000px tall. Applied by CSS on rows that are already in the server HTML,
 * so the server and the browser render the same DOM and nothing shifts on hydration.
 * The cut is still the first rows in the group's order.
 */
export const GROUP_PEEK_ROWS_PHONE = 3;

/** Logos in the "Show more" button's stack: the first hidden partners, in row order. */
export const GROUP_STACK_LOGOS = 5;

/** The arrangement the reader picks for a long list. The server always renders `grouped`. */
export type IntegrationArrangement = 'grouped' | 'one-list';

/** One category group. `category` is `null` for the rows with no category on record. */
export interface IntegrationCategoryGroup {
  /** The category slug, or `''` for the uncategorised group. A stable track key. */
  readonly key: string;
  readonly category: IntegrationTerm | null;
  /** The group's rows, in the order they arrived. */
  readonly rows: readonly IntegrationLaneRow[];
}

/**
 * Whether the section groups. Ruled by Chris on 2026-11-16: 13 rows or more, AND fewer
 * groups than half the rows, so a list whose categories would leave most groups with
 * one card stays one flat list. Read from the UNFILTERED view, so a filter never flips
 * the layout under the reader, and from nothing but the row count and the partners'
 * categories, so the server and the browser always agree. A page with a Via lane keeps
 * its lane cards: the connector groups are an existing order (R1) and the category
 * groups would nest inside them, which the documents do not design.
 */
export function isLongIntegrationList(view: IntegrationLaneView): boolean {
  if (view.via.length > 0) return false;
  const rows = view.direct.length;
  if (rows < GROUPED_LIST_MIN_ROWS) return false;
  return groupRowsByCategory(view.direct).length * 2 < rows;
}

/** The partner categories a row carries. */
function categoriesOf(row: IntegrationLaneRow): readonly IntegrationTerm[] {
  return row.integration.partner_categories ?? [];
}

/**
 * The rows filed under one category, in arrival order. `null` is the uncategorised
 * group. This is the one count for a category: the rail, the group heading and the
 * filter chip all take `.length` of it.
 */
export function rowsInCategory(
  rows: readonly IntegrationLaneRow[],
  slug: string | null,
): IntegrationLaneRow[] {
  return rows.filter((row) => {
    const categories = categoriesOf(row);
    return slug === null ? categories.length === 0 : categories.some((c) => c.slug === slug);
  });
}

/**
 * Group rows by partner category.
 *
 * `chosen` is the reader's pressed category chips. With none pressed, every category
 * the rows carry gets a group, and the uncategorised rows close the list. With some
 * pressed, only those categories get a group, so a row that matched the filter through
 * one category does not reappear under another the reader did not ask for.
 */
export function groupRowsByCategory(
  rows: readonly IntegrationLaneRow[],
  chosen: readonly string[] = [],
): IntegrationCategoryGroup[] {
  const terms = partnerCategoryOptions({ direct: rows, via: [], rowCount: rows.length });
  const groups: IntegrationCategoryGroup[] = [];
  for (const term of terms) {
    if (chosen.length > 0 && !chosen.includes(term.slug)) continue;
    groups.push({ key: term.slug, category: term, rows: rowsInCategory(rows, term.slug) });
  }
  if (chosen.length === 0) {
    const none = rowsInCategory(rows, null);
    if (none.length > 0) groups.push({ key: '', category: null, rows: none });
  }
  return groups;
}

/** A group split at its "Show more" cut. */
export interface GroupPeek {
  /** Rows shown while the group is closed: the first {@link GROUP_PEEK_ROWS}. */
  readonly peek: readonly IntegrationLaneRow[];
  /** The rest, in the DOM but hidden until the reader opens the group or finds one. */
  readonly hidden: readonly IntegrationLaneRow[];
}

/** The first rows of a group in its own order, and the rest. Nothing else decides the cut. */
export function peekGroup(
  rows: readonly IntegrationLaneRow[],
  limit: number = GROUP_PEEK_ROWS,
): GroupPeek {
  const take = Math.max(0, limit);
  return { peek: rows.slice(0, take), hidden: rows.slice(take) };
}

/** The partners the "Show more" stack shows: the first few hidden rows, in row order. */
export function stackPartners(hidden: readonly IntegrationLaneRow[]): IntegrationLaneRow[] {
  return hidden.slice(0, GROUP_STACK_LOGOS);
}

/**
 * `data-columns` for a card grid of `count` cards (ruled 2026-11-16): one or two cards
 * share the full row width equally, so a desktop row never ends in a blank column and
 * no card is wider than its siblings. Three or more keep the grid's own steps.
 */
export function sharedRowColumns(count: number): 1 | 2 | null {
  return count === 1 ? 1 : count === 2 ? 2 : null;
}

/**
 * The DOM id of a group's section and the target of its rail link. Categories and the
 * uncategorised group use different prefixes, so no category slug can collide with it.
 */
export function groupDomId(key: string): string {
  return key === '' ? 'integrations-uncategorised' : `integrations-cat-${key}`;
}
