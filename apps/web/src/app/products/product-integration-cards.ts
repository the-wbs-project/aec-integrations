import { Component, input } from '@angular/core';

import { ProductIntegrationCard } from './product-integration-card';

import type { IntegrationLaneRow } from './connector-lane-grouping';

/**
 * AECI-1782: one LANE of the product page's Integrations section as cards, the
 * card-view counterpart of `aec-product-integrations-table`.
 *
 * **One named list per lane**, for the reason §13.3 gives one table per lane: a
 * group heading inside a single list has no accessible name relationship to the
 * items under it. The list is named by `ariaLabel` (one lane) or by
 * `ariaLabelledby` pointing at the lane card's `<h3>`, never both.
 *
 * The same `@defer` cut as the table: `above` renders eagerly, `deferred` sits in
 * an `@defer (on viewport; hydrate on viewport)` block that is still rendered on the
 * server, so a crawler sees every card. A `@defer` block emits no element, so the
 * deferred cards are grid items of the same list.
 *
 * The grid is the shared `aec-card-grid`: one column, two from `md`, three from
 * `lg`, never more (clash 18). No wide lead card (ruling R3).
 */
@Component({
  selector: 'aec-product-integration-cards',
  imports: [ProductIntegrationCard],
  host: { class: 'block' },
  template: `
    <ul
      class="aec-card-grid"
      role="list"
      [attr.aria-label]="ariaLabel()"
      [attr.aria-labelledby]="ariaLabelledby()"
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
  /** 3 on a one-lane page, 4 inside a lane card. */
  readonly headingLevel = input<3 | 4>(3);
  /** Inside a lane card: nested card surfaces (tint, no shadow). */
  readonly nested = input(false);
}
