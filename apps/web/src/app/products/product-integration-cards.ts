import { Component, computed, input } from '@angular/core';

import { sharedRowColumns } from './integration-category-groups';
import { ProductIntegrationCard } from './product-integration-card';

import type { IntegrationLaneRow } from './connector-lane-grouping';

/**
 * AECI-1782: one LANE of the product page's Integrations section as cards, the
 * card-view counterpart of `aec-product-integrations-table`.
 *
 * **One named list per lane**, for the reason §13.3 gives one table per lane: a
 * group heading inside a single list has no accessible name relationship to the
 * items under it. The list is named by `ariaLabel` (one lane) or by
 * `ariaLabelledby` pointing at the lane card's `<h3>`, never both. The list must keep
 * one of the two: since AECI-2021 the one-lane list has no visible heading over it.
 *
 * The same `@defer` cut as the table: `above` renders eagerly, `deferred` sits in
 * an `@defer (on viewport; hydrate on viewport)` block that is still rendered on the
 * server, so a crawler sees every card. A `@defer` block emits no element, so the
 * deferred cards are grid items of the same list.
 *
 * The grid is the integration card grid (`aec-integration-grid`, DESIGN.md "The
 * integration card"): one column, two from `md`. A third column would need every card
 * at least 400px wide, which the page wrap never allows. No wide lead card (ruling R3).
 * One card takes the full row (`data-columns`, ruled 2026-11-16).
 */
@Component({
  selector: 'aec-product-integration-cards',
  imports: [ProductIntegrationCard],
  host: { class: 'block' },
  template: `
    <ul
      class="aec-integration-grid"
      role="list"
      [attr.aria-label]="ariaLabel()"
      [attr.aria-labelledby]="ariaLabelledby()"
      [attr.data-columns]="columns()"
      data-testid="integration-cards"
    >
      @for (row of above(); track row.key) {
        <li
          aec-product-integration-card
          [row]="row"
          [contextSlug]="contextSlug()"
          [headingLevel]="headingLevel()"
          [nested]="nested()"
        ></li>
      }
      @if (deferred().length > 0) {
        @defer (on viewport; hydrate on viewport) {
          @for (row of deferred(); track row.key) {
            <li
              aec-product-integration-card
              [row]="row"
              [contextSlug]="contextSlug()"
              [headingLevel]="headingLevel()"
              [nested]="nested()"
            ></li>
          }
        } @placeholder (minimum 100ms) {
          <li aria-hidden="true" class="col-span-full">
            <div class="h-40 animate-pulse rounded-card bg-(--surface-sunken)"></div>
          </li>
        }
      }
    </ul>
  `,
})
export class ProductIntegrationCards {
  /** Cards rendered eagerly: this lane's share of the section-wide `@defer` cut. */
  readonly above = input.required<readonly IntegrationLaneRow[]>();
  /** The remainder, deferred on viewport and still rendered on the server. */
  readonly deferred = input.required<readonly IntegrationLaneRow[]>();
  /** This page's product slug; the pair-page context on every card. */
  readonly contextSlug = input.required<string>();
  /** Accessible name for the one-lane case. */
  readonly ariaLabel = input<string | null>(null);
  /** …or the id of the lane card's `<h3>`. */
  readonly ariaLabelledby = input<string | null>(null);
  /**
   * 3 on a one-lane page, under the section `<h2>` (AECI-2021 removed the list heading),
   * 4 inside a lane card, under its `<h3>`.
   */
  readonly headingLevel = input<3 | 4>(3);
  /** Inside a lane card: nested card surfaces (tint, no shadow). */
  readonly nested = input(false);

  /** One or two cards share the row equally; three or more keep the shared steps. */
  protected readonly columns = computed(() =>
    sharedRowColumns(this.above().length + this.deferred().length),
  );
}
