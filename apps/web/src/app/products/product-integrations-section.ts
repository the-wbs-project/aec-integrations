import { NgTemplateOutlet } from '@angular/common';
import { Component, ElementRef, computed, input, signal, viewChild } from '@angular/core';

import type {
  ContextDirection,
  ProductDetail,
  ProductIntegrationItem,
  ProductListItem,
} from '@aeci/shared';

import type { ExternalLinkContext } from '../analytics/analytics';
import { ExternalLinkTracker } from '../analytics/external-link-tracker';
import { formatNameList } from '../core/meta.helpers';
import { RequestTrigger } from '../requests/request-trigger';
import { directionFilterLabel } from '../search/mechanism-labels';

import { directionGlyph } from './pair-direction-labels';
import { AecButton } from '../shared/button/button';
import { AecCard } from '../shared/card/card';
import { Chip } from '../shared/chip/chip';
import { integrationsZeroCaveat, integrationsZeroHeading } from '../shared/figure/figure';
import { correctionsInSlots } from '../shared/field-caption/field-caption-facts';
import { AecIcon } from '../shared/icon/icon';
import type { ListingView } from '../shared/listing-toolbar/listing-toolbar';
import { ListingViewToggle } from '../shared/listing-toolbar/listing-view-toggle';
import { NewTabIcon } from '../shared/new-tab-icon/new-tab-icon';

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
  INTEGRATION_SEARCH_MIN_ROWS,
  INTEGRATION_VIEW_TOGGLE_MIN_ROWS,
  chipsThatNarrow,
  isIntegrationFilterActive,
  partnerCategoryOptions,
  rowsForFacetCount,
  toggleFacetValue,
  type IntegrationFilterState,
} from './integration-filter';
import {
  INTEGRATION_CLEAR_CLASS,
  INTEGRATION_FILTER_PANEL_CLASS,
  INTEGRATION_LIST_HEADING_CLASS,
  INTEGRATION_LIST_ROW_CLASS,
  INTEGRATION_LIST_ROW_END_CLASS,
  INTEGRATION_SEARCH_ICON_CLASS,
  INTEGRATION_SEARCH_INPUT_CLASS,
  INTEGRATION_STATUS_CLASS,
} from './integration-filter-recipe';
import { IntegrationGroupCard } from './integration-group-card';
import {
  hasNoIntegrationsOnRecord,
  showsNoIntegrationsDirectory,
  withoutTrailingFullStop,
} from './integrations-on-record';
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
 * orders, and the direct lane is already A to Z by the partner product's name with
 * the id last. The order line under the `<h2>` says so, "A to Z by product name."
 * (AECI-2021, ruled 2026-11-23), on a page with no Via lane and two rows or more.
 *
 * **A control shows only when it can change the list** (AECI-2021, ruled 2026-11-23).
 * A chip shows only when its count over the UNFILTERED rows is less than the row total,
 * so pressing it would hide a row. The test reads the unfiltered rows, so chips never
 * come and go as the reader filters, and a pressed chip always stays, so it can be
 * released. A direction group with no such chip drops whole, "Any direction" included,
 * and an empty data or category row drops with its label. The search box needs
 * {@link INTEGRATION_SEARCH_MIN_ROWS} rows and the Cards/Table toggle
 * {@link INTEGRATION_VIEW_TOGGLE_MIN_ROWS}. A panel with no control left does not
 * render, and neither does the list row under it. The section has no list heading of
 * its own since the same ruling: the `<h2>` heads the list.
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
 * chrome with a button on it. So the cards there are `<h3>`, and in a long list a
 * category group heading is `<h3>` and its cards `<h4>` (AECI-2021). On a page with a
 * Via lane each lane card's heading is the `<h3>` and its cards are `<h4>`.
 *
 * ── THE `@defer` CUT ────────────────────────────────────────────────────────────
 * Table view only since AECI-1891: the card view renders every row eagerly (see
 * `laneCut`). In the table, past 20 rows the remainder ships as deferred `<tr>`s in an
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
    AecButton,
    AecCard,
    AecIcon,
    Chip,
    ExternalLinkTracker,
    IntegrationArrangementToggle,
    IntegrationGroupCard,
    ListingViewToggle,
    NewTabIcon,
    NgTemplateOutlet,
    ProductIntegrationCards,
    ProductIntegrationGroups,
    ProductIntegrationOneList,
    ProductIntegrationsTable,
    RequestTrigger,
  ],
  template: `
    @if (zero(); as p) {
      <!-- AECI-1786: no integrations on record (mock-up 8). The words are the legal-reviewed
           strings of PLAN.md section 5.2, used exactly. Text only: no illustration (ruling
           R5) and no category chart (ruling R3, decision 19). With no rows there is no
           filter panel, no Cards or Table toggle and no scope note. -->
      <!-- AECI-1720 (mock-up 8, .band-head): the kicker and the heading on the left, the
           caveat on the right from lg. The mock-up's third caveat sentence, on when we
           list an integration, is a promise that waits for Chris, so it is not built. -->
      <div
        class="grid gap-x-12 gap-y-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-start"
        data-testid="integrations-zero-head"
      >
        <div class="min-w-0">
          <p
            class="aec-overline mb-3 text-(--text-secondary)"
            data-testid="integrations-kicker"
            i18n="@@products.detail.body.integrations.kicker"
          >
            Integrations on record
          </p>
          <h2 id="integrations-title" class="text-balance" data-testid="integrations-zero-heading">
            <span
              class="font-display text-t-24 leading-tight font-semibold tracking-[-0.02em] text-(--text-primary) md:text-t-36"
              >{{ zeroHeading() }}</span
            >
          </h2>
        </div>
        <div class="min-w-0 space-y-4 lg:pt-8">
          <p
            class="max-w-prose text-t-16 leading-relaxed text-(--text-primary) md:text-t-20"
            data-testid="integrations-zero-caveat"
          >
            {{ zeroCaveat }}
          </p>
          @if (builtWithinLine(); as line) {
            <p class="max-w-prose text-t-16 text-(--text-secondary)">{{ line }}</p>
          }
        </div>
      </div>

      <div
        class="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:items-stretch"
        data-testid="integrations-zero-grid"
      >
        <!-- AECI-1720 restore C (mock-up 8, .know): the page's one Forest feature card
             (DESIGN.md §2 "A Forest feature card"). A card, never a band: rounded-card,
             the card shadow, Forest fill, Bone ink, 32px padding (24px below md), and the
             Bone main button pinned to its foot. No illustration (ruling R5). The product
             page carries no other Forest feature card, so it stays one per page.
             Ruling 51, option A (2026-11-16): the heading and the line the legal review
             relied on sit directly above the button, as one group. The words are the ones
             STAGE_1_5_SPEC.md section 11.4 approved for the empty pair page. The line is
             also the button's description, so a screen reader hears what it is for. -->
        <div
          class="aec-card flex min-w-0 flex-col gap-4 rounded-card border bg-(--accent-primary) p-6 text-(--text-on-brand) shadow-card md:p-8"
          data-testid="integrations-zero-know"
        >
          <h3 class="text-(--text-on-brand)">
            <span
              class="font-display text-t-24 leading-tight font-semibold"
              i18n="@@products.detail.body.integrations.zero.knowHeading"
              >Know of one?</span
            >
          </h3>
          <p
            id="integrations-zero-know-line"
            class="max-w-[30em] text-t-16 text-(--text-on-brand-secondary)"
            data-testid="integrations-zero-know-line"
            i18n="@@products.detail.body.integrations.zero.knowLine"
          >
            Tell us where you saw it and we will look at it.
          </p>
          <!-- The existing correction request, the same trigger as every "suggest a
               correction" link: the drawer in the browser, the routed form without
               JavaScript or on a modified click. -->
          <div class="mt-auto pt-4">
            <a
              aecButton
              variant="on-brand"
              aecRequestTrigger
              class="max-md:w-full"
              [entity]="'product'"
              [kind]="'correction'"
              [slug]="p.slug"
              [href]="'/products/' + p.slug + '/correction'"
              aria-describedby="integrations-zero-know-line"
              data-testid="integrations-zero-correction"
            >
              <ng-container i18n="@@products.detail.body.integrations.zero.exists"
                >It does exist</ng-container
              >
              <aec-icon name="arrow-right" class="rtl:-scale-x-100" decorative [size]="4" />
            </a>
          </div>
        </div>

        <!-- The vendor's own links, the same fields and labels as the facts card's
             Resources group, with the two notes that keep an API from reading as an
             integration. -->
        <div aecCard class="min-w-0 space-y-4 p-6" data-testid="integrations-zero-vendor">
          @if (p.tool_integrations_url || p.api_docs_url) {
            <!-- AECI-1720 (mock-up 8): "From {vendor}" and one neutral line, only while
                 both say something true: the product has a vendor and no link shown here
                 carries AECi's "Corrected by" caption. A corrected link is AECi's value,
                 not the vendor's. Otherwise the facts card's "Resources". -->
            <div class="space-y-2">
              <h3 id="integrations-zero-resources" class="aec-overline text-(--text-secondary)">
                <span class="flex items-center gap-2">
                  <aec-icon name="book" decorative [size]="4" />
                  @if (vendorSourced(p) && p.vendor; as v) {
                    <span data-testid="integrations-zero-vendor-heading">{{
                      fromVendorLabel(v.name)
                    }}</span>
                  } @else {
                    <span i18n="@@products.detail.metadata.resources">Resources</span>
                  }
                </span>
              </h3>
              @if (vendorSourced(p)) {
                <p
                  class="text-t-14 text-(--text-secondary)"
                  data-testid="integrations-zero-vendor-intro"
                >
                  {{ vendorPublishesLabel(p.name) }}
                </p>
              }
            </div>
            <ul class="m-0 grid list-none gap-1 p-0" aria-labelledby="integrations-zero-resources">
              @if (p.tool_integrations_url) {
                <li>
                  <a
                    [href]="p.tool_integrations_url"
                    target="_blank"
                    rel="noopener nofollow"
                    aecTrackExternalLink="product_detail"
                    [aecLinkContext]="docsLinkContext(p, 'listing')"
                    [class]="resourceLinkClass"
                  >
                    <span [class]="resourceTileClass"
                      ><aec-icon name="grid" decorative [size]="4"
                    /></span>
                    <span class="min-w-0 flex-1" i18n="@@products.detail.metadata.integrationsPage"
                      >Integrations page</span
                    >
                    <span class="text-(--text-secondary)"><aec-new-tab-icon /></span>
                  </a>
                </li>
              }
              @if (p.api_docs_url) {
                <li>
                  <a
                    [href]="p.api_docs_url"
                    target="_blank"
                    rel="noopener nofollow"
                    aecTrackExternalLink="product_detail"
                    [aecLinkContext]="docsLinkContext(p, 'docs')"
                    [class]="resourceLinkClass"
                  >
                    <span [class]="resourceTileClass"
                      ><aec-icon name="code" decorative [size]="4"
                    /></span>
                    <span class="min-w-0 flex-1" i18n="@@products.detail.metadata.apiDocs"
                      >API documentation</span
                    >
                    <span class="text-(--text-secondary)"><aec-new-tab-icon /></span>
                  </a>
                </li>
              }
            </ul>
          }
          <p
            class="flex gap-2 rounded-panel bg-(--accent-warm) p-4 text-t-14 leading-normal text-(--text-primary)"
            data-testid="integrations-zero-api-note"
          >
            <aec-icon name="info" class="mt-1 shrink-0" decorative [size]="4" />
            <span i18n="@@products.detail.body.integrations.zero.apiNote"
              >An API is not an integration. We list an integration only when we can show that one
              exists.</span
            >
          </p>
          @if (noDirectoryLine(); as line) {
            <p
              class="flex gap-2 rounded-panel bg-(--surface-sunken) p-4 text-t-14 leading-normal text-(--text-secondary)"
              data-testid="integrations-zero-no-directory"
            >
              <aec-icon name="info" class="mt-1 shrink-0" decorative [size]="4" />
              <span>{{ line }}</span>
            </p>
          }
        </div>
      </div>
    } @else {
      <!-- AECI-1720 (mock-up 6, .band-head): the kicker over the heading. The kicker is a
           paragraph, not a heading. The heading stays "Integrations" with no count (ruled
           2026-11-16), and the mock-up's "N of N integrations shown" badge is not built:
           it is the section's row count, which can differ from the facts card's figure
           (a stored count that lags, a connector's powered edges), the problem the
           ruling closed. The mock-up's intro line makes a promise about evidence and
           waits for Chris, so it is not built. -->
      <div data-testid="integrations-head">
        <div class="min-w-0">
          <p
            class="aec-overline mb-3 text-(--text-secondary)"
            data-testid="integrations-kicker"
            i18n="@@products.detail.body.integrations.kicker"
          >
            Integrations on record
          </p>
          <h2 id="integrations-title" class="text-balance">
            <span [class]="headingClass">{{ heading() }}</span>
          </h2>
          <!-- The order line (approved 2026-11-16, reworded AECI-2021, ruled 2026-11-23).
               Only where it is true of every row: a page with a Via lane orders its
               connector groups by row count (R1), so it shows only on a page with no Via
               lane. Grouped or not, the rows run A to Z by the partner product's name. One
               row has no order to state, so the line needs two rows or more. -->
          @if (lanes().rowCount > 1 && lanes().via.length === 0) {
            <p
              class="mt-4 text-t-16 text-(--text-secondary)"
              data-testid="integrations-order"
              i18n="@@products.detail.body.integrations.order.product"
            >
              A to Z by product name.
            </p>
          }
        </div>
      </div>
    }

    <!-- The filter panel (AECI-1782). Ruling R5 kept "integration filters in their
         own panel": one panel of its own, not the shared facet panel. Every control
         is a choice the reader makes, and the state never reaches the URL, so the
         server always renders the whole section. The agreement state is not a
         filter (ruling R1). AECI-2021 (ruled 2026-11-23): a control shows only when it
         can change the list, and a panel with no control left does not render. -->
    @if (showFilter()) {
      <!-- AECI-1720 (mock-up 6, .deck): one compact Bone panel. The top row holds the
           search box, the direction chips and the view toggles. Under it, one row each for
           the types of data and the partner categories, each label in its own column so
           wrapped chips line up after it. Below md each chip row is one line that scrolls
           sideways, as the mock-up does on a phone, instead of wrapping into a tall block.
           The panel's name "Filters" is kept for assistive tech only: the mock-up shows no
           heading here. From lg the top row is a flex row, so it lays out the same
           whichever of its three parts AECI-2021 leaves in it. The search box keeps a
           16rem basis and the row wraps, so long direction chips never crush it. -->
      <div
        #filterPanel
        role="group"
        aria-labelledby="integrations-filters-title"
        [class]="panelClass"
        data-testid="integrations-filter-panel"
      >
        <span id="integrations-filters-title" class="sr-only" i18n="@@listing.filters.title"
          >Filters</span
        >
        <div
          class="grid gap-3 lg:flex lg:flex-wrap lg:items-center lg:gap-4"
          data-testid="integrations-filter-top"
        >
          @if (searchVisible()) {
            <!-- The search box (mock-up 6, .sfield): the field recipe with a search glyph
               inside it, filling its column. The status lives in the list row below, so
               the panel holds no count. "Integrations it powers" uses the same recipe.
               AECI-2021: five rows or more, because a shorter list is read at a glance. -->
            <div
              class="relative min-w-0 lg:flex-[1_1_16rem]"
              data-testid="integrations-filter-search"
            >
              <label
                for="integrations-filter"
                class="sr-only"
                i18n="@@products.detail.body.integrations.filter.label"
                >Search these integrations</label
              >
              <span [class]="searchIconClass" aria-hidden="true">
                <aec-icon name="search" decorative [size]="4" />
              </span>
              <input
                #filterInput
                id="integrations-filter"
                type="search"
                autocomplete="off"
                [value]="query()"
                i18n-placeholder="@@products.detail.body.integrations.filter.placeholder"
                placeholder="Filter by product or connection"
                (input)="onQuery($event)"
                [class]="searchInputClass"
              />
            </div>
          }

          @if (directionChoices().length > 0) {
            <!-- AECI-1720 restore C (mock-up 6, #dirSeg): "Any direction" first, then the
                 page's product's words. Below md the four chips wrap two by two, as the
                 mock-up's phone layout does, so none hides off the edge. "Any direction"
                 is pressed while no direction chip is, and pressing it releases them.
                 Its count is every row the other filters keep, rows with no direction
                 on record included. AECI-2021: the group shows only while one direction
                 chip could hide a row, so "Any direction" never stands alone. -->
            <div
              role="group"
              aria-labelledby="integrations-filter-direction"
              [class]="directionRowClass"
              data-testid="integrations-filter-direction"
            >
              <span
                id="integrations-filter-direction"
                class="sr-only"
                i18n="@@search.facet.direction"
                >Direction</span
              >
              <aec-chip
                class="shrink-0"
                [selected]="directions().length === 0"
                (activated)="clearDirections()"
                data-testid="integrations-filter-direction-any"
              >
                {{ anyDirectionLabel }}
                <span class="font-normal tabular-nums" data-testid="integrations-chip-count">{{
                  directionCountRows().length
                }}</span>
              </aec-chip>
              @for (choice of directionChoices(); track choice.token) {
                <aec-chip
                  class="shrink-0"
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

          @if (arrangementVisible() || viewToggleVisible()) {
            <!-- AECI-2021: Cards and Table need two rows or more to differ. -->
            <div class="flex flex-wrap items-center gap-2 lg:ms-auto lg:shrink-0">
              @if (arrangementVisible()) {
                <aec-integration-arrangement-toggle
                  [arrangement]="arrangement()"
                  (arrangementChange)="arrangement.set($event)"
                />
              }
              @if (viewToggleVisible()) {
                <aec-listing-view-toggle [view]="view()" (viewChange)="view.set($event)" />
              }
            </div>
          }
        </div>

        @if (dataChoices().length > 0) {
          <div [class]="rowClass">
            <span
              id="integrations-filter-data"
              [class]="rowLabelClass"
              i18n="@@products.detail.body.integrations.dataTypes"
              >Types of data</span
            >
            <div class="min-w-0 space-y-2">
              <div
                role="group"
                aria-labelledby="integrations-filter-data"
                [attr.aria-describedby]="
                  dataFilterActive() ? 'integrations-filter-data-note' : null
                "
                [class]="chipRowClass"
                data-testid="integrations-filter-data"
              >
                @for (choice of dataChoices(); track choice.slug) {
                  <aec-chip
                    class="shrink-0"
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
                   live region is always present, so the note is announced as it appears.
                   Empty, it takes no room. -->
              <p class="text-sm text-(--text-secondary) empty:hidden" aria-live="polite">
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
          </div>
        }

        @if (categoryChoices().length > 0) {
          <div [class]="rowClass">
            <span
              id="integrations-filter-categories"
              [class]="rowLabelClass"
              i18n="@@products.detail.body.integrations.filter.partnerCategory"
              >Partner category</span
            >
            <div
              role="group"
              aria-labelledby="integrations-filter-categories"
              [class]="chipRowClass"
              data-testid="integrations-filter-categories"
            >
              @for (choice of categoryChoices(); track choice.slug) {
                <aec-chip
                  class="shrink-0"
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
          </div>
        }
      </div>

      <!-- The list row (mock-up 6, .lane-row): the view's count as a status message, and
           "Clear filters" while anything filters. AECI-2021 (ruled 2026-11-23) removed
           the list's own heading, so the section h2 heads the list. Idle, the row holds
           only the empty status, so it is visually hidden and takes no room. It stays in
           the accessibility tree, so the first change is still announced. -->
      <div [class]="filterActive() ? listRowClass : 'sr-only'" data-testid="integrations-list-row">
        <div [class]="listRowEndClass">
          <p role="status" [class]="statusClass" data-testid="integrations-status">
            {{ statusLabel() }}
          </p>
          @if (filterActive()) {
            <button
              type="button"
              [class]="clearClass"
              (click)="clearFilters()"
              data-testid="integrations-filter-clear"
            >
              <aec-icon name="x" decorative [size]="3.5" />
              <span i18n="@@listing.filters.clear">Clear filters</span>
            </button>
          }
        </div>
      </div>
    }

    @if (lanes().rowCount === 0) {
      <!-- With the zero state above this branch is empty. It still serves a section with no
           endpoint rows on a page that has integrations elsewhere, such as a connector
           that only powers edges. -->
      @if (!zero()) {
        <!-- AECI-2050: on a page that powers pairs, "No integrations recorded yet" is
             false, because "Integrations it powers" lists them. That page keeps only the
             Built within sentence, and no box at all when it has no host. -->
        @if (!powersPairs() || builtWithinLine()) {
          <div
            class="space-y-2 rounded-panel border border-dashed border-(--border-default)
              bg-(--surface-sunken) p-6 text-sm text-(--text-secondary)"
            data-testid="integrations-empty"
          >
            <!-- §13.3b (AECI-710): an extension usually has no integrations with its
               host, because it runs inside it. Say so where the reader is looking,
               in one sentence, and point at the sidebar card that carries the host.
               Only on the EMPTY branch: a populated section needs no excuse. -->
            @if (builtWithinLine(); as line) {
              <p>{{ line }}</p>
            }
            @if (!powersPairs()) {
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
            }
          </div>
        }
        <ng-container [ngTemplateOutlet]="reachLine" />
      }
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
                [nested]="true"
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
                [nested]="true"
              />
            }
          </aec-integration-group-card>
        }
      }

      @if (filteredLanes().rowCount === 0) {
        <!-- Chips, with or without a search, take the filters message (approved
             2026-11-16). A search alone keeps the search message. -->
        <p
          class="rounded-panel border border-dashed border-(--border-default)
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
  /**
   * AECI-1786: the whole product, read ONLY to decide and render the zero state (no
   * integrations on record anywhere on the page) with the vendor's own links. Optional, so
   * a caller without it keeps the existing empty state.
   */
  readonly product = input<ProductDetail | null>(null);
  /**
   * AECI-2050: how many pairs the page lists under "Integrations it powers"
   * (the page's powered view, pair count). Read ONLY by the empty branch, which
   * must not say "No integrations recorded yet" beside that list. Zero-defaulted, so
   * a caller without it keeps the existing empty state.
   */
  readonly poweredPairCount = input(0);

  /** Whether the page lists at least one pair under "Integrations it powers". */
  protected readonly powersPairs = computed(() => this.poweredPairCount() > 0);

  /**
   * The product when the page has no integrations on record, else `null`.
   *
   * Never while the §13.7 reach line has pairs to report: the legal heading directly
   * above "N pairs reachable via connectors" reads as a contradiction. That page keeps
   * the plain empty state with the reach line, as it did before AECI-1786.
   */
  protected readonly zero = computed(() => {
    const p = this.product();
    if (!p || this.reachableCount() > 0) return null;
    return hasNoIntegrationsOnRecord(p) ? p : null;
  });

  /** "We have no integrations for {product} on record", the figure's own message. */
  protected readonly zeroHeading = computed(() =>
    integrationsZeroHeading(this.zero()?.name ?? this.productName()),
  );

  protected readonly zeroCaveat = integrationsZeroCaveat();

  /** "We have not found an integrations page published by {vendor}.", or `null`. */
  protected readonly noDirectoryLine = computed(() => {
    const p = this.zero();
    if (!p?.vendor || !showsNoIntegrationsDirectory(p)) return null;
    // The sentence ends in its own full stop. A name that already ends in one
    // ("SiteLedger Inc.") gives that stop to the sentence, so it never prints "Inc..".
    // The legal-reviewed message is unchanged; only the value put into it is.
    const vendor = withoutTrailingFullStop(p.vendor.name);
    return $localize`:@@products.detail.body.integrations.zero.noDirectory:We have not found an integrations page published by ${vendor}:VENDOR:.`;
  });

  /**
   * Whether the zero state's link card may say the links come from the vendor
   * ("From {vendor}", "What the vendor publishes…"): the product has a vendor, and no
   * link the card shows carries a correction. A corrected link is a value AECi set, and
   * "About this listing" says so (AECI-1666), so the card must not call it the vendor's.
   * A link AECi hid for checking or removed is not shown, so it does not count.
   */
  protected vendorSourced(p: ProductDetail): boolean {
    if (!p.vendor) return false;
    const corrected = correctionsInSlots(p.captions?.corrections, {
      tool_integrations_url: !!p.tool_integrations_url,
      api_docs_url: !!p.api_docs_url,
    }).some((correction) => !correction.cleared);
    return !corrected;
  }

  /** "From {vendor}", the zero state's vendor card heading (mock-up 8). */
  protected fromVendorLabel(vendor: string): string {
    return $localize`:@@products.detail.body.integrations.zero.fromVendor:From ${vendor}:VENDOR:`;
  }

  /** The vendor card's line (mock-up 8): what the links under it are. */
  protected vendorPublishesLabel(name: string): string {
    const product = withoutTrailingFullStop(name);
    return $localize`:@@products.detail.body.integrations.zero.vendorPublishes:What the vendor publishes about connecting to ${product}:PRODUCT:.`;
  }

  /** The facts card's Resources link classes, so the two read as one pattern. */
  protected readonly resourceLinkClass =
    '-ms-2 flex items-center gap-3 rounded-control py-2 ps-2 pe-3 text-t-16 font-semibold text-(--text-primary) no-underline transition-colors duration-fast ease-standard hover:bg-(--surface-sunken) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

  protected readonly resourceTileClass =
    'grid size-8 shrink-0 place-items-center rounded-control bg-(--accent-primary-soft) text-(--accent-primary)';

  /** The same click context as the facts card's Resources links (AECI-1309). */
  protected docsLinkContext(p: ProductDetail, purpose: 'listing' | 'docs'): ExternalLinkContext {
    return {
      owner_vendor_id: p.vendor?.id ?? null,
      link_origin: 'vendor',
      source_entity_type: 'product',
      source_entity_id: p.id,
      link_purpose: purpose,
    };
  }

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
  protected readonly directions = signal<readonly ContextDirection[]>([]);

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
   *
   * **The card view has no cut (AECI-1891).** The server always renders cards, and
   * every card is already in its HTML, so the cut only deferred hydration. A filter
   * typed before the reader scrolled left the still-dehydrated tail in the DOM: stale
   * unfiltered cards under the filtered list. AECI-1783 removed the same cut from the
   * grouped list for the same reason. The table is only ever rendered in the browser,
   * so it keeps the cut.
   */
  protected readonly laneCut = computed(() => {
    const view = this.filteredLanes();
    const whole = this.filterActive() || this.view() === 'cards';
    const limit = whole ? view.rowCount : INTEGRATIONS_ABOVE_FOLD;
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
  protected readonly directionCountRows = computed(() =>
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
   * Every row of the section, unfiltered: what a chip's visibility is judged on
   * (AECI-2021, `chipsThatNarrow`), so a chip never comes and goes as the reader filters.
   */
  private readonly unfilteredRows = computed(() => allRows(this.lanes()));

  /**
   * Direction chips: only directions some row has, in vocabulary order, and only those
   * that can narrow the list (AECI-2021). Each prints how many rows it would show with
   * the reader's other filters.
   */
  protected readonly directionChoices = computed(() => {
    const chosen = this.directions();
    const rows = this.directionCountRows();
    const unfiltered = this.unfilteredRows();
    return chipsThatNarrow(
      directionOptions(this.lanes()),
      this.lanes().rowCount,
      (token) => countRowsWithDirection(unfiltered, token),
      (token) => chosen.includes(token),
    ).map((token) => {
      return {
        token,
        label: directionFilterLabel(token, this.productName()),
        glyph: directionGlyph(token),
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
    const unfiltered = this.unfilteredRows();
    return chipsThatNarrow(
      dataObjectOptions(this.lanes()),
      this.lanes().rowCount,
      (term) => countRowsMovingDataObject(unfiltered, term.slug),
      (term) => chosen.includes(term.slug),
    ).map((term) => ({
      ...term,
      selected: chosen.includes(term.slug),
      count: countRowsMovingDataObject(rows, term.slug),
    }));
  });

  /**
   * Partner-category chips: A to Z by name, slug breaking a tie (ruling R1), and only
   * those that can narrow the list (AECI-2021).
   */
  protected readonly categoryChoices = computed(() => {
    const chosen = this.categories();
    const rows = this.categoryCountRows();
    const unfiltered = this.unfilteredRows();
    return chipsThatNarrow(
      partnerCategoryOptions(this.lanes()),
      this.lanes().rowCount,
      (term) => rowsInCategory(unfiltered, term.slug).length,
      (term) => chosen.includes(term.slug),
    ).map((term) => ({
      ...term,
      selected: chosen.includes(term.slug),
      count: rowsInCategory(rows, term.slug).length,
    }));
  });

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected toggleDirection(token: ContextDirection): void {
    this.directions.update((current) => toggleFacetValue(current, token));
  }

  /** The direction filter's first chip (mock-up 6, `#dirSeg`). */
  protected readonly anyDirectionLabel = $localize`:@@products.detail.integrations.filter.direction.any:Any direction`;

  /** "Any direction": release every direction chip. */
  protected clearDirections(): void {
    this.directions.set([]);
  }

  protected toggleCategory(slug: string): void {
    this.categories.update((current) => toggleFacetValue(current, slug));
  }

  protected toggleDataObject(slug: string): void {
    this.dataObjects.update((current) => toggleFacetValue(current, slug));
  }

  /** The panel's search field, so "Clear filters" can hand focus back to it. */
  private readonly filterInput = viewChild<ElementRef<HTMLInputElement>>('filterInput');

  /** The panel, for the focus hand-off when it has no search field (AECI-2021). */
  private readonly filterPanel = viewChild<ElementRef<HTMLElement>>('filterPanel');

  /**
   * "Clear filters": every facet and the query, back to the whole section. The button
   * goes with the filter, so focus moves to the search field rather than falling to
   * the page body (AECI-1788, the same hand-off as "Integrations it powers"). A list
   * under five rows has no search field (AECI-2021), so focus goes to the panel's first
   * enabled button instead.
   */
  protected clearFilters(): void {
    this.query.set('');
    this.directions.set([]);
    this.categories.set([]);
    this.dataObjects.set([]);
    const input = this.filterInput()?.nativeElement;
    if (input) {
      input.focus();
      return;
    }
    this.filterPanel()
      ?.nativeElement.querySelector<HTMLButtonElement>('button:not([disabled])')
      ?.focus();
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

  /** The search box: {@link INTEGRATION_SEARCH_MIN_ROWS} rows or more (AECI-2021). */
  protected readonly searchVisible = computed(
    () => this.lanes().rowCount >= INTEGRATION_SEARCH_MIN_ROWS,
  );

  /** Cards and Table: {@link INTEGRATION_VIEW_TOGGLE_MIN_ROWS} rows or more (AECI-2021). */
  protected readonly viewToggleVisible = computed(
    () => this.lanes().rowCount >= INTEGRATION_VIEW_TOGGLE_MIN_ROWS,
  );

  /** "By category" and "One list": a long list in the card view (AECI-1783, unchanged). */
  protected readonly arrangementVisible = computed(() => this.long() && this.view() === 'cards');

  /**
   * The panel renders while any control in it can change the list (AECI-2021, ruled
   * 2026-11-23). Chris ruled this for this section, so "Integrations it powers" keeps
   * its own rule. A section with one row has no control left, so it has no panel.
   */
  protected readonly showFilter = computed(
    () =>
      this.lanes().rowCount > 0 &&
      (this.searchVisible() ||
        this.viewToggleVisible() ||
        this.arrangementVisible() ||
        this.directionChoices().length > 0 ||
        this.dataChoices().length > 0 ||
        this.categoryChoices().length > 0),
  );

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

  // AECI-1720: the filter panel's row recipes (mock-up 6, .deck-row and .deck .lead).
  /** A labelled chip row: the label above below md, in its own 8.5rem column from md. */
  // The mock-up 6 recipe, shared with "Integrations it powers" (AECI-1788).
  protected readonly headingClass = INTEGRATION_LIST_HEADING_CLASS;
  protected readonly panelClass = INTEGRATION_FILTER_PANEL_CLASS;
  protected readonly searchIconClass = INTEGRATION_SEARCH_ICON_CLASS;
  protected readonly searchInputClass = INTEGRATION_SEARCH_INPUT_CLASS;
  protected readonly listRowClass = INTEGRATION_LIST_ROW_CLASS;
  protected readonly listRowEndClass = INTEGRATION_LIST_ROW_END_CLASS;
  protected readonly statusClass = INTEGRATION_STATUS_CLASS;
  protected readonly clearClass = INTEGRATION_CLEAR_CLASS;

  protected readonly rowClass =
    'grid gap-2 md:grid-cols-[8.5rem_minmax(0,1fr)] md:items-start md:gap-4';
  /** The row label: an overline, centred on the first line of 44px chips from md. */
  protected readonly rowLabelClass = 'aec-overline text-(--text-secondary) md:pt-3';
  /**
   * The chips: one line that scrolls sideways below md, wrapping from md. The padding,
   * cancelled by a negative margin, keeps each chip's 3px focus ring at 3px inside the
   * scroller, which would otherwise clip it.
   */
  /**
   * The direction chips (AECI-1720 restore C): two by two below md, as mock-up 6 lays out
   * its four direction choices on a phone, so the row never scrolls a choice out of view.
   * From md they wrap like the other chip rows.
   */
  protected readonly directionRowClass =
    'grid min-w-0 grid-cols-2 items-center gap-2 md:flex md:flex-wrap';

  protected readonly chipRowClass =
    '-m-1.5 flex min-w-0 items-center gap-2 overflow-x-auto p-1.5 max-md:flex-nowrap md:flex-wrap md:overflow-visible';

  /**
   * "Showing 4 of 14", the list row's status while anything filters. The filter box's
   * own message id and rule: empty while nothing filters, as on "Integrations it
   * powers" (the Same-Behavior Rule). An idle "Showing 58 of 58" would be
   * the section's row count, which can differ from the facts card's figure, the count
   * the heading was ruled not to carry (2026-11-16). The region stays in the DOM so
   * the first change is announced.
   */
  protected readonly statusLabel = computed(() => {
    if (!this.filterActive()) return '';
    const shown = this.filteredLanes().rowCount;
    const total = this.lanes().rowCount;
    return $localize`:@@products.detail.filter.status:Showing ${shown}:SHOWN: of ${total}:TOTAL:`;
  });

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
