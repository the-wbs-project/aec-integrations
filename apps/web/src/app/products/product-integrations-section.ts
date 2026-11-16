import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input, signal } from '@angular/core';

import type { ContextDirection, ProductIntegrationItem, ProductListItem } from '@aeci/shared';

import { formatNameList } from '../core/meta.helpers';
import { RequestTrigger } from '../requests/request-trigger';
import { contextDirectionLabel } from '../search/mechanism-labels';
import { Chip } from '../shared/chip/chip';
import type { ListingView } from '../shared/listing-toolbar/listing-toolbar';
import { ListingViewToggle } from '../shared/listing-toolbar/listing-view-toggle';

import {
  applyDeferCut,
  INTEGRATIONS_ABOVE_FOLD,
  splitIntegrationLanes,
  type ConnectorLaneGroup,
} from './connector-lane-grouping';
import { IntegrationArrangementToggle } from './integration-arrangement-toggle';
import {
  groupRowsByCategory,
  isLongIntegrationList,
  ONE_LIST_PAGE_SIZE,
  rowsInCategory,
  type IntegrationArrangement,
} from './integration-category-groups';
import {
  allRows,
  countRowsMovingDataObject,
  countRowsWithDirection,
  dataObjectOptions,
  directionOptions,
  filterIntegrationLanes,
  isIntegrationFilterActive,
  partnerCategoryOptions,
  rowsForFacetCount,
  toggleFacetValue,
  type IntegrationFilterState,
} from './integration-filter';
import { IntegrationGroupCard } from './integration-group-card';
import { IntegrationListFilter } from './integration-list-filter';
import { ProductIntegrationCards } from './product-integration-cards';
import { ProductIntegrationGroups } from './product-integration-groups';
import { ProductIntegrationOneList } from './product-integration-one-list';
import { ProductIntegrationsTable } from './product-integrations-table';

/**
 * The endpoint `#integrations` section of the product detail page.
 *
 * Extracted from `product-detail.ts` by AECI-841, which gave the section its own
 * filter query and collapsed-card state. The section is the only thing that
 * needs the lane split, the `@defer` cut or the query, so keeping all four in
 * one place is what stops the page component growing a second job.
 *
 * ── THE LANE SPLIT (Stage 1.5 §13.2 / §13.3) ────────────────────────────────────
 * The direct list first, then one group per connector. Direct-first because an
 * accountable-party integration is a stronger answer to "does A integrate with
 * B" than a configurable one: someone is on the hook for it.
 *
 * **The split is a sourcing question, not a rendering one.** Both payload
 * buckets already span both delivered-tier tables (`integrations` and
 * `connector_evidenced_pairs`), and which table a row came from reaches this
 * component only as `via`. That is why §13.3 is written source-agnostically and
 * why the AECI-721 migration moved rows without touching this contract.
 *
 * The source/target buckets survive only as *which endpoint is the partner*. The
 * direction shown per row is the server-precomputed, context-relative
 * `context_direction` (claims-aware, §3.2), never the bucket — so the two
 * interleave rather than concatenate inside each lane, and a reader never sees
 * an unexplained break in the alphabet.
 *
 * Sorting and grouping have to happen here rather than in SQL. The relations can
 * only `ORDER BY` columns of their own table — the partner name lives on the
 * joined product — and the lane a row belongs to is a three-clause rule over two
 * nullable FKs. Client-side is also where the full list exists before the
 * `@defer` cut, so the cut lands on the alphabet.
 *
 * **One `<table>` per lane** (§13.3), never group-header rows interleaved into a
 * single `<tbody>`: a header row inside a table body has no accessible name
 * relationship to the rows beneath it. Each lane's table is named by its card's
 * `<h3>` through `aria-labelledby`, so heading and table cannot drift.
 *
 * ── THE REACH LINE (§13.7, AECI-892) ────────────────────────────────────────
 * One sentence, and every one of its constraints is a prohibition:
 *
 *   - it **names no connector**. A per-connector group is a list, renders a table
 *     row, and enters the section's count — three of §13.7's three prohibitions —
 *     and a "Via {connector}" card that outlives its own delivered row asserts a
 *     delivery the I24 ruling has just said does not exist;
 *   - it is **not a table row** and not a card;
 *   - it **never touches `lanes().rowCount`**, so the "Showing n of m" total
 *     cannot move. §13.5 is categorical: reachable never counts, anywhere;
 *   - it is **unlinked at v0**. §13.7 says it links "our filtered view" and no
 *     such route exists; the only lawful target would be the curated pair set,
 *     which would make this line inherit everything publication is gated on. The
 *     link is deferred to AECI-716.
 *
 * It renders on the EMPTY branch too, and that is the case the work exists for:
 * a product whose only connector-delivered edge was retired by the AECI-889
 * sweep has no lanes left and is precisely the page that must still answer
 * "does X integrate with Y".
 *
 * ── CARDS, TABLE AND THE FILTER PANEL (AECI-1782) ───────────────────────────────
 * Cards by default, the table as the alternative (PLAN.md §5.2, clash 24). The
 * server always renders cards, and every row is a card in the server HTML. The
 * Cards/Table toggle, the name filter and the direction and partner-category chips
 * are component state, never the URL, so a cached page is identical for every
 * visitor. Each lane renders one named list of cards, the card view's version of
 * one table per lane. The filters sit in one panel of their own under the `<h2>`
 * (ruling R5). There is no sort control (R5), and no control reads the agreement
 * state (R1). The order is the lane order below, unchanged: R1 keeps existing
 * orders, and the direct lane is already A to Z by partner name with the id last.
 *
 * ── LONG LISTS (AECI-1783) ───────────────────────────────────────────────────────
 * A single-lane section of 13 rows or more, with fewer category groups than half its
 * rows, groups by partner category (ruled 2026-11-16), with a jump
 * rail and a "Show more" per group (ruling R3 decision 20, ruling R5). The reader can
 * switch it to one list, 12 at a time. The server always renders the grouped
 * arrangement, and every row is in its HTML. The grouping rules, the counts and the
 * cuts live in `integration-category-groups.ts`; this component only wires them. Every
 * filter chip prints how many rows it would show, and a category chip's number is the
 * same `rowsInCategory` count the rail and the group heading print. A chip whose count
 * is 0 is disabled unless it is pressed, so it can always be released (2026-11-16).
 * A shorter list, a page with a Via lane and the table view render as they did before.
 *
 * ── SINGLE-LANE PAGES ────────────────────────────────────────────────────────────
 * A product with no connector-delivered edges — the overwhelming majority —
 * still renders exactly one unheaded list, named by the section `<h2>`. §13.3
 * rejected a "Direct integrations" heading over the only table as chrome over a
 * fact the heading already states, and a collapsible card would be that same
 * chrome with a button on it.
 *
 * ── THE `@defer` CUT ────────────────────────────────────────────────────────────
 * Past 20 rows the remainder ships as deferred `<tr>`s in an
 * `@defer (on viewport; hydrate on viewport)` block, and the budget is spent
 * across the FLATTENED lane order so it lands after 20 visible rows rather than
 * 20 rows into every lane. Under v22 incremental hydration those rows are
 * SSR-rendered, so a crawler sees every one. **An active filter turns the cut
 * off** (the limit becomes the filtered row count): a filtered list is short by
 * construction, and a collapsed card's deferred block would otherwise never
 * reach the viewport that triggers it.
 */
@Component({
  // Attribute selector on a real <section>, so the id, the label association
  // and the landmark all stay on the element the page already had. A wrapper
  // custom element would push #integrations one level deeper and demote the
  // labelled region to a plain div. Same trade, same escape hatch, as
  // `ProductIntegrationRow`.
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'section[aec-product-integrations-section]',
  imports: [
    Chip,
    IntegrationArrangementToggle,
    IntegrationGroupCard,
    IntegrationListFilter,
    ListingViewToggle,
    NgTemplateOutlet,
    ProductIntegrationCards,
    ProductIntegrationGroups,
    ProductIntegrationOneList,
    ProductIntegrationsTable,
    RequestTrigger,
  ],
  template: `
    <h2 id="integrations-title" class="font-display text-2xl font-semibold text-(--text-primary)">
      {{ heading() }}
    </h2>
    <!-- The order line (approved 2026-11-16). Only where it is true of every row: a
         page with a Via lane orders its connector groups by row count (R1), so it shows
         only on a page with no Via lane. Grouped or not, the rows run A to Z by partner. -->
    @if (lanes().rowCount > 0 && lanes().via.length === 0) {
      <p
        class="text-sm text-(--text-secondary)"
        data-testid="integrations-order"
        i18n="@@products.detail.body.integrations.order"
      >
        A to Z by partner name.
      </p>
    }

    <!-- The filter panel (AECI-1782). Ruling R5 kept "integration filters in their
         own panel": one panel of its own, not the shared facet panel. Every control
         is a choice the reader makes, and the state never reaches the URL, so the
         server always renders the whole section. The agreement state is not a
         filter (ruling R1). -->
    @if (showFilter()) {
      <div
        role="group"
        aria-labelledby="integrations-filters-title"
        class="space-y-4 rounded-panel bg-(--surface-sunken) p-4 md:p-6"
        data-testid="integrations-filter-panel"
      >
        <div class="flex flex-wrap items-center justify-between gap-3">
          <span
            id="integrations-filters-title"
            class="aec-overline text-(--text-primary)"
            i18n="@@listing.filters.title"
            >Filters</span
          >
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
            @if (filterActive()) {
              <button
                type="button"
                class="inline-flex min-h-6 items-center rounded-(--radius-sm) text-sm text-(--accent-primary) underline-offset-2 transition-colors hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                (click)="clearFilters()"
                data-testid="integrations-filter-clear"
                i18n="@@listing.filters.clear"
              >
                Clear filters
              </button>
            }
            @if (long() && view() === 'cards') {
              <aec-integration-arrangement-toggle
                [arrangement]="arrangement()"
                (arrangementChange)="arrangement.set($event)"
              />
            }
            <aec-listing-view-toggle [view]="view()" (viewChange)="view.set($event)" />
          </div>
        </div>

        <aec-integration-list-filter
          inputId="integrations-filter"
          i18n-label="@@products.detail.body.integrations.filter.label"
          label="Search these integrations"
          i18n-placeholder="@@products.detail.body.integrations.filter.placeholder"
          placeholder="Filter by product or connection"
          [(query)]="query"
          [active]="filterActive()"
          [shown]="filteredLanes().rowCount"
          [total]="lanes().rowCount"
        />

        @if (directionChoices().length > 0) {
          <div
            role="group"
            aria-labelledby="integrations-filter-direction"
            class="flex flex-wrap items-center gap-2"
          >
            <span
              id="integrations-filter-direction"
              class="me-2 text-sm font-semibold text-(--text-primary)"
              i18n="@@search.facet.direction"
              >Direction</span
            >
            @for (choice of directionChoices(); track choice.token) {
              <aec-chip
                [selected]="choice.selected"
                [disabled]="choice.count === 0 && !choice.selected"
                (activated)="toggleDirection(choice.token)"
              >
                <span class="inline-block leading-none rtl:-scale-x-100" aria-hidden="true">{{
                  choice.glyph
                }}</span>
                {{ choice.label }}
                <span class="font-normal tabular-nums" data-testid="integrations-chip-count">{{
                  choice.count
                }}</span>
              </aec-chip>
            }
          </div>
        }

        @if (dataChoices().length > 0) {
          <div class="space-y-2">
            <div
              role="group"
              aria-labelledby="integrations-filter-data"
              [attr.aria-describedby]="dataFilterActive() ? 'integrations-filter-data-note' : null"
              class="flex flex-wrap items-center gap-2"
            >
              <span
                id="integrations-filter-data"
                class="me-2 text-sm font-semibold text-(--text-primary)"
                i18n="@@products.detail.body.integrations.dataTypes"
                >Types of data</span
              >
              @for (choice of dataChoices(); track choice.slug) {
                <aec-chip
                  [selected]="choice.selected"
                  [disabled]="choice.count === 0 && !choice.selected"
                  (activated)="toggleDataObject(choice.slug)"
                  >{{ choice.name }}
                  <span class="font-normal tabular-nums" data-testid="integrations-chip-count">{{
                    choice.count
                  }}</span></aec-chip
                >
              }
            </div>
            <!-- AECI-1816: about a third of live rows have no data object on record, and
                 a data filter leaves every one of them out. Say so while it is on. The
                 live region is always present, so the note is announced as it appears. -->
            <p class="text-sm text-(--text-secondary)" aria-live="polite">
              @if (dataFilterActive()) {
                <span
                  id="integrations-filter-data-note"
                  data-testid="integrations-filter-data-note"
                  i18n="@@products.detail.body.integrations.filter.dataTypes.note"
                  >Integrations with no types of data on record are not shown while this filter is
                  on.</span
                >
              }
            </p>
          </div>
        }

        @if (categoryChoices().length > 0) {
          <div
            role="group"
            aria-labelledby="integrations-filter-categories"
            class="flex flex-wrap items-center gap-2"
          >
            <span
              id="integrations-filter-categories"
              class="me-2 text-sm font-semibold text-(--text-primary)"
              i18n="@@search.facet.categories"
              >Categories</span
            >
            @for (choice of categoryChoices(); track choice.slug) {
              <aec-chip
                [selected]="choice.selected"
                [disabled]="choice.count === 0 && !choice.selected"
                (activated)="toggleCategory(choice.slug)"
                >{{ choice.name }}
                <span class="font-normal tabular-nums" data-testid="integrations-chip-count">{{
                  choice.count
                }}</span></aec-chip
              >
            }
          </div>
        }
      </div>
    }

    @if (lanes().rowCount === 0) {
      <div
        class="space-y-2 rounded-(--radius-lg) border border-dashed border-(--border-default)
            bg-(--surface-sunken) p-6 text-sm text-(--text-secondary)"
      >
        <!-- §13.3b (AECI-710): an extension usually has no integrations with its
             host, because it runs inside it. Say so where the reader is looking,
             in one sentence, and point at the sidebar card that carries the host.
             Only on the EMPTY branch: a populated section needs no excuse. -->
        @if (builtWithinLine(); as line) {
          <p>{{ line }}</p>
        }
        <p i18n="@@products.detail.body.integrations.empty">
          No integrations recorded yet. Vendor data is curated; if you know of one,
          <a
            aecRequestTrigger
            [entity]="'product'"
            [kind]="'correction'"
            [slug]="slug()"
            [href]="'/products/' + slug() + '/correction'"
            class="text-(--accent-primary) underline underline-offset-2"
            >suggest a correction</a
          >.
        </p>
      </div>
      <ng-container [ngTemplateOutlet]="reachLine" />
    } @else {
      <!-- A page with no connector edges renders exactly what it always did:
             one unheaded table, named by the section heading. The lane structure
             appears only when there is a second lane to distinguish. -->
      @if (lanes().via.length === 0) {
        @if (filteredLanes().rowCount > 0) {
          @if (view() === 'cards' && long()) {
            <!-- AECI-1783: a long list, grouped by default, or one list by choice. -->
            @if (arrangement() === 'grouped') {
              <aec-product-integration-groups
                [groups]="categoryGroups()"
                [contextSlug]="slug()"
                [forceOpen]="openAllGroups()"
              />
            } @else {
              <aec-product-integration-one-list
                [rows]="filteredLanes().direct"
                [contextSlug]="slug()"
                i18n-ariaLabel="@@products.detail.body.integrations.table.aria"
                ariaLabel="Integrations"
              />
            }
          } @else if (view() === 'cards') {
            <aec-product-integration-cards
              [above]="laneCut().direct.above"
              [deferred]="laneCut().direct.deferred"
              [contextSlug]="slug()"
              i18n-ariaLabel="@@products.detail.body.integrations.table.aria"
              ariaLabel="Integrations"
            />
          } @else {
            <aec-product-integrations-table
              [above]="laneCut().direct.above"
              [deferred]="laneCut().direct.deferred"
              [contextSlug]="slug()"
              i18n-ariaLabel="@@products.detail.body.integrations.table.aria"
              ariaLabel="Integrations"
            />
          }
        }
      } @else {
        @if (filteredLanes().direct.length > 0) {
          <aec-integration-group-card
            headingId="integrations-direct"
            [heading]="directHeading()"
            [countLabel]="countLabel(filteredLanes().direct.length, lanes().direct.length)"
            [expanded]="isExpanded('integrations-direct')"
            (toggled)="toggle('integrations-direct')"
          >
            @if (view() === 'cards') {
              <aec-product-integration-cards
                class="p-4 md:p-6"
                [above]="laneCut().direct.above"
                [deferred]="laneCut().direct.deferred"
                [contextSlug]="slug()"
                ariaLabelledby="integrations-direct"
                [headingLevel]="4"
                [nested]="true"
              />
            } @else {
              <aec-product-integrations-table
                [above]="laneCut().direct.above"
                [deferred]="laneCut().direct.deferred"
                [contextSlug]="slug()"
                ariaLabelledby="integrations-direct"
              />
            }
          </aec-integration-group-card>
        }
        @for (lane of laneCut().via; track lane.lane.key) {
          <aec-integration-group-card
            [headingId]="'integrations-via-' + lane.lane.key"
            [heading]="viaHeading(lane.lane)"
            [logo]="
              lane.lane.connector
                ? {
                    src: lane.lane.connector.logo_url,
                    name: lane.lane.connector.name,
                    claimStatus: 'server-filtered',
                  }
                : null
            "
            [countLabel]="countLabel(lane.lane.rows.length, viaTotal(lane.lane.key))"
            [link]="viaLink(lane.lane)"
            i18n-linkLabel="@@products.detail.group.link"
            linkLabel="View product"
            [linkAriaLabel]="viaLinkAriaLabel(lane.lane)"
            [expanded]="isExpanded('integrations-via-' + lane.lane.key)"
            (toggled)="toggle('integrations-via-' + lane.lane.key)"
          >
            @if (view() === 'cards') {
              <aec-product-integration-cards
                class="p-4 md:p-6"
                [above]="lane.above"
                [deferred]="lane.deferred"
                [contextSlug]="slug()"
                [ariaLabelledby]="'integrations-via-' + lane.lane.key"
                [headingLevel]="4"
                [nested]="true"
              />
            } @else {
              <aec-product-integrations-table
                [above]="lane.above"
                [deferred]="lane.deferred"
                [contextSlug]="slug()"
                [ariaLabelledby]="'integrations-via-' + lane.lane.key"
              />
            }
          </aec-integration-group-card>
        }
      }

      @if (filteredLanes().rowCount === 0) {
        <!-- Chips, with or without a search, take the filters message (approved
             2026-11-16). A search alone keeps the search message. -->
        <p
          class="rounded-(--radius-lg) border border-dashed border-(--border-default)
              bg-(--surface-sunken) p-6 text-sm text-(--text-secondary)"
          data-testid="integrations-filter-empty"
        >
          @if (chipFilterActive()) {
            <span i18n="@@products.detail.body.integrations.filter.empty.chips"
              >No integrations match these filters.</span
            >
          } @else {
            <span i18n="@@products.detail.body.integrations.filter.empty"
              >No integrations match that search.</span
            >
          }
        </p>
      }

      <ng-container [ngTemplateOutlet]="reachLine" />

      <!-- Catalog-scope note. An integration row only exists once BOTH
             endpoints are promoted products, so this table is bounded by the
             directory, not by the vendor's real partner list: a product with
             hundreds of marketplace partners can render a dozen. The empty state
             already hedges ("Vendor data is curated"); without this line the
             POPULATED state makes a bare confident count, which is the one
             people screenshot. Scope, not apology: it states the boundary and
             offers the fix. Once per section, never once per group (§13.3). -->
      <p class="text-xs text-(--text-secondary)" i18n="@@products.detail.body.integrations.scope">
        Only partners listed on AEC Integrations appear here. If one is missing,
        <a
          aecRequestTrigger
          [entity]="'product'"
          [kind]="'correction'"
          [slug]="slug()"
          [href]="'/products/' + slug() + '/correction'"
          class="text-(--accent-primary) underline underline-offset-2"
          >suggest a correction</a
        >.
      </p>
    }

    <!-- §13.7's summary line for the REACHABLE tier. Rendered through an
         ng-template because it belongs on both branches, in different places:
         last on the empty branch, above the scope note on the populated one,
         where that note is the caveat covering everything in the section. Two
         outlets rather than two copies of the sentence, because a duplicated
         $localize id is a translation bug waiting to happen. -->
    <ng-template #reachLine>
      @if (reachableCount() > 0) {
        <p class="text-sm text-(--text-secondary)">{{ reachLabel() }}</p>
      }
    </ng-template>
  `,
})
export class ProductIntegrationsSection {
  /** This page's product slug: the pair-page context on every row, and the
   *  target of both suggest-a-correction links. */
  readonly slug = input.required<string>();
  /** Edges where this product is the source endpoint. */
  readonly asSource = input.required<readonly ProductIntegrationItem[]>();
  /** Edges where this product is the target endpoint. */
  readonly asTarget = input.required<readonly ProductIntegrationItem[]>();
  /**
   * §13.7's reach count: how many MORE products this one could be joined to
   * through a connector, over and above the delivered edges in the two arrays
   * above. Server-computed (`reachable_pair_count`), because the subtraction it
   * needs spans two delivered tables in two orientations and the client sees
   * only one page's worth of that.
   *
   * Optional and zero-defaulted so a page with no connector data — every
   * non-production environment today — simply renders nothing.
   */
  readonly reachableCount = input(0);
  /** This page's product name, for the §13.3b empty-state line. */
  readonly productName = input('');
  /**
   * §13.3b (AECI-710): the hosts this product is built within
   * (`ProductDetail.extension_of`). Read ONLY by the empty state's one-sentence
   * pointer to "Built within". Never a lane, never a row, never counted.
   */
  readonly hosts = input<readonly ProductListItem[]>([]);

  /** "Enscape runs inside Revit; see Built within." or `null` when there is no host. */
  protected readonly builtWithinLine = computed(() => {
    const hosts = this.hosts();
    const name = this.productName();
    if (hosts.length === 0 || !name) return null;
    const hostList = formatNameList(
      hosts.map((h) => h.name),
      hosts.length,
    );
    return $localize`:@@products.detail.body.integrations.empty.builtWithin:${name}:name: runs inside ${hostList}:hosts:; see Built within.`;
  });

  /**
   * The reader's filter text (AECI-841). Component-local and deliberately NOT a
   * route query param: `/products/:slug` is a cacheable SSR route keyed on
   * path + query, so a `?q=` would mint an edge-cache entry per keystroke for
   * HTML that does not vary with it.
   */
  protected readonly query = signal('');

  /** The direction chips the reader pressed (AECI-1782). Component-local, like the query. */
  private readonly directions = signal<readonly ContextDirection[]>([]);

  /** The partner-category chips the reader pressed (AECI-1782). */
  private readonly categories = signal<readonly string[]>([]);

  /** The "Types of data" chips the reader pressed (AECI-1783, copy approved 2026-11-16). */
  private readonly dataObjects = signal<readonly string[]>([]);

  /**
   * Cards or table (AECI-1782). Cards by default, and the server always renders
   * cards. Component-local rather than `?view=`, for the query's reason: a view in
   * the URL would mint a second cache entry and a second crawlable URL for the same
   * rows.
   */
  protected readonly view = signal<ListingView>('cards');

  /** Lane card keys the reader has closed. */
  private readonly collapsed = signal<ReadonlySet<string>>(new Set<string>());

  /** The section as the data has it — the `<h2>` count, every "of N" total. */
  protected readonly lanes = computed(() =>
    splitIntegrationLanes(this.asSource(), this.asTarget()),
  );

  /**
   * The reader's whole filter, as one value. The data-object chips shipped with their
   * approved copy on 2026-11-16: the label "Types of data" and the note that rows with
   * no data object are left out (AECI-1816).
   */
  protected readonly filterState = computed<IntegrationFilterState>(() => ({
    query: this.query(),
    directions: this.directions(),
    dataObjects: this.dataObjects(),
    partnerCategories: this.categories(),
  }));

  /** A data chip is pressed: the note says rows with no data on record are left out. */
  protected readonly dataFilterActive = computed(() => this.dataObjects().length > 0);

  /** Any chip is pressed, whatever the search box holds. Picks the empty message. */
  protected readonly chipFilterActive = computed(
    () =>
      this.directions().length > 0 || this.categories().length > 0 || this.dataObjects().length > 0,
  );

  protected readonly filterActive = computed(() => isIntegrationFilterActive(this.filterState()));

  /** The same view with the reader's filter applied. */
  protected readonly filteredLanes = computed(() =>
    filterIntegrationLanes(this.lanes(), this.filterState()),
  );

  /**
   * The filtered view with the `@defer (on viewport)` boundary applied, over the
   * FLATTENED render order (§13.3). A filter raises the limit to the whole
   * filtered set — see the class note.
   */
  protected readonly laneCut = computed(() => {
    const view = this.filteredLanes();
    const limit = this.filterActive() ? view.rowCount : INTEGRATIONS_ABOVE_FOLD;
    return applyDeferCut(view, limit);
  });

  /**
   * AECI-1783: whether the section is long enough to group. Read from the unfiltered
   * lanes, so a filter never flips the layout.
   */
  protected readonly long = computed(() => isLongIntegrationList(this.lanes()));

  /** "By category" (the default, and what the server renders) or "One list". */
  protected readonly arrangement = signal<IntegrationArrangement>('grouped');

  /** The rows a direction chip counts: every filter except the direction chips. */
  private readonly directionCountRows = computed(() =>
    rowsForFacetCount(this.lanes(), this.filterState(), 'directions'),
  );

  /**
   * The rows a category chip counts: every filter except the category chips. The
   * groups are built from the same rows, so a group heading, its rail link and its
   * chip print one number.
   */
  private readonly categoryCountRows = computed(() =>
    rowsForFacetCount(this.lanes(), this.filterState(), 'partnerCategories'),
  );

  /** The long list's groups, A to Z by category name (R1), only the chosen ones when
   *  the reader pressed category chips. */
  protected readonly categoryGroups = computed(() =>
    groupRowsByCategory(this.categoryCountRows(), this.categories()),
  );

  /** A filter that leaves one page or less opens every group (mock-up 7). */
  protected readonly openAllGroups = computed(
    () => this.filterActive() && this.filteredLanes().rowCount <= ONE_LIST_PAGE_SIZE,
  );

  /**
   * Direction chips: only directions some row has, in vocabulary order. Each prints
   * how many rows it would show with the reader's other filters.
   */
  protected readonly directionChoices = computed(() => {
    const chosen = this.directions();
    const rows = this.directionCountRows();
    return directionOptions(this.lanes()).map((token) => {
      const { label, glyph } = contextDirectionLabel(token);
      return {
        token,
        label,
        glyph,
        selected: chosen.includes(token),
        count: countRowsWithDirection(rows, token),
      };
    });
  });

  /**
   * "Types of data" chips: the data objects the section's rows move, A to Z by name with
   * the slug breaking a tie (ruling R1, the chips' shared term order). Data chips AND together, so each
   * counts the rows the list would show with it pressed too.
   */
  protected readonly dataChoices = computed(() => {
    const chosen = this.dataObjects();
    const rows = allRows(this.filteredLanes());
    return dataObjectOptions(this.lanes()).map((term) => ({
      ...term,
      selected: chosen.includes(term.slug),
      count: countRowsMovingDataObject(rows, term.slug),
    }));
  });

  /** Partner-category chips: A to Z by name, slug breaking a tie (ruling R1). */
  protected readonly categoryChoices = computed(() => {
    const chosen = this.categories();
    const rows = this.categoryCountRows();
    return partnerCategoryOptions(this.lanes()).map((term) => ({
      ...term,
      selected: chosen.includes(term.slug),
      count: rowsInCategory(rows, term.slug).length,
    }));
  });

  protected toggleDirection(token: ContextDirection): void {
    this.directions.update((current) => toggleFacetValue(current, token));
  }

  protected toggleCategory(slug: string): void {
    this.categories.update((current) => toggleFacetValue(current, slug));
  }

  protected toggleDataObject(slug: string): void {
    this.dataObjects.update((current) => toggleFacetValue(current, slug));
  }

  /** "Clear filters": every facet and the query, back to the whole section. */
  protected clearFilters(): void {
    this.query.set('');
    this.directions.set([]);
    this.categories.set([]);
    this.dataObjects.set([]);
  }

  /**
   * The section heading: the bare word "Integrations", with no count. Ruled by Chris
   * on 2026-11-16: the facts card already shows the integration count, and on a
   * connector product the two numbers differ. The same message id as the section nav
   * link, so the heading and the link read alike. The filter's own "Showing 3 of 12"
   * line still reports the view, and the group and chip counts are unchanged.
   */
  protected readonly heading = computed(
    () => $localize`:@@products.detail.nav.integrations:Integrations`,
  );

  /**
   * The filter renders whenever the section renders rows — there is no row
   * threshold. See `integration-filter.ts` for why the ten-row gate went: on a
   * connector page the two integration sections sit next to each other, and the
   * same control appearing over one and not the other reads as a bug.
   */
  protected readonly showFilter = computed(() => this.lanes().rowCount > 0);

  /**
   * §13.7's sentence, built in TS for the same reason `countLabel()` is: the
   * singular and plural are separate message ids, not an ICU plural, which is
   * the idiom this component already uses.
   *
   * FOUR ids rather than two. On a section with no delivered rows there is
   * nothing for the reach to be MORE than, and shipping "3 more pairs" above an
   * empty-integrations notice contradicts the screen it sits on. That is the
   * exact page the AECI-889 sweep creates, so it is not an edge case.
   */
  protected readonly reachLabel = computed(() => {
    const count = this.reachableCount();
    if (this.lanes().rowCount === 0) {
      return count === 1
        ? $localize`:@@products.detail.body.integrations.reach.only.one:1 pair reachable via connectors`
        : $localize`:@@products.detail.body.integrations.reach.only:${count}:COUNT: pairs reachable via connectors`;
    }
    return count === 1
      ? $localize`:@@products.detail.body.integrations.reach.more.one:1 more pair reachable via connectors`
      : $localize`:@@products.detail.body.integrations.reach.more:${count}:COUNT: more pairs reachable via connectors`;
  });

  protected readonly directHeading = computed(
    () => $localize`:@@products.detail.body.integrations.lane.direct:Direct integrations`,
  );

  /**
   * An active filter opens every surviving card, whatever the reader closed
   * earlier: a search that matched rows inside a collapsed card would report
   * "Showing 3 of 40" over an empty screen. Clearing the query restores the
   * reader's own collapsed set rather than discarding it.
   */
  protected isExpanded(key: string): boolean {
    return this.filterActive() || !this.collapsed().has(key);
  }

  protected toggle(key: string): void {
    this.collapsed.update((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  /** This lane's UNFILTERED row count, for the "3 of 12" label. */
  protected viaTotal(key: string): number {
    return this.lanes().via.find((group) => group.key === key)?.rows.length ?? 0;
  }

  /**
   * Group size. Plain while the section is whole; "3 of 12" under a filter, so a
   * reader can tell a small lane from a heavily filtered large one.
   */
  protected countLabel(shown: number, total: number): string {
    if (shown !== total) {
      return $localize`:@@products.detail.group.count.filtered:${shown}:SHOWN: of ${total}:TOTAL:`;
    }
    if (total === 1) {
      return $localize`:@@products.detail.body.integrations.group.count.one:1 integration`;
    }
    return $localize`:@@products.detail.body.integrations.group.count:${total}:count: integrations`;
  }

  /**
   * "Via {connector}", or §13.2(c)'s unnamed heading.
   *
   * Built in TS rather than as a template message with an inline `<a>`, because
   * the card header is now a button and a link cannot nest inside one. The
   * connector's page is still one click away — it moved to the card's trailing
   * link — so the return path §13.3 asks for survives.
   *
   * §13.2(c): connector-delivered, but its connector has no product record to
   * name. NEVER invent one.
   */
  protected viaHeading(lane: ConnectorLaneGroup): string {
    const connector = lane.connector;
    if (!connector) {
      return $localize`:@@products.detail.body.integrations.lane.via.unnamed:Via a connector`;
    }
    return $localize`:@@products.detail.body.integrations.lane.via.named:Via ${connector.name}:NAME:`;
  }

  protected viaLink(lane: ConnectorLaneGroup): string | null {
    return lane.connector ? '/products/' + lane.connector.slug : null;
  }

  /**
   * Accessible name for the trailing connector link. Built in TS because an
   * interpolated `i18n-*` attribute emits no attribute at all in this app, and
   * because the visible "View product" repeats on every card, so the name has
   * to say which product. It starts with that visible text, so WCAG 2.5.3
   * Label in Name holds and a speech-input user can say what they can read.
   * The link stays in the tab (AECI-1125), so the name no longer announces one.
   */
  protected viaLinkAriaLabel(lane: ConnectorLaneGroup): string {
    const connector = lane.connector;
    if (!connector) return '';
    return $localize`:@@products.detail.group.link.name:View product: ${connector.name}:NAME:`;
  }
}
