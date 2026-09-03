import { DatePipe, DecimalPipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';

import type { AdminVendorProductRow } from '@aeci/shared';

import { AdminPaginator } from '../admin-paginator';

/**
 * The Products tab on `/admin/vendors/:id` — the vendor's catalogue as a table
 * (`ADMIN_PANEL_SPEC.md` §5.7).
 *
 * ── PRESENTATION ONLY ────────────────────────────────────────────────────────
 * Same contract as `<aec-audit-trail>`: rows, page state and the paginator in
 * here; the fetch, the page number and the retry in the page that owns them.
 * That is what lets the tab render its loading, failed and empty states without
 * the parent branching on them.
 *
 * ── WHY A TABLE ──────────────────────────────────────────────────────────────
 * Every field is short and every row has the same fields, and the operator's
 * question is comparative — which of these products is unpromoted, which one
 * carries the integrations, is this vendor a connector shop. Cards would make
 * each row a paragraph and defeat the scan.
 *
 * ── THE COLUMNS ARE A FIRST CUT ──────────────────────────────────────────────
 * Name (+ slug), role, ownership, promotion status, integrations, reviews and
 * record age, plus a link to the public page. Role and promotion status are
 * here because they are the two fields that decide what the operator may do
 * next: role is the §5.2 payer test per product (the Basics block shows only the
 * vendor-level roll-up, which cannot say WHICH product is the connector), and
 * promotion status is the one field that explains a product missing from the
 * public site. There is no admin product detail page to link to, so the name
 * points at the public page in a new tab — same rule as View Page in Basics: an
 * operator opens it to CHECK something, so navigating away is the wrong outcome.
 *
 * ── READ-ONLY, DELIBERATELY ──────────────────────────────────────────────────
 * There is no admin product-edit endpoint and this tab does not invent one.
 * Catalog data flows from the review app through `POST /api/promote`; the same
 * lockout the vendor page's docblock records applies here.
 *
 * Light theme only (Stage 1 / AECI-226).
 */
@Component({
  selector: 'aec-vendor-products-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AdminPaginator, DatePipe, DecimalPipe],
  templateUrl: './vendor-products-table.html',
})
export class VendorProductsTable {
  readonly rows = input.required<readonly AdminVendorProductRow[]>();
  readonly page = input.required<number>();
  readonly perPage = input.required<number>();
  readonly total = input.required<number>();
  readonly loading = input.required<boolean>();
  readonly failed = input.required<boolean>();

  readonly pageChange = output<number>();
  readonly retry = output<void>();

  protected readonly isEmpty = computed(() => this.rows().length === 0);

  /**
   * The role, in the operator's words rather than the column's.
   *
   * The raw values (`application` / `connector` / `hybrid`) are the §8.8 payer
   * vocabulary and mean something specific: an endpoint product is one AECi can
   * sell verification to, and `hybrid` counts as an endpoint. Printing the bare
   * enum would make the reader carry that mapping in their head on the one
   * screen where the decision is taken.
   */
  protected roleLabel(row: AdminVendorProductRow): string {
    switch (row.product_role) {
      case 'connector':
        return $localize`:@@admin.vendors.products.role.connector:Connector`;
      case 'hybrid':
        return $localize`:@@admin.vendors.products.role.hybrid:Hybrid (counts as an endpoint)`;
      default:
        return $localize`:@@admin.vendors.products.role.application:Application`;
    }
  }
}
