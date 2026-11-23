import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import {
  INTEGRATION_TABLE_BODY_CLASS,
  INTEGRATION_TABLE_CLASS,
  INTEGRATION_TABLE_FRAME_CLASS,
  INTEGRATION_TABLE_NESTED_FRAME_CLASS,
  INTEGRATION_TABLE_HEAD_CLASS,
  INTEGRATION_TABLE_TH_CLASS,
  INTEGRATION_TABLE_TH_LINK_CLASS,
  INTEGRATION_TABLE_TH_MD_CLASS,
} from './integration-table-recipe';
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
    <!-- Real table (replaces the former card stack) so the partner and the
         connection mechanism align into scannable columns. Connection collapses
         at md (matching ProductCard / the browse tables), with the mechanism
         folding into the partner cell's meta line.

         The min width is 34rem, not the former 44rem: AECI-853 folded the
         Direction column into that same meta line, which took the table's
         worst-case intrinsic width from 666px to 545px. 34rem is what fits the
         608px body column when DetailLayout docks the metadata sidebar at
         lg, which is the whole point of the fold. Raising it back above 38rem
         re-breaks that dock into a horizontal scroll. -->
    <!-- AECI-1720 (mock-up 6, .table-wrap): the table sits in a white card with a Bone
         header row. -->
    <div [class]="frameClass()" data-testid="integrations-table-frame">
      <table
        [class]="tableClass"
        [attr.aria-label]="ariaLabel()"
        [attr.aria-labelledby]="ariaLabelledby()"
      >
        <thead [class]="headClass">
          <tr>
            <th
              scope="col"
              [class]="thClass"
              i18n="@@products.detail.body.integrations.col.product"
            >
              Integrates with
            </th>
            <th
              scope="col"
              class="hidden px-4 py-3 text-start font-semibold lg:table-cell"
              i18n="@@search.facet.categories"
            >
              Categories
            </th>
            <th
              scope="col"
              [class]="thMdClass"
              i18n="@@products.detail.body.integrations.col.connection"
            >
              Connection
            </th>
            <th scope="col" [class]="thLinkClass">
              <span class="sr-only" i18n="@@products.detail.body.integrations.col.details"
                >Details</span
              >
            </th>
          </tr>
        </thead>
        <tbody [class]="bodyClass">
          @for (row of above(); track row.key) {
            <tr
              aec-product-integration-row
              [integration]="row.integration"
              [other]="row.other"
              [contextSlug]="contextSlug()"
              [mergedMechanismKinds]="row.mechanismKinds"
              [mergedDirection]="row.direction"
              [mergedDataObjectSlugs]="row.dataObjectSlugs"
              [mergedAgreement]="row.agreement"
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
                  [mergedDataObjectSlugs]="row.dataObjectSlugs"
                  [mergedAgreement]="row.agreement"
                ></tr>
              }
            } @placeholder (minimum 100ms) {
              <tr aria-hidden="true">
                <td colspan="4" class="px-4 py-3">
                  <div
                    class="h-16 animate-pulse rounded-mark
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
  /**
   * The table sits inside a group card (a lane card): no frame radius or shadow of its
   * own, so no curved header sits inside the card's square edge (AECI-1924, 2026-11-19).
   * The standalone table keeps its rounded frame.
   */
  readonly nested = input(false);

  // The table recipe, shared with the hub tables of "Integrations it powers" (AECI-1924).
  protected readonly frameClass = computed(() =>
    this.nested() ? INTEGRATION_TABLE_NESTED_FRAME_CLASS : INTEGRATION_TABLE_FRAME_CLASS,
  );
  protected readonly tableClass = INTEGRATION_TABLE_CLASS;
  protected readonly headClass = INTEGRATION_TABLE_HEAD_CLASS;
  protected readonly thClass = INTEGRATION_TABLE_TH_CLASS;
  protected readonly thMdClass = INTEGRATION_TABLE_TH_MD_CLASS;
  protected readonly thLinkClass = INTEGRATION_TABLE_TH_LINK_CLASS;
  protected readonly bodyClass = INTEGRATION_TABLE_BODY_CLASS;
}
