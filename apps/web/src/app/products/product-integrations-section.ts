import { Component, computed, input, signal } from '@angular/core';

import type { ProductIntegrationItem } from '@aeci/shared';

import { RequestTrigger } from '../requests/request-trigger';

import {
  applyDeferCut,
  INTEGRATIONS_ABOVE_FOLD,
  splitIntegrationLanes,
  type ConnectorLaneGroup,
} from './connector-lane-grouping';
import {
  filterIntegrationLanes,
  INTEGRATION_FILTER_MIN_ROWS,
  isFilterActive,
} from './integration-filter';
import { IntegrationGroupCard } from './integration-group-card';
import { IntegrationListFilter } from './integration-list-filter';
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
 * ── SINGLE-LANE PAGES ARE DELIBERATELY UNCHANGED ────────────────────────────────
 * A product with no connector-delivered edges — the overwhelming majority —
 * still renders exactly one unheaded table, named by the section `<h2>`. §13.3
 * rejected a "Direct integrations" heading over the only table as chrome over a
 * fact the heading already states, and a collapsible card would be that same
 * chrome with a button on it. It still gets the filter when it is long: a
 * 40-row single lane is precisely the list the filter exists for.
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
  imports: [IntegrationGroupCard, IntegrationListFilter, ProductIntegrationsTable, RequestTrigger],
  template: `
    <h2 id="integrations-title" class="font-display text-2xl font-semibold text-(--text-primary)">
      {{ heading() }}
    </h2>

    @if (lanes().rowCount === 0) {
      <p
        class="rounded-(--radius-lg) border border-dashed border-(--border-default)
            bg-(--surface-sunken) p-6 text-sm text-(--text-secondary)"
        i18n="@@products.detail.body.integrations.empty"
      >
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
    } @else {
      @if (showFilter()) {
        <aec-integration-list-filter
          inputId="integrations-filter"
          i18n-label="@@products.detail.body.integrations.filter.label"
          label="Search these integrations"
          i18n-placeholder="@@products.detail.body.integrations.filter.placeholder"
          placeholder="Filter by product name"
          [(query)]="query"
          [shown]="filteredLanes().rowCount"
          [total]="lanes().rowCount"
        />
      }

      <!-- A page with no connector edges renders exactly what it always did:
             one unheaded table, named by the section heading. The lane structure
             appears only when there is a second lane to distinguish. -->
      @if (lanes().via.length === 0) {
        @if (filteredLanes().rowCount > 0) {
          <aec-product-integrations-table
            [above]="laneCut().direct.above"
            [deferred]="laneCut().direct.deferred"
            [contextSlug]="slug()"
            i18n-ariaLabel="@@products.detail.body.integrations.table.aria"
            ariaLabel="Integrations"
          />
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
            <aec-product-integrations-table
              [above]="laneCut().direct.above"
              [deferred]="laneCut().direct.deferred"
              [contextSlug]="slug()"
              ariaLabelledby="integrations-direct"
            />
          </aec-integration-group-card>
        }
        @for (lane of laneCut().via; track lane.lane.key) {
          <aec-integration-group-card
            [headingId]="'integrations-via-' + lane.lane.key"
            [heading]="viaHeading(lane.lane)"
            [logoSrc]="lane.lane.connector?.logo_url ?? null"
            [logoName]="lane.lane.connector?.name ?? null"
            [countLabel]="countLabel(lane.lane.rows.length, viaTotal(lane.lane.key))"
            [link]="viaLink(lane.lane)"
            i18n-linkLabel="@@products.detail.group.link"
            linkLabel="View product"
            [linkAriaLabel]="viaLinkAriaLabel(lane.lane)"
            [expanded]="isExpanded('integrations-via-' + lane.lane.key)"
            (toggled)="toggle('integrations-via-' + lane.lane.key)"
          >
            <aec-product-integrations-table
              [above]="lane.above"
              [deferred]="lane.deferred"
              [contextSlug]="slug()"
              [ariaLabelledby]="'integrations-via-' + lane.lane.key"
            />
          </aec-integration-group-card>
        }
      }

      @if (filteredLanes().rowCount === 0) {
        <p
          class="rounded-(--radius-lg) border border-dashed border-(--border-default)
              bg-(--surface-sunken) p-6 text-sm text-(--text-secondary)"
          i18n="@@products.detail.body.integrations.filter.empty"
        >
          No integrations match that search.
        </p>
      }

      <!-- Catalog-scope note. An integration row only exists once BOTH
             endpoints are promoted products, so this table is bounded by the
             directory, not by the vendor's real partner list: a product with
             hundreds of marketplace partners can render a dozen. The empty state
             already hedges ("Vendor data is curated"); without this line the
             POPULATED state makes a bare confident count, which is the one
             people screenshot. Scope, not apology: it states the boundary and
             offers the fix. Once per section, never once per group (§13.3). -->
      <p class="text-xs text-(--text-secondary)" i18n="@@products.detail.body.integrations.scope">
        Only partners listed on AECi appear here. If one is missing,
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
export class ProductIntegrationsSection {
  /** This page's product slug: the pair-page context on every row, and the
   *  target of both suggest-a-correction links. */
  readonly slug = input.required<string>();
  /** Edges where this product is the source endpoint. */
  readonly asSource = input.required<readonly ProductIntegrationItem[]>();
  /** Edges where this product is the target endpoint. */
  readonly asTarget = input.required<readonly ProductIntegrationItem[]>();

  /**
   * The reader's filter text (AECI-841). Component-local and deliberately NOT a
   * route query param: `/products/:slug` is a cacheable SSR route keyed on
   * path + query, so a `?q=` would mint an edge-cache entry per keystroke for
   * HTML that does not vary with it.
   */
  protected readonly query = signal('');

  /** Lane card keys the reader has closed. */
  private readonly collapsed = signal<ReadonlySet<string>>(new Set<string>());

  /** The section as the data has it — the `<h2>` count, every "of N" total. */
  protected readonly lanes = computed(() =>
    splitIntegrationLanes(this.asSource(), this.asTarget()),
  );

  /** The same view with the reader's query applied. */
  protected readonly filteredLanes = computed(() =>
    filterIntegrationLanes(this.lanes(), this.query()),
  );

  /**
   * The filtered view with the `@defer (on viewport)` boundary applied, over the
   * FLATTENED render order (§13.3). A filter raises the limit to the whole
   * filtered set — see the class note.
   */
  protected readonly laneCut = computed(() => {
    const view = this.filteredLanes();
    const limit = isFilterActive(this.query()) ? view.rowCount : INTEGRATIONS_ABOVE_FOLD;
    return applyDeferCut(view, limit);
  });

  /**
   * Section heading with the count inline — "Integrations (10)" — so the total
   * reads next to the title instead of drifting to the far right where it's
   * missed.
   *
   * Counts the rows the UNFILTERED section renders across both lanes, which
   * after the Via lane's pair collapse is not the number of edges: §13.3's rule
   * is that a reader counting rows must never find fewer than the heading
   * promised. A filter never moves it — the heading is a fact about the product,
   * and the filter's own "Showing 3 of 12" line reports the view.
   */
  protected readonly heading = computed(() => {
    const count = this.lanes().rowCount;
    return $localize`:@@products.detail.body.integrations.heading:Integrations (${count}:count:)`;
  });

  /** Below the threshold the whole list is already on one screen. */
  protected readonly showFilter = computed(
    () => this.lanes().rowCount >= INTEGRATION_FILTER_MIN_ROWS,
  );

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
    return isFilterActive(this.query()) || !this.collapsed().has(key);
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
   * because the new tab has to be announced rather than discovered. The name
   * starts with the visible "View product" text, so WCAG 2.5.3 Label in Name
   * holds and a speech-input user can say what they can read.
   */
  protected viaLinkAriaLabel(lane: ConnectorLaneGroup): string {
    const connector = lane.connector;
    if (!connector) return '';
    return $localize`:@@products.detail.group.link.aria:View product: ${connector.name}:NAME: (opens in a new tab)`;
  }
}
