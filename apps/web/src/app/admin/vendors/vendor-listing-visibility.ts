import { DOCUMENT, DatePipe } from '@angular/common';
import {
  Component,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';

import { isHttpsUrl, type AdminListingHideProduct, type AdminVendorDetail } from '@aeci/shared';

import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';
import { listingHideKindLabel } from '../../shared/listing-hide/listing-hide-kind-label';
import { ListingHideForm, type ListingHideMode } from './listing-hide-form';
import { SUSPENSION_BUTTON } from './vendor-suspension-model';

/**
 * "Listing visibility" on the Vendor tab of `/admin/vendors/:id` (AECI-1238,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.6, `ADMIN_PANEL_SPEC.md` §5.7).
 *
 * It says whether the company is on the public site, and when it is hidden, since
 * when, why, the vendor's reason, the internal note, the date received and the
 * source. Hide and restore open {@link ListingHideForm} inline. Its confirm step
 * lists what moves with the company: a hide takes down every joined product not
 * already hidden, and a restore brings back only the products the company's hide
 * took down. A product hidden on its own stays hidden either way.
 *
 * Reads nothing itself: the state is `listing_hide` and `listing_hide_products` on
 * the vendor read. A commit leaves through {@link changed}, and the host refetches.
 * No heading and no live region: `VendorDetail` owns both.
 */
@Component({
  selector: 'aec-vendor-listing-visibility',
  imports: [DatePipe, ListingHideForm, NewTabIcon],
  templateUrl: './vendor-listing-visibility.html',
})
export class VendorListingVisibility {
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);

  readonly vendor = input.required<AdminVendorDetail>();
  readonly idPrefix = input.required<string>();

  /** A hide or restore committed, or the listing moved under the operator. The host
   *  refetches the vendor, the products and the audit trail. */
  readonly changed = output<void>();
  /** Text for the host's polite live region. */
  readonly announce = output<string>();

  protected readonly buttonClass = SUSPENSION_BUTTON;
  protected readonly kindLabel = listingHideKindLabel;

  protected readonly formMode = signal<ListingHideMode | null>(null);

  protected readonly hide = computed(() => this.vendor().listing_hide);

  /** https only. The link is rendered as an `href`. */
  protected readonly sourceHref = computed(() => {
    const url = this.hide()?.source_url;
    return url && isHttpsUrl(url) ? url : null;
  });

  /** A hide's impact: the joined products still on the public site. */
  protected readonly willHide = computed<readonly AdminListingHideProduct[]>(() =>
    this.vendor().listing_hide_products.filter((p) => p.hidden_at === null),
  );
  /** A restore's impact: the products the company's hide took down. */
  protected readonly willRestore = computed<readonly AdminListingHideProduct[]>(() =>
    this.vendor().listing_hide_products.filter((p) => p.hidden_with_vendor),
  );
  /** Products with their own hide. Neither write touches them. */
  protected readonly hiddenOnOwn = computed(
    () =>
      this.vendor().listing_hide_products.filter(
        (p) => p.hidden_at !== null && !p.hidden_with_vendor,
      ).length,
  );

  protected triggerId(): string {
    return `${this.idPrefix()}-listing-visibility-action`;
  }

  protected open(mode: ListingHideMode): void {
    this.formMode.set(mode);
  }

  protected close(): void {
    this.formMode.set(null);
    this.focusTrigger();
  }

  protected onDone(mode: ListingHideMode): void {
    this.formMode.set(null);
    this.announce.emit(
      mode === 'hide'
        ? $localize`:@@admin.listingVisibility.announce.hidden:Listing hidden. The company and its products are off the public site, and the vendor was told.`
        : $localize`:@@admin.listingVisibility.announce.restored:Listing restored. The company is back on the public site, and the vendor was told.`,
    );
    this.changed.emit();
    this.focusTrigger();
  }

  protected onStale(message: string): void {
    this.formMode.set(null);
    this.announce.emit(message);
    this.changed.emit();
    this.focusTrigger();
  }

  private focusTrigger(): void {
    afterNextRender(() => this.document.getElementById(this.triggerId())?.focus(), {
      injector: this.injector,
    });
  }
}
