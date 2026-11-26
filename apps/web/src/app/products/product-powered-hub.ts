import { Component, ElementRef, computed, input, signal, viewChild } from '@angular/core';
import { RouterLink } from '@angular/router';

import { defaultIntegrationContext, type ConnectorKind } from '@aeci/shared';

import { RequestTrigger } from '../requests/request-trigger';
import type { ListingView } from '../shared/listing-toolbar/listing-toolbar';
import { ListingViewToggle } from '../shared/listing-toolbar/listing-view-toggle';
import {
  dataObjectCountLabel,
  mechanismDisplay,
  mechanismKindLabel,
} from '../search/mechanism-labels';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';

import { sharedRowColumns } from './integration-category-groups';
import { filterPoweredHubView, isFilterActive } from './integration-filter';
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
import {
  MATCH_CARD_COMPACT_BODY_CLASS,
  MATCH_CARD_GO_CLASS,
  MATCH_CHIP_CLASS,
  MATCH_CHIP_ROW_CLASS,
} from './match-card-recipe';
import { IntegrationGroupCard } from './integration-group-card';
import { poweredEmptyLead, poweredHeading } from './connector-kind-labels';
import { directionGlyph, pairFlowSentence } from './pair-direction-labels';
import { ProductPoweredTable, type PoweredTableRow } from './product-powered-table';

import type { PoweredConnection, PoweredHubPartner, PoweredHubView } from './powered-hub-grouping';
import { AecCard } from '../shared/card/card';
import { AecIcon } from '../shared/icon/icon';

/**
 * Stage 1.5 Addendum B — the "Integrations it powers" section on a
 * connector-role product's detail page.
 *
 * A connector (`product_role: 'connector'`, e.g. Agave ERP Sync) exists to link
 * other products to each other. Those edges hang off
 * `integrations.powered_by_product_id`, so the connector is neither endpoint and
 * the endpoint-oriented `#integrations` table on the same page is legitimately
 * empty — which read as "this product integrates with nothing", the exact
 * opposite of the truth. This section is that missing surface.
 *
 * **Cards, not chips.** The first cut rendered a fill-in-the-blank heading
 * ("Connects {hub} with") over a row of name-only chips. That broke three ways:
 * the heading was a sentence fragment (screen readers announced a trailing
 * preposition; the split string can't hold word order under translation), the
 * chips carried none of the mechanism/direction detail the sibling endpoint
 * table shows for the same edges, and `--surface-raised` chips on
 * `--surface-base` sit at 1.03:1 — visually absent. So: one bordered card per
 * hub, its name a real noun-phrase heading, and full-width partner rows with
 * the same logo + direction + mechanism vocabulary as `ProductIntegrationRow`.
 * The two sections now read as siblings, which is what they are.
 *
 * **Since AECI-841 the card is shared and collapsible.** The shape moved into
 * `IntegrationGroupCard`, which the endpoint section now uses too, and each card
 * header is a disclosure control. Cards open by default: collapsing is a reader
 * action, so the SSR HTML, the crawler and a no-JS reader all still see every
 * row. The hub name moved off the heading and onto a compact trailing link,
 * because a link cannot nest inside the header button — see the component's own
 * note, and ADR 0010 for why this is not the Angular Aria accordion.
 *
 * Pairs that share no hub land in a trailing flat card — see
 * `groupPoweredIntegrations`, which also explains why the hub is chosen once
 * per product rather than per edge.
 *
 * **Since AECI-848 it is the whole `#powered-integrations` section, not just
 * the cards.** It
 * owns the `<h2>`, the empty state, the filter and the catalog-scope note, and
 * it renders through an attribute selector on the page's real `<section>` —
 * the same shape the sibling `ProductIntegrationsSection` takes. The heading
 * had to come down here for the filter to sit beside it in one row; once the
 * heading moved, the empty state (which also needs it) followed, and the two
 * sections stopped being assembled two different ways.
 *
 * The grouped view is still computed by the PAGE and passed in, because
 * `showPowered()`, `leadWithPowered()` and the section-nav all read the same
 * pair count.
 *
 * Every row links the canonical product-PAIR page for its pair
 * (`defaultIntegrationContext` picks the context slug, matching
 * the `/integrations/:id` 301 target, so
 * we never link the redirecting orientation), where the mechanism cards —
 * including this connector's own "Powered by" byline — live. One link per row,
 * so there is no stretched-link overlay to manage: the partner's own product
 * page is one hop further, from the pair page.
 *
 * No `@defer`: even at 50+ edges this is a handful of anchors, so the
 * deferred-block machinery the endpoint table needs would cost more than it
 * saves. It also keeps this list clear of AECI-1891: with no deferred tail, a
 * filter typed before the reader scrolls leaves nothing stale behind.
 *
 * **Since AECI-1788 the rows are cards** in the Integrations section's language: the
 * filter in a sunken "Filters" panel under the `<h2>`, and each pair a nested
 * `aecCard` in the shared card grid inside its group card, as the Via lane cards are.
 * The content, the conditions, the order and the words are the row's. Each card is
 * still the row's one link to the pair page with the same accessible name, so no
 * heading and no partner link were added. Below `md` the row folded the mechanism and
 * the data-object count into its meta line. A card has room for its chips at every
 * width, so the chips show at every width and the fold went. Every card's direction
 * names both products (`pairFlowSentence`, QA pass on AECI-2035): "{A} sends to {B}" or
 * "{A} and {B} sync both ways", the hub first on a hub card, and on a hubless card the
 * endpoint it prints first.
 *
 * **Since AECI-1924 each group can be a table.** One Cards and Table toggle in the panel
 * sets every group, as the Integrations section's one toggle sets every Via lane. The
 * table (`ProductPoweredTable`) lists the same rows in the same order, with the card's
 * words, worked out here by the card's own helpers. Cards are the default and the only
 * view in the server HTML.
 */
@Component({
  // Attribute selector on the page's real <section>, matching the sibling
  // `ProductIntegrationsSection`. A wrapper custom element would push
  // #powered-integrations one level deeper and demote the labelled region to a
  // plain div, and the `aria-labelledby` on it would then name a heading in a
  // different element.
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'section[aec-product-powered-hub]',
  imports: [
    AecCard,
    AecIcon,
    RouterLink,
    LogoOrInitial,
    IntegrationGroupCard,
    ListingViewToggle,
    ProductPoweredTable,
    RequestTrigger,
  ],
  template: `
    <h2 id="powered-integrations-title" class="text-balance">
      <span [class]="headingClass">{{ heading() }}</span>
    </h2>

    <!-- The Integrations section's panel and list row (mock-up 6, AECI-1720), from the
         same recipe (integration-filter-recipe.ts), ruled 2026-11-17: two filter panels
         on one page look and behave alike. This list has no chips, so the panel holds the
         search box and, since AECI-1924, the Cards and Table toggle. The panel's name
         "Filters" is kept for assistive tech only. The list row has no heading of its
         own: each hub card carries one, as each Via lane card does in the Integrations
         section. -->
    @if (showFilter()) {
      <div
        role="group"
        aria-labelledby="powers-filters-title"
        [class]="panelClass"
        data-testid="powers-filter-panel"
      >
        <span id="powers-filters-title" class="sr-only" i18n="@@listing.filters.title"
          >Filters</span
        >
        <!-- The top row, as in the Integrations panel: the search box fills the first
             column and the view toggle sits after it from lg. -->
        <div
          class="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center lg:gap-4"
          data-testid="powers-filter-top"
        >
          <div class="relative min-w-0" data-testid="powers-filter-search">
            <label
              for="powers-filter"
              class="sr-only"
              i18n="@@products.detail.body.powers.filter.label"
              >Search these connections</label
            >
            <span [class]="searchIconClass" aria-hidden="true">
              <aec-icon name="search" decorative [size]="4" />
            </span>
            <input
              #filterInput
              id="powers-filter"
              type="search"
              autocomplete="off"
              [value]="query()"
              i18n-placeholder="@@products.detail.body.powers.filter.placeholder"
              placeholder="Filter by product or connection"
              (input)="onQuery($event)"
              [class]="searchInputClass"
            />
          </div>
          <!-- AECI-1924: Cards or Table, the Integrations section's toggle. One toggle
               sets every hub, as the Integrations section's one toggle sets every Via
               lane (the Same-Behavior Rule). -->
          <div class="flex flex-wrap items-center gap-2">
            <aec-listing-view-toggle [view]="viewMode()" (viewChange)="viewMode.set($event)" />
          </div>
        </div>
      </div>
      <div [class]="listRowClass" data-testid="powers-list-row">
        <div [class]="listRowEndClass">
          <p role="status" [class]="statusClass" data-testid="powers-status">
            {{ statusLabel() }}
          </p>
          @if (filterActive()) {
            <button
              type="button"
              [class]="clearClass"
              (click)="clearFilters()"
              data-testid="powers-filter-clear"
            >
              <aec-icon name="x" decorative [size]="3.5" />
              <span i18n="@@listing.filters.clear">Clear filters</span>
            </button>
          }
        </div>
      </div>
    }

    @if (view().pairCount === 0) {
      <p
        class="rounded-panel border border-dashed border-(--border-default)
            bg-(--surface-sunken) p-6 text-sm text-(--text-secondary)"
      >
        <!-- AECI-2037: the first sentence names the kind (connector-kind-labels.ts). -->
        {{ emptyLead() }}
        <ng-container i18n="@@products.detail.body.powers.empty.correction"
          >Vendor data is curated; if you know of one,
          <a
            aecRequestTrigger
            [entity]="'product'"
            [kind]="'correction'"
            [slug]="slug()"
            [href]="'/products/' + slug() + '/correction'"
            class="text-(--accent-primary) underline underline-offset-2"
            >suggest a correction</a
          >.</ng-container
        >
      </p>
    } @else {
      @for (group of filteredView().groups; track group.hub.slug) {
        <aec-integration-group-card
          [headingId]="'powers-group-' + group.hub.slug"
          [heading]="group.hub.name"
          [logo]="{ src: group.hub.logo_url, name: group.hub.name, claimStatus: 'server-filtered' }"
          [countLabel]="countLabel(group.partners.length, hubTotal(group.hub.slug))"
          [link]="'/products/' + group.hub.slug"
          i18n-linkLabel="@@products.detail.group.link"
          linkLabel="View product"
          [linkAriaLabel]="productLinkAriaLabel(group.hub.name)"
          [expanded]="isExpanded(group.hub.slug)"
          (toggled)="toggle(group.hub.slug)"
        >
          <!-- AECI-1788: one card per pair in the shared card grid, as the Via lane cards
               sit inside their lane card: the nested surface, one column, two from md,
               three from lg, and one or two cards share the row. Every card is in the
               server HTML. There is no deferred cut. AECI-1924: or the same rows as a
               table, named by this card's heading. -->
          @if (viewMode() === 'table') {
            <aec-product-powered-table
              [rows]="tableRows()?.hubs?.get(group.hub.slug) ?? []"
              [ariaLabelledby]="'powers-group-' + group.hub.slug"
            />
          } @else {
            <ul
              class="aec-card-grid p-4 md:p-6"
              role="list"
              [attr.data-columns]="columns(group.partners.length)"
            >
              @for (partner of group.partners; track partner.key) {
                <li class="group/card block min-w-0">
                  <!-- The card is the row's one link, as the row was: the pair page, with
                     the same accessible name. No partner link is added. -->
                  <a
                    aecCard
                    interactive
                    nested
                    [routerLink]="pairLink(partner)"
                    [attr.aria-label]="hubRowAriaLabel(group.hub.name, partner)"
                    [class]="cardClass"
                    data-testid="powered-card"
                  >
                    <span class="flex items-start gap-3">
                      <aec-logo-or-initial
                        [claimStatus]="'server-filtered'"
                        [src]="partner.partner.logo_url"
                        [name]="partner.partner.name"
                        size="sm"
                      />
                      <span
                        class="min-w-0 flex-1 self-center text-t-20 leading-tight font-semibold break-words
                        transition-colors group-hover/card:text-(--accent-primary)"
                        data-testid="powered-card-name"
                        >{{ partner.partner.name }}</span
                      >
                      <!-- Navigation affordance, not direction (DESIGN.md "The Arrow
                         Rule"): the chevron the integration card draws. -->
                      <span [class]="goClass" aria-hidden="true"
                        ><aec-icon name="chevron-right" decorative [size]="4" [mirrorRtl]="true"
                      /></span>
                    </span>
                    <!-- The flow with both products named, the hub first: this page is
                       the connector's, read from neither product (QA pass on AECI-2035). -->
                    <span
                      class="flex flex-wrap items-center gap-x-2 text-sm text-(--text-secondary)"
                    >
                      <span class="sr-only" i18n="@@products.detail.body.powers.direction.srLabel"
                        >Direction:</span
                      >
                      @if (hubDirection(group.hub.name, partner); as d) {
                        <span
                          class="inline-block leading-none text-(--accent-primary) rtl:-scale-x-100"
                          aria-hidden="true"
                          >{{ d.glyph }}</span
                        >
                        <span>{{ d.label }}</span>
                      } @else {
                        <span
                          i18n="@@products.detail.body.powers.direction.none"
                          i18n-aria-label="@@products.detail.body.powers.direction.none.aria"
                          aria-label="Direction not listed"
                          >–</span
                        >
                      }
                    </span>
                    @if (mechanismSummary(partner) || dataObjectLabel(partner)) {
                      <span [class]="chipRowClass">
                        @if (mechanismSummary(partner); as summary) {
                          <span [class]="chipClass">{{ summary }}</span>
                        }
                        <!-- AECI-1080: the depth chip beside the mechanism badge, at the
                           same weight. Depth is orthogonal to mechanism. -->
                        @if (dataObjectLabel(partner); as objects) {
                          <span [class]="chipClass" data-testid="hub-data-objects">{{
                            objects
                          }}</span>
                        }
                      </span>
                    }
                  </a>
                </li>
              }
            </ul>
          }
        </aec-integration-group-card>
      }

      <!-- Pairs with no shared hub. Rendered as whole A-to-B cards, since neither
           endpoint has earned the right to head a card. Only labelled "Other
           connections" when hub cards exist above it to be "other" than. On its own
           it is simply the list. -->
      @if (filteredView().others.length > 0) {
        <aec-integration-group-card
          headingId="powers-other"
          [heading]="othersHeading()"
          [countLabel]="countLabel(filteredView().others.length, view().others.length)"
          [expanded]="isExpanded('powers-other')"
          (toggled)="toggle('powers-other')"
        >
          @if (viewMode() === 'table') {
            <aec-product-powered-table
              [rows]="tableRows()?.others ?? []"
              ariaLabelledby="powers-other"
              [hubless]="true"
            />
          } @else {
            <ul
              class="aec-card-grid p-4 md:p-6"
              role="list"
              [attr.data-columns]="columns(filteredView().others.length)"
            >
              @for (pair of filteredView().others; track pair.key) {
                <li class="group/card block min-w-0">
                  <a
                    aecCard
                    interactive
                    nested
                    [routerLink]="pairLink(pair)"
                    [attr.aria-label]="flatRowAriaLabel(pair)"
                    [class]="cardClass"
                    data-testid="powered-card"
                  >
                    <span class="flex items-start gap-3">
                      <span
                        class="flex min-w-0 flex-1 flex-wrap items-center gap-2 self-center text-t-20
                        leading-tight font-semibold transition-colors
                        group-hover/card:text-(--accent-primary)"
                      >
                        <span class="inline-flex min-w-0 items-center gap-2">
                          <aec-logo-or-initial
                            [claimStatus]="'server-filtered'"
                            [src]="pair.a.logo_url"
                            [name]="pair.a.name"
                            size="sm"
                          />
                          <span class="min-w-0 break-words">{{ pair.a.name }}</span>
                        </span>
                        <span
                          class="font-display inline-block text-xl leading-none text-(--accent-primary)
                          rtl:-scale-x-100"
                          aria-hidden="true"
                          >{{ pair.direction ? directionGlyph(pair.direction) : '·' }}</span
                        >
                        <span class="inline-flex min-w-0 items-center gap-2">
                          <aec-logo-or-initial
                            [claimStatus]="'server-filtered'"
                            [src]="pair.b.logo_url"
                            [name]="pair.b.name"
                            size="sm"
                          />
                          <span class="min-w-0 break-words">{{ pair.b.name }}</span>
                        </span>
                      </span>
                      <span [class]="goClass" aria-hidden="true"
                        ><aec-icon name="chevron-right" decorative [size]="4" [mirrorRtl]="true"
                      /></span>
                    </span>
                    @if (pairDirectionLabel(pair); as label) {
                      <span class="text-sm text-(--text-secondary)">{{ label }}</span>
                    }
                    @if (mechanismSummary(pair) || dataObjectLabel(pair)) {
                      <span [class]="chipRowClass">
                        @if (mechanismSummary(pair); as summary) {
                          <span [class]="chipClass">{{ summary }}</span>
                        }
                        @if (dataObjectLabel(pair); as objects) {
                          <span [class]="chipClass" data-testid="hub-data-objects">{{
                            objects
                          }}</span>
                        }
                      </span>
                    }
                  </a>
                </li>
              }
            </ul>
          }
        </aec-integration-group-card>
      }

      @if (filteredView().pairCount === 0) {
        <p
          class="rounded-panel border border-dashed border-(--border-default)
            bg-(--surface-sunken) p-6 text-sm text-(--text-secondary)"
          i18n="@@products.detail.body.powers.filter.empty"
        >
          No connections match that search.
        </p>
      }

      <!-- Catalog-scope note. Same boundary as the endpoint list on the same
           page, and it bites harder here: a connector's whole value proposition
           is breadth, so "Integrations it powers (4)" for a product that markets
           ~14 ERP connections understates the vendor in an h2. That is the
           mirror of the defect Addendum B closed, and an understatement is as
           much a trust failure as an overstatement on a directory that refuses
           pay-for-placement. Both sections carry the note, deliberately:
           caveating one would imply the other is complete. -->
      <p class="text-xs text-(--text-secondary)" i18n="@@products.detail.body.powers.scope">
        Only integrations between products listed on AEC Integrations appear here. If one is
        missing,
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
  `,
})
export class ProductPoweredHub {
  /**
   * The grouped view of the page product's `integrations_as_connector` edges.
   * Computed by the PARENT (`product-detail.ts`) rather than here, so the
   * section heading's count and these rows are provably the same set — the
   * heading previously counted raw edges and over-reported against what
   * rendered.
   *
   * It stays the UNFILTERED view. The `<h2>` count reads it, the filter's
   * "of N" reads it, and every group's total reads it — a filter is a reader's
   * temporary view of the section, never a claim about the product.
   */
  readonly view = input.required<PoweredHubView>();

  /** This page's product slug, for the two suggest-a-correction links. */
  readonly slug = input.required<string>();
  /**
   * The page product's connector kind, already resolved by `connectorKindFor`
   * (AECI-2037). It varies the heading and the empty state. `null` keeps the
   * "Connector" wording.
   */
  readonly kind = input<ConnectorKind | null>(null);

  /**
   * The reader's filter text (AECI-841). Deliberately component-local and
   * deliberately NOT a route query param: `/products/:slug` is a cacheable SSR
   * route keyed on path + query, so a `?q=` would mint an edge-cache entry per
   * keystroke for HTML that does not vary with it.
   */
  protected readonly query = signal('');

  /**
   * Cards or table (AECI-1924), the Integrations section's rule: cards by default, and
   * the server always renders cards, the same for every visitor. Component-local, never
   * in the URL or a cookie, so the cached HTML does not vary with it. One value for the
   * whole section, as the Integrations section's one toggle sets every lane.
   */
  protected readonly viewMode = signal<ListingView>('cards');

  /** The panel's search field, so "Clear filters" can hand focus back to it. */
  private readonly filterInput = viewChild<ElementRef<HTMLInputElement>>('filterInput');

  // The mock-up 6 recipe, shared with the Integrations section (AECI-1788).
  protected readonly headingClass = INTEGRATION_LIST_HEADING_CLASS;
  protected readonly panelClass = INTEGRATION_FILTER_PANEL_CLASS;
  /**
   * The integration card recipe's compact variant (match-card-recipe.ts): these cards sit
   * inside a group card, three across from lg, so they keep 24px padding and 16px between
   * blocks, with the recipe's chips and its 34px round chevron button.
   */
  protected readonly cardClass = `${MATCH_CARD_COMPACT_BODY_CLASS} text-(--text-primary) no-underline`;
  protected readonly chipRowClass = MATCH_CHIP_ROW_CLASS;
  protected readonly chipClass = MATCH_CHIP_CLASS;
  protected readonly goClass = MATCH_CARD_GO_CLASS;
  protected readonly searchIconClass = INTEGRATION_SEARCH_ICON_CLASS;
  protected readonly searchInputClass = INTEGRATION_SEARCH_INPUT_CLASS;
  protected readonly listRowClass = INTEGRATION_LIST_ROW_CLASS;
  protected readonly listRowEndClass = INTEGRATION_LIST_ROW_END_CLASS;
  protected readonly statusClass = INTEGRATION_STATUS_CLASS;
  protected readonly clearClass = INTEGRATION_CLEAR_CLASS;

  /**
   * "Showing 3 of 12" while the search is on, empty otherwise: the message id and rule
   * of the Integrations section's list row. The region stays in the DOM so the first
   * change is announced.
   */
  protected readonly statusLabel = computed(() => {
    if (!this.filterActive()) return '';
    const shown = this.filteredView().pairCount;
    const total = this.view().pairCount;
    return $localize`:@@products.detail.filter.status:Showing ${shown}:SHOWN: of ${total}:TOTAL:`;
  });

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  /** The search is on: "Clear filters" shows, as on the Integrations panel. */
  protected readonly filterActive = computed(() => isFilterActive(this.query()));

  /**
   * "Clear filters" (ruled 2026-11-17): the query back to empty, so every row and
   * every card the reader had not closed comes back, and the "Showing n of m" status
   * empties. The button goes with the filter, so focus moves to the search field
   * rather than falling to the page body.
   */
  protected clearFilters(): void {
    this.query.set('');
    this.filterInput()?.nativeElement.focus();
  }

  /** Card keys the reader has closed. Hub slug, or `powers-other`. */
  private readonly collapsed = signal<ReadonlySet<string>>(new Set<string>());

  protected readonly filteredView = computed(() => filterPoweredHubView(this.view(), this.query()));

  /**
   * "Integrations it powers (N)", or "Integrations it delivers (N)" on a Sync Service
   * (AECI-2037, `connector-kind-labels.ts`).
   *
   * The copy is a noun phrase, parallel to the endpoint "Integrations (N)"
   * heading on the same page, because on a connector page **both sections can
   * be populated at once** — live data has a connector carrying its own
   * endpoint integrations *and* powered edges (NetSuite Connector by
   * Appficiency), so the two headings have to be told apart. The former
   * "Powers these integrations" failed at that: verb-first (breaking the
   * `About` / `How teams use it` / `Integrations` / `Reviews` heading grammar),
   * "these" pointed forward at nothing, and "powers" is vendor marketing voice
   * rather than the neutral catalog voice PRODUCT.md asks for. The pronoun in
   * "it powers" does the disambiguating work "these" was not doing.
   *
   * N counts the distinct product PAIRS the section renders, not raw edges.
   * Counting edges made the heading lie: live data carries duplicate rows for a
   * pair (that same NetSuite connector has 4 edges over 2 pairs) and several
   * mechanisms between one pair collapse to a single row, so a reader counting
   * rows found fewer than the heading promised.
   *
   * A filter never moves it — the heading is a fact about the product, and the
   * filter's own "Showing 3 of 12" line reports the view.
   */
  protected readonly heading = computed(() => poweredHeading(this.kind(), this.view().pairCount));

  /** The empty state's first sentence, by kind (AECI-2037). */
  protected readonly emptyLead = computed(() => poweredEmptyLead(this.kind()));

  /**
   * The filter renders whenever the section renders rows — there is no row
   * threshold. See `integration-filter.ts` for why the ten-row gate went: this
   * section and `#integrations` sit next to each other on a connector page, and
   * the same control appearing over one and not the other reads as a bug.
   */
  protected readonly showFilter = computed(() => this.view().pairCount > 0);

  /**
   * "Other connections" only when there are hub cards above it to be other
   * than. Read off the FILTERED view, because a search that leaves only hubless
   * pairs really has left a section with no hub cards in it.
   */
  protected readonly othersHeading = computed(() =>
    this.filteredView().groups.length > 0
      ? $localize`:@@products.detail.body.powers.other:Other connections`
      : $localize`:@@products.detail.body.powers.connections:Connections`,
  );

  /**
   * An active filter opens every surviving card, whatever the reader closed
   * earlier. A search that silently matched rows inside a collapsed card would
   * report "Showing 3 of 40" over an empty screen. Clearing the query restores
   * the reader's own collapsed set rather than discarding it.
   */
  protected isExpanded(key: string): boolean {
    return isFilterActive(this.query()) || !this.collapsed().has(key);
  }

  protected toggle(key: string): void {
    this.collapsed.update((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }

  /**
   * One or two cards share the row equally, three or more keep the grid's steps: the
   * Integrations section's rule (ruled 2026-11-16), through the same helper. Read off
   * the rendered count, so the rule holds under a filter too.
   */
  protected columns(count: number): 1 | 2 | null {
    return sharedRowColumns(count);
  }

  /** This hub's UNFILTERED partner count, for the "3 of 12" label. */
  protected hubTotal(slug: string): number {
    return this.view().groups.find((group) => group.hub.slug === slug)?.partners.length ?? 0;
  }

  /**
   * Group size. Plain while the section is whole; "3 of 12" under a filter, so
   * a reader can tell a small group from a heavily filtered large one.
   */
  protected countLabel(shown: number, total: number): string {
    if (shown !== total) {
      return $localize`:@@products.detail.group.count.filtered:${shown}:SHOWN: of ${total}:TOTAL:`;
    }
    if (total === 1) {
      return $localize`:@@products.detail.body.powers.group.count.one:1 connection`;
    }
    return $localize`:@@products.detail.body.powers.group.count:${total}:count: connections`;
  }

  /**
   * RouterLink to the canonical pair page — context slug is the alphabetically
   * -first of the two, which `PoweredConnection.a` already is (both are
   * normalized through `orderedPairSlugs`, the same rule
   * `defaultIntegrationContext` applies). Routed through the shared helper
   * anyway so the two can never drift.
   *
   * **`routerLink`, not a plain `href`.** Angular's router has no global anchor
   * interception — only the `RouterLink` directive handles the click — so a bare
   * `href` here would turn every row into a full document load and app bootstrap
   * instead of a SPA navigation. Being inside a projected `<ng-content>` changes
   * nothing: the sibling `#integrations` section's `ProductIntegrationRow` is
   * projected into the same `IntegrationGroupCard` panel and keeps `routerLink`
   * too. `routerLink` still serialises a real `href` for crawlers and no-JS
   * readers, so nothing is lost. The card's own trailing "View product" anchor
   * uses `routerLink` too (AECI-1125).
   */
  protected pairLink(pair: PoweredConnection): readonly string[] {
    const context = defaultIntegrationContext(pair.a.slug, pair.b.slug);
    const other = context === pair.a.slug ? pair.b.slug : pair.a.slug;
    return ['/products', context, 'integrations', other];
  }

  /**
   * Mechanism badge text. One kind renders its own label; several (a pair
   * joined by, say, both a marketplace app and an iPaaS flow) collapse to a
   * count rather than a badge pile — the pair page carries the per-mechanism
   * detail. Empty string when no collapsed edge named a kind, which the
   * template's `@if`-as-binding treats as absent.
   */
  protected mechanismSummary(pair: PoweredConnection): string {
    const kinds = pair.mechanismKinds;
    if (kinds.length === 0) return '';
    if (kinds.length === 1) return mechanismKindLabel(kinds[0]);
    return $localize`:@@products.detail.body.powers.mechanism.multiple:${kinds.length}:count: connection types`;
  }

  /**
   * AECI-1080 depth axis: "N data objects" over the pair's UNIONED slugs, or `''`,
   * which the template's `@if`-as-binding treats as absent. The same label helper
   * and the same counting rule as `ProductIntegrationRow`, so one pair reads the
   * same count on the connector page and on either endpoint's page.
   */
  protected dataObjectLabel(pair: PoweredConnection): string {
    return dataObjectCountLabel(pair.dataObjectSlugs.length);
  }

  /**
   * A partner row's direction (arrow glyph + words), or null when unknown. The words
   * name both products, the hub and the partner ("Procore sends to Viewpoint Vista"),
   * because this page is the connector's, which is neither of them (QA pass on
   * AECI-2035). The glyph stays hub-relative, beside the hub's card.
   */
  protected hubDirection(
    hubName: string,
    partner: Pick<PoweredHubPartner, 'hubDirection' | 'partner'>,
  ): { label: string; glyph: string } | null {
    const direction = partner.hubDirection;
    if (direction === null) return null;
    return {
      label: pairFlowSentence(direction, hubName, partner.partner.name),
      glyph: directionGlyph(direction),
    };
  }

  /**
   * A flat row's direction glyph comes from the shared helper (the Arrow Rule,
   * AECI-1123). The template keeps the `·` placeholder for an unknown direction.
   */
  protected readonly directionGlyph = directionGlyph;

  /**
   * A hubless pair card's direction words: both products named, "{A} sends to {B}" or
   * "{A} and {B} sync both ways" (`pairFlowSentence`, QA pass on AECI-2035), because
   * the connector's page is read from neither of them.
   * The card has no page product to frame against, so it frames on endpoint A, the
   * name it prints first, which is the frame `pair.direction` is already in. `''`
   * when unknown, which the template's `@if`-as-binding treats as absent.
   */
  protected pairDirectionLabel(pair: PoweredConnection): string {
    return pair.direction ? pairFlowSentence(pair.direction, pair.a.name, pair.b.name) : '';
  }

  /**
   * Accessible name for a hub card's partner row (AECI-1117).
   *
   * The row is ONE link, and its `aria-label` replaces everything inside it as
   * the accessible name. So whatever the row shows has to be restated here or a
   * screen reader never hears it: the `sr-only` "Direction:" prefix, the
   * direction word, the mechanism badge and the object chip are all inside the
   * link. Before AECI-1117 only the object count (AECI-1080) made it in, and a
   * reader heard "View the Procore and Sage integration" with no direction.
   *
   * Direction is the words the row shows ("Procore sends to Sage"), so the name
   * contains the visible text (WCAG 2.5.3). The name opens with the hub. An unknown direction is said in words, since
   * the row shows a dash for it.
   */
  protected hubRowAriaLabel(hubName: string, partner: PoweredHubPartner): string {
    const direction = this.hubDirection(hubName, partner);
    const directionPhrase = direction
      ? $localize`:@@products.detail.body.powers.row.aria.direction:direction ${direction.label}:DIRECTION:`
      : $localize`:@@products.detail.body.powers.row.aria.direction.none:direction not listed`;
    return this.rowAriaLabel(hubName, partner.partner.name, directionPhrase, partner);
  }

  /**
   * Accessible name for a flat "Other connections" card (AECI-1117). The card
   * draws `A → B` with an `aria-hidden` arrow, so the name says which way in the
   * card's own words: "A sends to B" or "B sends to A" (QA pass on AECI-2035). "One-way"
   * alone dropped the half the arrow carries.
   */
  protected flatRowAriaLabel(pair: PoweredConnection): string {
    // The visible words, framed on A, which the name opens with (WCAG 2.5.3), the same
    // message ids as a hub card's name.
    const label = this.pairDirectionLabel(pair);
    const directionPhrase = label
      ? $localize`:@@products.detail.body.powers.row.aria.direction:direction ${label}:DIRECTION:`
      : $localize`:@@products.detail.body.powers.row.aria.direction.none:direction not listed`;
    return this.rowAriaLabel(pair.a.name, pair.b.name, directionPhrase, pair);
  }

  /**
   * "View the {A} and {B} integration, {direction}, {mechanism}, {objects}".
   * Built in TS rather than an interpolated `i18n-*` attribute, which emits no
   * attribute at all in this app (see the repo note on interpolated i18n attrs).
   * Each optional part is appended only when the row shows it, and the separator
   * is its own message so a translation can change it.
   */
  private rowAriaLabel(
    first: string,
    second: string,
    directionPhrase: string,
    pair: PoweredConnection,
  ): string {
    const parts = [directionPhrase, this.mechanismSummary(pair), this.dataObjectLabel(pair)];
    return parts
      .filter((part) => part !== '')
      .reduce(
        (name, part) =>
          $localize`:@@products.detail.body.powers.row.aria.part:${name}:NAME:, ${part}:PART:`,
        $localize`:@@products.detail.body.powers.row.aria:View the ${first}:FIRST: and ${second}:SECOND: integration`,
      );
  }

  /**
   * The table view's rows (AECI-1924), built only while the table shows: every hub's
   * rows by hub slug, and the hubless pairs. Read off the FILTERED view, the one the
   * cards render, so both views list the same rows in the same order and counts.
   */
  protected readonly tableRows = computed(() => {
    if (this.viewMode() !== 'table') return null;
    const view = this.filteredView();
    return {
      hubs: new Map(
        view.groups.map((group) => [
          group.hub.slug,
          this.hubTableRows(group.hub.name, group.partners),
        ]),
      ),
      others: this.pairTableRows(view.others),
    };
  });

  /**
   * A hub's table rows (AECI-1924): the same partners in the same order as its cards,
   * with what each card prints, worked out by the card's own helpers.
   */
  private hubTableRows(hubName: string, partners: readonly PoweredHubPartner[]): PoweredTableRow[] {
    return partners.map((partner) => ({
      key: partner.key,
      link: this.pairLink(partner),
      ariaLabel: this.hubRowAriaLabel(hubName, partner),
      products: [partner.partner],
      pairGlyph: null,
      direction: this.hubDirection(hubName, partner),
      ...this.mechanismColumns(partner),
      dataObjects: this.dataObjectLabel(partner),
    }));
  }

  /**
   * The table's "How it connects" (AECI-1924, 2026-11-19): every kind as its own chip and
   * the mechanism's name, through `mechanismDisplay`, the Integrations table's rule, so a
   * name that only repeats a kind is not printed twice. Several names on one pair (its
   * edges collapsed) are joined. The card keeps its one-chip summary.
   */
  private mechanismColumns(pair: PoweredConnection): {
    mechanismLabels: readonly string[];
    mechanismName: string | null;
  } {
    const kinds = pair.mechanismKinds.map((kind) => mechanismKindLabel(kind)).filter(Boolean);
    const shown = mechanismDisplay(kinds, pair.mechanismNames.join(', ') || null);
    return { mechanismLabels: shown.labels, mechanismName: shown.name };
  }

  /** The hubless pairs' table rows (AECI-1924), in the cards' order, with their words. */
  private pairTableRows(pairs: readonly PoweredConnection[]): PoweredTableRow[] {
    return pairs.map((pair) => {
      const label = this.pairDirectionLabel(pair);
      return {
        key: pair.key,
        link: this.pairLink(pair),
        ariaLabel: this.flatRowAriaLabel(pair),
        products: [pair.a, pair.b],
        pairGlyph: pair.direction ? directionGlyph(pair.direction) : '·',
        direction: label ? { label, glyph: null } : null,
        ...this.mechanismColumns(pair),
        dataObjects: this.dataObjectLabel(pair),
      };
    });
  }

  /**
   * Accessible name for a card's trailing "View product" link. Same reason: the
   * visible text repeats on every card, so the name says which product. It
   * starts with the visible "View product" text so WCAG 2.5.3 Label in Name
   * holds and speech input can target it. The link stays in the tab
   * (AECI-1125), so the name no longer announces one.
   */
  protected productLinkAriaLabel(name: string): string {
    return $localize`:@@products.detail.group.link.name:View product: ${name}:NAME:`;
  }
}
