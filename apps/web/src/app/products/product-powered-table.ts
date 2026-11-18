import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ProductLink } from '@aeci/shared';

import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';
import { forwardRowClick } from '../shared/row-link/row-link-click';

import {
  INTEGRATION_TABLE_BODY_CLASS,
  INTEGRATION_TABLE_CLASS,
  INTEGRATION_TABLE_CONNECTION_CELL_CLASS,
  INTEGRATION_TABLE_FIRST_CELL_CLASS,
  INTEGRATION_TABLE_FRAME_CLASS,
  INTEGRATION_TABLE_HEAD_CLASS,
  INTEGRATION_TABLE_LINK_CELL_CLASS,
  INTEGRATION_TABLE_META_CLASS,
  INTEGRATION_TABLE_ROW_CLASS,
  INTEGRATION_TABLE_ROW_LINK_CLASS,
  INTEGRATION_TABLE_TH_CLASS,
  INTEGRATION_TABLE_TH_LINK_CLASS,
  INTEGRATION_TABLE_TH_MD_CLASS,
} from './integration-table-recipe';
import { AecIcon } from '../shared/icon/icon';
import { Chip } from '../shared/chip/chip';

/**
 * One row of a powered hub's table: what the pair's card shows, already worked out by
 * `ProductPoweredHub` with the card's own helpers, so a card and its row cannot say
 * different things.
 */
export interface PoweredTableRow {
  /** The pair's key, for `track`. */
  readonly key: string;
  /** The pair page, the card's one link. */
  readonly link: readonly string[];
  /** The card's accessible name, which the row's link carries. */
  readonly ariaLabel: string;
  /** The partner in a hub table. Endpoint A, then B, in the hubless table. */
  readonly products: readonly ProductLink[];
  /** The arrow the hubless card draws between A and B, `·` when unknown. Hub rows: null. */
  readonly pairGlyph: string | null;
  /** The direction words and glyph the card prints, or null when it prints none. */
  readonly direction: { readonly label: string; readonly glyph: string | null } | null;
  /** The card's dash for an unknown direction (hub cards print one, hubless cards do not). */
  readonly directionUnknown: boolean;
  /** The mechanism chip, or `''`. */
  readonly mechanism: string;
  /** The data-object chip, or `''`. */
  readonly dataObjects: string;
}

/**
 * The table view of one group in "Integrations it powers" (AECI-1924): a hub, or the
 * hubless pairs. The Integrations section's table recipe (`integration-table-recipe.ts`),
 * its header words and its row behaviour: the first cell carries the product and a meta
 * line with the direction, the Connection column shows the chips from `md` and folds
 * into the meta line below it, and the trailing chevron is the row's link to the pair
 * page. A click anywhere else on the row is forwarded to it, as in the Integrations
 * table. The cards have one link per pair and no partner link, so the row has one too.
 *
 * The rows arrive in the cards' order and render in it. Nothing here sorts or cuts.
 * The table is named by its group card's heading, the hub's name, through
 * `aria-labelledby`, as each Via lane's table is.
 */
@Component({
  selector: 'aec-product-powered-table',
  imports: [AecIcon, Chip, LogoOrInitial, RouterLink],
  template: `
    <div [class]="frameClass" data-testid="powered-table-frame">
      <table [class]="tableClass" [attr.aria-labelledby]="ariaLabelledby()">
        <thead [class]="headClass">
          <tr>
            @if (hubless()) {
              <th scope="col" [class]="thClass" i18n="@@products.detail.body.powers.col.pair">
                Products
              </th>
            } @else {
              <th
                scope="col"
                [class]="thClass"
                i18n="@@products.detail.body.integrations.col.product"
              >
                Integrates with
              </th>
            }
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
          @for (row of rows(); track row.key) {
            <tr
              [class]="rowClass"
              (click)="onRowClick($event, rowLink)"
              data-testid="powered-table-row"
            >
              <td [class]="firstCellClass">
                <span class="flex min-w-0 flex-col">
                  <span class="flex min-w-0 flex-wrap items-center gap-2">
                    @for (product of row.products; track product.slug; let first = $first) {
                      @if (!first) {
                        <span
                          class="inline-block leading-none text-(--accent-primary) rtl:-scale-x-100"
                          aria-hidden="true"
                          >{{ row.pairGlyph }}</span
                        >
                      }
                      <span class="inline-flex min-w-0 items-center gap-3">
                        <aec-logo-or-initial
                          [claimStatus]="'server-filtered'"
                          [src]="product.logo_url"
                          [name]="product.name"
                          size="sm"
                        />
                        <span class="min-w-0 break-words" data-testid="powered-table-name">{{
                          product.name
                        }}</span>
                      </span>
                    }
                  </span>
                  <span [class]="metaClass">
                    @if (row.direction; as d) {
                      <span class="inline-flex items-center gap-1">
                        <span class="sr-only" i18n="@@products.detail.body.powers.direction.srLabel"
                          >Direction:</span
                        >
                        @if (d.glyph) {
                          <span
                            class="inline-block leading-none text-(--accent-primary) rtl:-scale-x-100"
                            aria-hidden="true"
                            >{{ d.glyph }}</span
                          >
                        }
                        <span>{{ d.label }}</span>
                      </span>
                    } @else if (row.directionUnknown) {
                      <span class="inline-flex items-center gap-1">
                        <span class="sr-only" i18n="@@products.detail.body.powers.direction.srLabel"
                          >Direction:</span
                        >
                        <span
                          i18n="@@products.detail.body.powers.direction.none"
                          i18n-aria-label="@@products.detail.body.powers.direction.none.aria"
                          aria-label="Direction not listed"
                          >–</span
                        >
                      </span>
                    }
                    <!-- Below md the Connection cell is hidden, so its chips join this
                         line, as in the Integrations table. -->
                    @if (row.mechanism) {
                      @if (row.direction || row.directionUnknown) {
                        <span class="md:hidden" aria-hidden="true">·</span>
                      }
                      <span class="md:hidden">{{ row.mechanism }}</span>
                    }
                    @if (row.dataObjects) {
                      @if (row.direction || row.directionUnknown || row.mechanism) {
                        <span class="md:hidden" aria-hidden="true">·</span>
                      }
                      <span class="md:hidden">{{ row.dataObjects }}</span>
                    }
                  </span>
                </span>
              </td>
              <td [class]="connectionCellClass">
                @if (row.mechanism || row.dataObjects) {
                  <span class="flex flex-wrap items-center gap-1">
                    @if (row.mechanism) {
                      <aec-chip density="dense" tone="neutral">{{ row.mechanism }}</aec-chip>
                    }
                    @if (row.dataObjects) {
                      <aec-chip density="dense" tone="neutral" data-testid="hub-data-objects">{{
                        row.dataObjects
                      }}</aec-chip>
                    }
                  </span>
                } @else {
                  <span
                    i18n="@@products.detail.integrations.mechanism.none"
                    i18n-aria-label="@@products.detail.integrations.mechanism.none.aria"
                    aria-label="Mechanism not listed"
                    >–</span
                  >
                }
              </td>
              <td [class]="linkCellClass">
                <!-- The card's one link, with the card's accessible name. A chevron, not
                     an arrow (DESIGN.md "The Arrow Rule"). -->
                <a
                  #rowLink
                  [routerLink]="row.link"
                  [attr.aria-label]="row.ariaLabel"
                  [class]="rowLinkClass"
                  data-testid="powered-table-link"
                >
                  <aec-icon
                    class="text-(--text-tertiary)"
                    name="chevron-right"
                    decorative
                    [size]="4"
                    [mirrorRtl]="true"
                  />
                </a>
              </td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class ProductPoweredTable {
  /** The group's rows, in the cards' order. */
  readonly rows = input.required<readonly PoweredTableRow[]>();
  /** The id of the group card's heading, the hub's name (or "Other connections"). */
  readonly ariaLabelledby = input.required<string>();
  /** The hubless pairs: each row names both products, under "Products". */
  readonly hubless = input(false);

  protected readonly frameClass = INTEGRATION_TABLE_FRAME_CLASS;
  protected readonly tableClass = INTEGRATION_TABLE_CLASS;
  protected readonly headClass = INTEGRATION_TABLE_HEAD_CLASS;
  protected readonly thClass = INTEGRATION_TABLE_TH_CLASS;
  protected readonly thMdClass = INTEGRATION_TABLE_TH_MD_CLASS;
  protected readonly thLinkClass = INTEGRATION_TABLE_TH_LINK_CLASS;
  protected readonly bodyClass = INTEGRATION_TABLE_BODY_CLASS;
  protected readonly rowClass = INTEGRATION_TABLE_ROW_CLASS;
  protected readonly firstCellClass = INTEGRATION_TABLE_FIRST_CELL_CLASS;
  protected readonly metaClass = INTEGRATION_TABLE_META_CLASS;
  protected readonly connectionCellClass = INTEGRATION_TABLE_CONNECTION_CELL_CLASS;
  protected readonly linkCellClass = INTEGRATION_TABLE_LINK_CELL_CLASS;
  protected readonly rowLinkClass = INTEGRATION_TABLE_ROW_LINK_CLASS;

  /** A click anywhere on the row but a link follows the row's link (Integrations table). */
  protected onRowClick(event: MouseEvent, link: HTMLAnchorElement): void {
    forwardRowClick(event, link);
  }
}
