import { NgTemplateOutlet } from '@angular/common';
import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ProductLink } from '@aeci/shared';

import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';
import { forwardRowClick } from '../shared/row-link/row-link-click';

import {
  INTEGRATION_TABLE_BODY_CLASS,
  INTEGRATION_TABLE_CLASS,
  INTEGRATION_TABLE_FIRST_CELL_CLASS,
  INTEGRATION_TABLE_HEAD_CLASS,
  INTEGRATION_TABLE_LINK_CELL_CLASS,
  INTEGRATION_TABLE_META_CLASS,
  INTEGRATION_TABLE_NESTED_FRAME_CLASS,
  INTEGRATION_TABLE_ROW_CLASS,
  INTEGRATION_TABLE_ROW_LINK_CLASS,
  INTEGRATION_TABLE_TH_CLASS,
  INTEGRATION_TABLE_TH_LINK_CLASS,
} from './integration-table-recipe';
import { AecIcon } from '../shared/icon/icon';
import { Chip } from '../shared/chip/chip';

/**
 * One row of a powered hub's table: what the pair's card shows, and the mechanism name
 * the payload carries, already worked out by `ProductPoweredHub` with the card's own
 * helpers, so a card and its row cannot say different things.
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
  /** The direction words and glyph the card prints, or null when unknown. */
  readonly direction: { readonly label: string; readonly glyph: string | null } | null;
  /** The mechanism kind chips (`mechanismDisplay`), possibly empty. */
  readonly mechanismLabels: readonly string[];
  /** The mechanism's name when it adds to the kinds, else null. */
  readonly mechanismName: string | null;
  /** The data-object chip ("3 types of data"), or `''`. */
  readonly dataObjects: string;
}

/** Hidden below `md`: the Direction and How it connects columns, as the Integrations table's Connection. */
const MD_CELL = 'hidden px-4 py-3 md:table-cell';
/** Hidden below `lg`: the Types of data column, as the Integrations table's Categories. */
const LG_CELL = 'hidden px-4 py-3 lg:table-cell';
const MD_TH = 'hidden px-4 py-3 text-start font-semibold md:table-cell';
const LG_TH = 'hidden px-4 py-3 text-start font-semibold lg:table-cell';

/**
 * The table view of one group in "Integrations it powers" (AECI-1924): a hub, or the
 * hubless pairs. It takes the Integrations table's recipe (`integration-table-recipe.ts`)
 * and its words, and its way of narrowing: columns drop from the right as the width
 * falls, and what they held joins the meta line under the product.
 *
 * Columns, since Chris's review of 2026-11-19 ("there's more info you can show"):
 * "Integrates with" (the partner; "Products" with both names in the hubless table),
 * "Direction" (the card's words, seen from the hub) and "How it connects" (the
 * mechanism kinds and name) from `md`, and "Types of data" from `lg`. The powered-pair
 * payload carries no partner vendor, no partner categories, no data-object names and
 * no agreement, so the table shows none of them.
 *
 * The table sits inside its group card, so its frame has no radius or shadow: the Bone
 * header runs edge to edge with square corners and the card's radius clips its foot.
 *
 * The chevron is the row's one link to the pair page, with the card's accessible name. A
 * click anywhere else on the row follows it, as in the Integrations table. The rows
 * arrive in the cards' order and render in it. Nothing here sorts or cuts. The table is
 * named by its group card's heading through `aria-labelledby`.
 */
@Component({
  selector: 'aec-product-powered-table',
  imports: [AecIcon, Chip, LogoOrInitial, NgTemplateOutlet, RouterLink],
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
            <th scope="col" [class]="mdTh" i18n="@@search.facet.direction">Direction</th>
            <th scope="col" [class]="mdTh" i18n="@@products.detail.integrations.card.howItConnects">
              How it connects
            </th>
            <th scope="col" [class]="lgTh" i18n="@@products.detail.body.integrations.dataTypes">
              Types of data
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
                  <!-- The meta line: what the hidden columns hold, below their width. -->
                  <span [class]="metaClass" data-testid="powered-table-meta">
                    <span class="inline-flex items-center gap-1 md:hidden">
                      <span class="sr-only" i18n="@@products.detail.body.powers.direction.srLabel"
                        >Direction:</span
                      >
                      <ng-container
                        [ngTemplateOutlet]="directionWords"
                        [ngTemplateOutletContext]="{ $implicit: row }"
                      />
                    </span>
                    @for (label of row.mechanismLabels; track label) {
                      <span class="md:hidden" aria-hidden="true">·</span>
                      <span class="md:hidden">{{ label }}</span>
                    }
                    @if (row.dataObjects) {
                      <span class="md:hidden" aria-hidden="true">·</span>
                      <span class="lg:hidden">{{ row.dataObjects }}</span>
                    }
                  </span>
                </span>
              </td>
              <td [class]="mdCell" data-testid="powered-table-direction">
                <span class="inline-flex items-center gap-1 text-(--text-secondary)">
                  <ng-container
                    [ngTemplateOutlet]="directionWords"
                    [ngTemplateOutletContext]="{ $implicit: row }"
                  />
                </span>
              </td>
              <td [class]="mdCell" data-testid="powered-table-connects">
                <span class="flex flex-col items-start gap-1 text-(--text-secondary)">
                  @if (row.mechanismLabels.length > 0) {
                    <span class="flex flex-wrap items-center gap-1">
                      @for (label of row.mechanismLabels; track label) {
                        <aec-chip density="dense" tone="neutral">{{ label }}</aec-chip>
                      }
                    </span>
                  } @else if (!row.mechanismName) {
                    <!-- A dash only when nothing is on record: a name with no kind shows
                         the name alone. -->
                    <span
                      i18n="@@products.detail.integrations.mechanism.none"
                      i18n-aria-label="@@products.detail.integrations.mechanism.none.aria"
                      aria-label="Mechanism not listed"
                      >–</span
                    >
                  }
                  @if (row.mechanismName; as name) {
                    <span class="text-xs">{{ name }}</span>
                  }
                </span>
              </td>
              <td [class]="lgCell" data-testid="powered-table-data">
                @if (row.dataObjects) {
                  <aec-chip density="dense" tone="neutral" data-testid="hub-data-objects">{{
                    row.dataObjects
                  }}</aec-chip>
                } @else {
                  <span class="text-(--text-secondary)" aria-hidden="true">–</span>
                  <span class="sr-only" i18n="@@products.detail.body.powers.data.none"
                    >No types of data on record</span
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

    <!-- The card's direction words, or a dash for an unknown direction. -->
    <ng-template #directionWords let-row>
      @if (row.direction; as d) {
        @if (d.glyph) {
          <span
            class="inline-block leading-none text-(--accent-primary) rtl:-scale-x-100"
            aria-hidden="true"
            >{{ d.glyph }}</span
          >
        }
        <span>{{ d.label }}</span>
      } @else {
        <span
          i18n="@@products.detail.body.powers.direction.none"
          i18n-aria-label="@@products.detail.body.powers.direction.none.aria"
          aria-label="Direction not listed"
          >–</span
        >
      }
    </ng-template>
  `,
})
export class ProductPoweredTable {
  /** The group's rows, in the cards' order. */
  readonly rows = input.required<readonly PoweredTableRow[]>();
  /** The id of the group card's heading, the hub's name (or "Other connections"). */
  readonly ariaLabelledby = input.required<string>();
  /** The hubless pairs: each row names both products, under "Products". */
  readonly hubless = input(false);

  // Always inside a group card, so the nested frame (no radius, no shadow).
  protected readonly frameClass = INTEGRATION_TABLE_NESTED_FRAME_CLASS;
  protected readonly tableClass = INTEGRATION_TABLE_CLASS;
  protected readonly headClass = INTEGRATION_TABLE_HEAD_CLASS;
  protected readonly thClass = INTEGRATION_TABLE_TH_CLASS;
  protected readonly thLinkClass = INTEGRATION_TABLE_TH_LINK_CLASS;
  protected readonly bodyClass = INTEGRATION_TABLE_BODY_CLASS;
  protected readonly rowClass = INTEGRATION_TABLE_ROW_CLASS;
  protected readonly firstCellClass = INTEGRATION_TABLE_FIRST_CELL_CLASS;
  protected readonly metaClass = INTEGRATION_TABLE_META_CLASS;
  protected readonly linkCellClass = INTEGRATION_TABLE_LINK_CELL_CLASS;
  protected readonly rowLinkClass = INTEGRATION_TABLE_ROW_LINK_CLASS;
  protected readonly mdCell = MD_CELL;
  protected readonly lgCell = LG_CELL;
  protected readonly mdTh = MD_TH;
  protected readonly lgTh = LG_TH;

  /** A click anywhere on the row but a link follows the row's link (Integrations table). */
  protected onRowClick(event: MouseEvent, link: HTMLAnchorElement): void {
    forwardRowClick(event, link);
  }
}
