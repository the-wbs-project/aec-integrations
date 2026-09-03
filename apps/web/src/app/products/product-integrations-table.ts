import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import { ProductIntegrationRow } from './product-integration-row';

import type { IntegrationLaneRow } from './connector-lane-grouping';

/**
 * One LANE of the product-detail Integrations section: the direct list, or one
 * "Via {connector}" group (`STAGE_1_5_SPEC.md` §13.3).
 *
 * **One `<table>` per lane is the accessibility requirement, not a layout
 * preference.** A group-header row interleaved into a single `<tbody>` has no
 * accessible name relationship to the rows beneath it, so a screen-reader user
 * gets the grouping visually and not at all otherwise. Extracted into its own
 * component so the columns, the `md` collapse and the `@defer` batching are
 * written once and every lane provably renders the same table.
 *
 * The lane is named either by `ariaLabel` (the single-lane case, where the
 * section heading is the only heading) or by `ariaLabelledby` pointing at the
 * group's own `<h3>` — never by both, and never by neither.
 */
@Component({
  selector: 'aec-product-integrations-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProductIntegrationRow],
  template: `
    <!-- Real table (replaces the former card stack) so the partner, flow
         direction, and connection mechanism align into scannable columns.
         Horizontal scroll below the min width; Connection collapses at md
         (matching ProductCard / the browse tables), with the mechanism folding
         into the partner cell. -->
    <div class="overflow-x-auto">
      <table
        class="w-full border-collapse text-start text-sm md:min-w-[44rem]"
        [attr.aria-label]="ariaLabel()"
        [attr.aria-labelledby]="ariaLabelledby()"
      >
        <thead
          class="border-b border-(--border-default) text-start text-xs
            font-medium tracking-wide text-(--text-secondary)"
        >
          <tr>
            <th
              scope="col"
              class="px-4 py-3 text-start font-medium"
              i18n="@@products.detail.body.integrations.col.direction"
            >
              Direction
            </th>
            <th
              scope="col"
              class="px-4 py-3 text-start font-medium"
              i18n="@@products.detail.body.integrations.col.product"
            >
              Integrates with
            </th>
            <th
              scope="col"
              class="hidden px-4 py-3 text-start font-medium md:table-cell"
              i18n="@@products.detail.body.integrations.col.connection"
            >
              Connection
            </th>
            <th scope="col" class="px-4 py-3">
              <span class="sr-only" i18n="@@products.detail.body.integrations.col.details"
                >Details</span
              >
            </th>
          </tr>
        </thead>
        <tbody class="divide-y divide-(--border-default)">
          @for (row of above(); track row.key) {
            <tr
              aec-product-integration-row
              [integration]="row.integration"
              [other]="row.other"
              [contextSlug]="contextSlug()"
              [mergedMechanismKinds]="row.mechanismKinds"
              [mergedDirection]="row.direction"
            ></tr>
          }
          @if (deferred().length > 0) {
            @defer (on viewport; hydrate on viewport) {
              @for (row of deferred(); track row.key) {
                <tr
                  aec-product-integration-row
                  [integration]="row.integration"
                  [other]="row.other"
                  [contextSlug]="contextSlug()"
                  [mergedMechanismKinds]="row.mechanismKinds"
                  [mergedDirection]="row.direction"
                ></tr>
              }
            } @placeholder (minimum 100ms) {
              <tr aria-hidden="true">
                <td colspan="4" class="px-4 py-3">
                  <div
                    class="h-16 animate-pulse rounded-(--radius-lg)
                      border border-(--border-default) bg-(--surface-sunken)"
                  ></div>
                </td>
              </tr>
            }
          }
        </tbody>
      </table>
    </div>
  `,
})
export class ProductIntegrationsTable {
  /** Rows rendered eagerly — this lane's share of the section-wide `@defer` cut. */
  readonly above = input.required<readonly IntegrationLaneRow[]>();
  /** The remainder, deferred on viewport. Still SSR-rendered (v22 incremental
   *  hydration), so a crawler sees every row. */
  readonly deferred = input.required<readonly IntegrationLaneRow[]>();
  /** This page's product slug; the pair-page context on every row. */
  readonly contextSlug = input.required<string>();
  /** Accessible name for the single-lane case. */
  readonly ariaLabel = input<string | null>(null);
  /** …or the id of the group's `<h3>`, for a named lane. */
  readonly ariaLabelledby = input<string | null>(null);
}
