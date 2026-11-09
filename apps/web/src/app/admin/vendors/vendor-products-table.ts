import { AdminLogoEditor } from './admin-logo-editor/admin-logo-editor';
import { DOCUMENT, DatePipe, DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import type { AdminVendorProductRow } from '@aeci/shared';

import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';
import { AdminPaginator } from '../admin-paginator';
import { ListingHideForm, type ListingHideMode } from './listing-hide-form';

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
 * AECI-955 adds the narrow logo-only content edit exception (Stage 2.5 §11).
 *
 * AECI-1238 adds the per-product listing hide (§11d.6): a Hide or Restore row action
 * that opens {@link ListingHideForm} in the row below, and a "Hidden" badge on a
 * hidden row. A product hidden with its company is restored only by the company's
 * restore, so its Restore is disabled with a note saying so. The write is the form's;
 * the table emits {@link listingChanged} and the page refetches.
 *
 * Light theme only (Stage 1 / AECI-226).
 */
@Component({
  selector: 'aec-vendor-products-table',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AdminLogoEditor, AdminPaginator, DatePipe, DecimalPipe, ListingHideForm, NewTabIcon],
  templateUrl: './vendor-products-table.html',
})
export class VendorProductsTable {
  readonly announce = output<string>();
  protected readonly editingLogo = signal<string | null>(null);

  readonly rows = input.required<readonly AdminVendorProductRow[]>();
  readonly page = input.required<number>();
  readonly perPage = input.required<number>();
  readonly total = input.required<number>();
  readonly loading = input.required<boolean>();
  readonly failed = input.required<boolean>();

  readonly pageChange = output<number>();
  readonly retry = output<void>();
  /** A product hide or restore committed, or the product moved under the operator. */
  readonly listingChanged = output<void>();

  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);

  /** The row whose action committed. Its trigger takes focus back once the page's
   *  refetched rows land, because the Hide and Restore buttons are different elements. */
  private refocusRowId: string | null = null;

  constructor() {
    effect(() => {
      const rows = this.rows();
      const id = this.refocusRowId;
      if (!id || !rows.some((r) => r.id === id)) return;
      this.refocusRowId = null;
      afterNextRender(() => this.document.getElementById(`product-listing-action-${id}`)?.focus(), {
        injector: this.injector,
      });
    });
  }

  /** The row whose hide or restore form is open, and which action. */
  protected readonly listingFormFor = signal<{ id: string; mode: ListingHideMode } | null>(null);

  protected listingTriggerId(row: AdminVendorProductRow): string {
    return `product-listing-action-${row.id}`;
  }

  protected openListingForm(row: AdminVendorProductRow): void {
    this.listingFormFor.set({ id: row.id, mode: row.listing_hide ? 'restore' : 'hide' });
  }

  protected closeListingForm(row: AdminVendorProductRow): void {
    this.listingFormFor.set(null);
    afterNextRender(() => this.document.getElementById(this.listingTriggerId(row))?.focus(), {
      injector: this.injector,
    });
  }

  protected onListingDone(row: AdminVendorProductRow, mode: ListingHideMode): void {
    this.refocusRowId = row.id;
    this.listingFormFor.set(null);
    this.announce.emit(
      mode === 'hide'
        ? $localize`:@@admin.vendors.products.listing.announce.hidden:Product hidden. It is off the public site, and the vendor was told.`
        : $localize`:@@admin.vendors.products.listing.announce.restored:Product restored. It is back on the public site, and the vendor was told.`,
    );
    this.listingChanged.emit();
  }

  protected onListingStale(row: AdminVendorProductRow, message: string): void {
    this.refocusRowId = row.id;
    this.listingFormFor.set(null);
    this.announce.emit(message);
    this.listingChanged.emit();
  }

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
