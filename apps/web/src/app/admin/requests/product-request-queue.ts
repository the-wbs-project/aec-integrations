import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import type { AdminProductRequest, ProductRequestStatus } from '@aeci/shared';

import { AecButton } from '../../shared/button/button';
import { Chip } from '../../shared/chip/chip';
import { FIELD_HINT_CLASS, FIELD_INPUT_CLASS } from '../../shared/form-field/form-field-classes';
import { AecIcon } from '../../shared/icon/icon';
import { LogoOrInitial } from '../../shared/logo-or-initial/logo-or-initial';
import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';
import {
  ProductCombobox,
  type ProductComboboxItem,
  type ProductComboboxSearch,
} from '../../shared/product-combobox/product-combobox';
import { AdminSummaryStore } from '../admin-summary.store';
import { AdminRequestsApi } from './admin-requests-api';
import { isReplayedEvent } from '../../core/event-replay';
import { CONSOLE_FILTER } from '../console/console-filter';
import {
  CONSOLE_CAPTION_CLASS,
  CONSOLE_LABEL_CLASS,
  CONSOLE_TABLE,
} from '../console/console-table';
import { AdminDisclosureButton } from '../console/disclosure-button';
import { adminStatusTone, type AdminStatusKey } from '../console/status-tones';
import {
  QUEUE_BODY_CLASS,
  QUEUE_DETAIL_GRID_CLASS,
  QUEUE_FACTS_CLASS,
  QUEUE_FAILED_CLASS,
  QUEUE_FORM_CLASS,
} from '../reviews/queue-classes';
import { queueFocusAfterRemoval } from '../reviews/queue-focus';
import { CONSOLE_FOREST_LINK_CLASS } from '../console/console-detail';

/** One request covers the backlog. The API caps `perPage` at 100. */
const PAGE_SIZE = 100;

/** The decision form open on one row. */
type Decision = 'added' | 'already_listed' | 'declined';

/** What the API's refusal means for the open form. */
type Refusal = 'not_promoted' | 'gone' | 'failed';

/**
 * Product requests from vendors (AECI-1377, `docs/ADMIN_PANEL_SPEC.md` §5.16 and
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.7.6): the third section of `/admin/requests`.
 * A seated vendor asked us to add the OTHER product of an integration, because the
 * catalog does not list it.
 *
 * Each open row has three decisions. **Added** and **Already listed** each take a
 * catalog product, chosen with the shared `aec-product-combobox` over the public
 * `GET /api/products`, which lists promoted products only. The order for Added is
 * create, promote, then decide, so the picker cannot offer a product that is not
 * there yet, and the route's `422 PRODUCT_NOT_PROMOTED` says so if it is raced.
 * **Decline** takes a required reason, which the vendor is shown.
 *
 * A decided row (`422 INVALID_STATE_TRANSITION`, or a `404`) leaves the open list
 * with an announcement, the listing-request precedent. The section keeps its own
 * polite region, like the two sections above it.
 */
@Component({
  selector: 'aec-product-request-queue',
  imports: [
    AdminDisclosureButton,
    AecButton,
    AecIcon,
    Chip,
    DatePipe,
    LogoOrInitial,
    NewTabIcon,
    ProductCombobox,
    RouterLink,
  ],
  host: { class: 'mt-14 block' },
  template: `
    <section aria-labelledby="admin-product-requests-heading" data-testid="product-request-queue">
      <h2
        id="admin-product-requests-heading"
        tabindex="-1"
        class="text-(--text-primary) focus-visible:outline-3 focus-visible:outline-offset-3"
        i18n="@@admin.productRequests.heading"
      >
        Product requests from vendors
      </h2>
      <p [class]="captionClass" class="mt-2 max-w-prose" i18n="@@admin.productRequests.lede">
        Products a vendor asked us to add so it can list an integration with them. To add one,
        create it in the review app and promote it, then mark it Added here.
      </p>

      <div [class]="f.toolbar">
        <div [class]="f.group">
          <span
            id="admin-product-requests-status-label"
            [class]="f.label"
            i18n="@@admin.requests.filter.status.label"
            >Status</span
          >
          <div role="group" aria-labelledby="admin-product-requests-status-label" [class]="f.seg">
            @for (opt of statusOptions; track opt.key) {
              <button
                type="button"
                (click)="setStatus(opt.key)"
                [attr.aria-pressed]="status() === opt.key"
                [class]="f.option"
              >
                @if (status() === opt.key) {
                  <aec-icon name="check" decorative [size]="4" />
                }
                {{ opt.label }}
              </button>
            }
          </div>
        </div>
      </div>

      <p class="sr-only" role="status" aria-live="polite">{{ liveMessage() }}</p>

      @if (loading()) {
        <p class="mt-6 text-t-16 text-(--text-secondary)" i18n="@@admin.productRequests.loading">
          Loading product requests…
        </p>
      } @else if (loadFailed()) {
        <p class="mt-6 text-t-16 font-semibold text-(--text-primary)" role="alert">
          <span i18n="@@admin.productRequests.loadFailed">We couldn't load product requests.</span>
          {{ ' ' }}
          <button aecButton variant="ghost" (click)="load()" i18n="@@admin.requests.retry">
            Try again
          </button>
        </p>
      } @else if (rows().length === 0) {
        <p [class]="t.empty" class="mt-6" i18n="@@admin.productRequests.empty">
          No product requests match this filter.
        </p>
      } @else {
        @if (truncated()) {
          <p
            [class]="captionClass"
            class="mt-6"
            data-testid="product-requests-capped"
            i18n="@@admin.productRequests.cappedNote"
          >
            Showing the first {{ rows().length }} of {{ total() }} product requests. Decide these to
            see the rest.
          </p>
        }
        <div
          [class]="t.region"
          class="mt-6"
          role="region"
          tabindex="0"
          aria-labelledby="admin-product-requests-caption"
        >
          <table [class]="t.table" class="min-w-[52rem]">
            <caption
              id="admin-product-requests-caption"
              [class]="t.caption"
              i18n="@@admin.productRequests.heading"
            >
              Product requests from vendors
            </caption>
            <thead>
              <tr>
                <th scope="col" [class]="t.head">
                  <span class="sr-only" i18n="@@admin.reviews.col.details">Details</span>
                </th>
                <th scope="col" [class]="t.head" i18n="@@admin.requests.col.product">Product</th>
                <th scope="col" [class]="t.head" i18n="@@admin.productRequests.vendor">Vendor</th>
                <th scope="col" [class]="t.head" i18n="@@admin.productRequests.theirProduct">
                  Their product
                </th>
                <th scope="col" [class]="t.head">
                  <span i18n="@@admin.requests.meta.submitted">Submitted</span>
                </th>
                <th scope="col" [class]="t.head">
                  <span i18n="@@admin.requests.filter.status.label">Status</span>
                </th>
              </tr>
            </thead>
            @for (r of rows(); track r.id) {
              <tbody [attr.data-product-request]="r.id">
                <tr [class]="isOpen(r.id) ? t.rowOpen : t.row">
                  <td [class]="t.disclosure">
                    <aec-admin-disclosure-button
                      [expanded]="isOpen(r.id)"
                      [controls]="'product-request-' + r.id + '-detail'"
                      [label]="rowLabel(r)"
                      (toggled)="toggleRow(r.id)"
                    />
                  </td>
                  <th scope="row" [id]="'product-request-' + r.id" [class]="t.rowHead">
                    {{ r.name }}
                    <span [class]="t.sub">{{ r.maker }}</span>
                  </th>
                  <td [class]="t.cell">
                    @if (r.vendor; as vendor) {
                      <a [routerLink]="['/admin/vendors', vendor.id]" [class]="t.link">{{
                        vendor.name
                      }}</a>
                    } @else {
                      <span class="text-(--text-secondary)" i18n="@@admin.productRequests.gone"
                        >No longer on record</span
                      >
                    }
                  </td>
                  <td [class]="t.cell">
                    @if (r.context_product; as product) {
                      {{ product.name }}
                    } @else {
                      <span class="text-(--text-secondary)" i18n="@@admin.productRequests.gone"
                        >No longer on record</span
                      >
                    }
                  </td>
                  <td [class]="t.nowrap">{{ r.created_at | date: 'medium' }}</td>
                  <td [class]="t.cell">
                    <aec-chip density="dense" [tone]="statusTone(r.status)">{{
                      statusLabel(r.status)
                    }}</aec-chip>
                  </td>
                </tr>
                <tr
                  [id]="'product-request-' + r.id + '-detail'"
                  [class]="t.detailRow"
                  [hidden]="!isOpen(r.id)"
                >
                  <td [attr.colspan]="columnCount" [class]="t.detailCell">
                    <div [class]="t.detailInner">
                      <div [class]="detailGridClass">
                        <div class="grid min-w-0 content-start gap-4">
                          <dl [class]="factsClass">
                            <div>
                              <dt [class]="labelClass" i18n="@@admin.productRequests.maker">
                                Maker
                              </dt>
                              <dd class="mt-1">{{ r.maker }}</dd>
                            </div>
                            @if (r.website) {
                              <div class="min-w-0">
                                <dt [class]="labelClass" i18n="@@admin.listingRequests.website">
                                  Website
                                </dt>
                                <dd class="mt-1 break-all">
                                  {{ r.website }}
                                  <a
                                    [href]="r.website"
                                    target="_blank"
                                    rel="noopener nofollow"
                                    [class]="inlineLinkClass"
                                    class="ms-1"
                                    ><span i18n="@@admin.listingRequests.open">Open</span>
                                    <aec-new-tab-icon
                                  /></a>
                                </dd>
                              </div>
                            }
                          </dl>
                          @if (r.body) {
                            <div>
                              <p [class]="labelClass" i18n="@@admin.productRequests.note">Note</p>
                              <p [class]="bodyClass" class="mt-2">{{ r.body }}</p>
                            </div>
                          }
                        </div>

                        <div class="grid min-w-0 content-start gap-4">
                          @if (r.status !== 'open') {
                            <p
                              class="text-t-14 text-(--text-primary)"
                              data-testid="product-request-outcome"
                            >
                              {{ outcomeLine(r) }}
                            </p>
                          } @else if (openId() === r.id && decision(); as kind) {
                            <form
                              method="dialog"
                              [class]="formClass"
                              novalidate
                              (submit)="submit($event, r)"
                              (keydown.escape)="onEscape($event, r)"
                              [attr.aria-label]="formLabel(kind, r)"
                              data-testid="product-request-decision"
                            >
                              @if (kind === 'declined') {
                                <label
                                  [for]="'product-request-reason-' + r.id"
                                  [class]="labelClass"
                                  i18n="@@admin.productRequests.reason.label"
                                  >Reason</label
                                >
                                <textarea
                                  [id]="'product-request-reason-' + r.id"
                                  rows="3"
                                  maxlength="1000"
                                  [value]="reason()"
                                  (input)="onReason($event)"
                                  aria-required="true"
                                  [attr.aria-invalid]="formError() ? 'true' : null"
                                  [attr.aria-describedby]="
                                    'product-request-reason-hint-' +
                                    r.id +
                                    (formError() ? ' product-request-error-' + r.id : '')
                                  "
                                  [class]="inputClass"
                                  class="min-h-24 resize-y py-3"
                                ></textarea>
                                <p
                                  [id]="'product-request-reason-hint-' + r.id"
                                  [class]="hintClass"
                                  i18n="@@admin.productRequests.reason.hint"
                                >
                                  The vendor sees this reason.
                                </p>
                              } @else {
                                @if (chosen(); as product) {
                                  <p [class]="labelClass">
                                    <span i18n="@@admin.productRequests.product.label"
                                      >The product in the catalog</span
                                    >
                                  </p>
                                  <div
                                    class="flex max-w-sm items-center gap-3 rounded-control border border-(--border-default) bg-(--surface-base) px-3 py-2"
                                    data-testid="product-request-chosen"
                                  >
                                    <aec-logo-or-initial
                                      [claimStatus]="'stored'"
                                      [src]="product.logo_url ?? null"
                                      [name]="product.name"
                                      size="sm"
                                    />
                                    <span class="flex min-w-0 flex-1 flex-col">
                                      <span
                                        class="truncate text-t-14 font-semibold text-(--text-primary)"
                                        >{{ product.name }}</span
                                      >
                                      @if (product.vendor; as vendor) {
                                        <span class="truncate text-t-13 text-(--text-secondary)">{{
                                          vendor.name
                                        }}</span>
                                      }
                                    </span>
                                    <button
                                      aecButton
                                      variant="secondary"
                                      compact
                                      (click)="chosen.set(null)"
                                      [attr.aria-label]="changeLabel(product.name)"
                                      i18n="@@admin.productRequests.product.change"
                                    >
                                      Change
                                    </button>
                                  </div>
                                } @else {
                                  <label
                                    [for]="'product-request-search-' + r.id"
                                    [class]="labelClass"
                                    i18n="@@admin.productRequests.product.label"
                                    >The product in the catalog</label
                                  >
                                  <aec-product-combobox
                                    class="max-w-sm"
                                    [inputId]="'product-request-search-' + r.id"
                                    [search]="search"
                                    [invalid]="!!formError()"
                                    [describedBy]="
                                      'product-request-search-hint-' +
                                      r.id +
                                      (formError() ? ' product-request-error-' + r.id : '')
                                    "
                                    (picked)="onPicked($event)"
                                    (announce)="liveMessage.set($event)"
                                  />
                                  <p
                                    [id]="'product-request-search-hint-' + r.id"
                                    [class]="hintClass"
                                    i18n="@@admin.productRequests.product.hint"
                                  >
                                    Only promoted products are listed. Promote a new product first.
                                  </p>
                                }
                              }
                              @if (formError(); as message) {
                                <p
                                  [id]="'product-request-error-' + r.id"
                                  tabindex="-1"
                                  role="alert"
                                  [class]="failedClass"
                                >
                                  {{ message }}
                                </p>
                              }
                              <div class="mt-2 flex flex-wrap items-center gap-3">
                                <button
                                  aecButton
                                  [variant]="kind === 'declined' ? 'danger' : 'primary'"
                                  compact
                                  type="submit"
                                  [disabled]="pending()"
                                  [attr.aria-describedby]="'product-request-' + r.id"
                                  data-testid="product-request-confirm"
                                >
                                  {{ confirmLabel(kind) }}
                                </button>
                                <button
                                  aecButton
                                  variant="ghost"
                                  (click)="dismiss(r)"
                                  [disabled]="pending()"
                                  i18n="@@admin.productRequests.cancel"
                                >
                                  Cancel
                                </button>
                              </div>
                            </form>
                          } @else {
                            <div class="flex flex-wrap items-center gap-3">
                              @for (opt of decisionOptions; track opt.key) {
                                <button
                                  aecButton
                                  variant="secondary"
                                  [id]="'product-request-' + r.id + '-' + opt.key"
                                  (click)="start(r, opt.key)"
                                  [attr.data-decision]="opt.key"
                                  [attr.aria-describedby]="'product-request-' + r.id"
                                >
                                  {{ opt.label }}
                                </button>
                              }
                            </div>
                          }
                        </div>
                      </div>
                    </div>
                  </td>
                </tr>
              </tbody>
            }
          </table>
        </div>
      }
    </section>
  `,
})
export class ProductRequestQueue {
  private readonly api = inject(AdminRequestsApi);
  private readonly summaryStore = inject(AdminSummaryStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  // AECI-2111: the console recipe and the queues' shared detail-row classes.
  protected readonly t = CONSOLE_TABLE;
  protected readonly f = CONSOLE_FILTER;
  protected readonly labelClass = CONSOLE_LABEL_CLASS;
  protected readonly captionClass = CONSOLE_CAPTION_CLASS;
  protected readonly inputClass = FIELD_INPUT_CLASS;
  protected readonly hintClass = FIELD_HINT_CLASS;
  protected readonly inlineLinkClass = CONSOLE_FOREST_LINK_CLASS;
  protected readonly detailGridClass = QUEUE_DETAIL_GRID_CLASS;
  protected readonly bodyClass = QUEUE_BODY_CLASS;
  protected readonly factsClass = QUEUE_FACTS_CLASS;
  protected readonly formClass = QUEUE_FORM_CLASS;
  protected readonly failedClass = QUEUE_FAILED_CLASS;
  /** Disclosure, product, vendor, their product, submitted, status. */
  protected readonly columnCount = 6;

  /** The rows whose detail is open. */
  private readonly openIds = signal<ReadonlySet<string>>(new Set());

  protected readonly rows = signal<readonly AdminProductRequest[]>([]);
  protected readonly total = signal(0);
  protected readonly truncated = computed(() => this.total() > this.rows().length);
  private loadSeq = 0;
  protected readonly status = signal<ProductRequestStatus>('open');
  protected readonly loading = signal(true);
  protected readonly loadFailed = signal(false);
  protected readonly liveMessage = signal('');

  /** The row whose decision form is open, and which decision. One at a time. */
  protected readonly openId = signal<string | null>(null);
  protected readonly decision = signal<Decision | null>(null);
  protected readonly chosen = signal<ProductComboboxItem | null>(null);
  protected readonly reason = signal('');
  protected readonly pending = signal(false);
  protected readonly formError = signal<string | null>(null);

  /** The public product search, A to Z: promoted products only. */
  protected readonly search: ProductComboboxSearch = (query) => this.api.searchProducts(query);

  protected readonly statusOptions: ReadonlyArray<{ key: ProductRequestStatus; label: string }> = [
    { key: 'open', label: $localize`:@@admin.requests.filter.status.open:Open` },
    { key: 'added', label: $localize`:@@admin.productRequests.filter.added:Added` },
    {
      key: 'already_listed',
      label: $localize`:@@admin.productRequests.filter.alreadyListed:Already listed`,
    },
    { key: 'declined', label: $localize`:@@admin.productRequests.filter.declined:Declined` },
  ];

  protected readonly decisionOptions: ReadonlyArray<{ key: Decision; label: string }> = [
    { key: 'added', label: $localize`:@@admin.productRequests.action.added:Added` },
    {
      key: 'already_listed',
      label: $localize`:@@admin.productRequests.action.alreadyListed:Already listed`,
    },
    { key: 'declined', label: $localize`:@@admin.productRequests.action.decline:Decline` },
  ];

  constructor() {
    afterNextRender(() => void this.load());
  }

  protected async load(): Promise<void> {
    const seq = ++this.loadSeq;
    this.loading.set(true);
    this.loadFailed.set(false);
    try {
      const res = await this.api.listProductRequests({
        status: this.status(),
        page: 1,
        perPage: PAGE_SIZE,
      });
      if (seq !== this.loadSeq) return;
      this.rows.set(res.data);
      this.total.set(res.total);
    } catch {
      if (seq === this.loadSeq) this.loadFailed.set(true);
    } finally {
      if (seq === this.loadSeq) this.loading.set(false);
    }
  }

  protected setStatus(status: ProductRequestStatus): void {
    if (this.status() === status) return;
    this.status.set(status);
    this.cancel();
    void this.load();
  }

  protected start(row: AdminProductRequest, kind: Decision): void {
    this.openId.set(row.id);
    this.decision.set(kind);
    this.chosen.set(null);
    this.reason.set('');
    this.formError.set(null);
    // The opener leaves the DOM with the form open, so move focus into its field.
    this.focusAfterRender(
      kind === 'declined' ? `product-request-reason-${row.id}` : `product-request-search-${row.id}`,
    );
  }

  /** Cancel: close the form and return focus to the decision that opened it. */
  protected dismiss(row: AdminProductRequest): void {
    if (this.pending()) return;
    const kind = this.decision();
    this.cancel();
    if (kind) this.focusAfterRender(`product-request-${row.id}-${kind}`);
  }

  /** Escape closes the form, unless it was closing the product picker's open list. */
  protected onEscape(event: Event, row: AdminProductRequest): void {
    const target = event.target as HTMLElement | null;
    if (
      target?.hasAttribute('data-product-combobox-input') &&
      target.getAttribute('aria-expanded') === 'true'
    ) {
      return;
    }
    this.dismiss(row);
  }

  protected cancel(): void {
    this.openId.set(null);
    this.decision.set(null);
    this.chosen.set(null);
    this.reason.set('');
    this.formError.set(null);
  }

  protected onPicked(product: ProductComboboxItem): void {
    this.chosen.set(product);
    this.formError.set(null);
  }

  protected onReason(event: Event): void {
    this.reason.set((event.target as HTMLTextAreaElement).value);
    this.formError.set(null);
  }

  protected async submit(event: Event, row: AdminProductRequest): Promise<void> {
    if (isReplayedEvent(event)) return;
    event.preventDefault();
    const kind = this.decision();
    if (!kind || this.pending()) return;
    this.formError.set(null);

    let body;
    if (kind === 'declined') {
      const reason = this.reason().trim();
      if (reason === '') {
        this.formError.set(
          $localize`:@@admin.productRequests.error.reason:Enter a reason. The vendor sees it.`,
        );
        return;
      }
      body = { outcome: kind, reason } as const;
    } else {
      const product = this.chosen();
      if (!product) {
        this.formError.set(
          $localize`:@@admin.productRequests.error.product:Choose the product in the catalog.`,
        );
        return;
      }
      body = { outcome: kind, product_id: product.id } as const;
    }

    this.pending.set(true);
    try {
      await this.api.decideProductRequest(row.id, body);
      this.drop(row.id);
      this.summaryStore.decrement('requests');
      this.liveMessage.set(this.doneMessage(kind, row.name));
      this.cancel();
    } catch (err) {
      switch (refusalOf(err)) {
        case 'not_promoted':
          this.formError.set(
            $localize`:@@admin.productRequests.error.notPromoted:That product is not promoted yet. Promote it from the review app, then try again.`,
          );
          break;
        case 'gone':
          // Another admin decided it first. The row leaves the open list.
          this.drop(row.id);
          this.cancel();
          this.liveMessage.set(
            $localize`:@@admin.productRequests.announce.alreadyDecided:That request was already decided.`,
          );
          break;
        default:
          this.formError.set(
            $localize`:@@admin.requests.action.failed:Something went wrong. Please try again.`,
          );
      }
      // A refused decision moves focus to its message. (A form refused before the
      // request, for a missing reason or product, keeps focus where it was.)
      if (this.formError()) this.focusAfterRender(`product-request-error-${row.id}`);
    } finally {
      this.pending.set(false);
    }
  }

  protected outcomeLine(row: AdminProductRequest): string {
    const product = row.resolved_product?.name ?? row.name;
    switch (row.status) {
      case 'added':
        return $localize`:@@admin.productRequests.outcome.added:Added as ${product}:PRODUCT:.`;
      case 'already_listed':
        return $localize`:@@admin.productRequests.outcome.alreadyListed:Already listed as ${product}:PRODUCT:.`;
      case 'declined': {
        const reason = row.decline_reason ?? '';
        return $localize`:@@admin.productRequests.outcome.declined:Declined. Reason: ${reason}:REASON:`;
      }
      default:
        return '';
    }
  }

  protected formLabel(kind: Decision, row: AdminProductRequest): string {
    const name = row.name;
    switch (kind) {
      case 'added':
        return $localize`:@@admin.productRequests.form.added:Mark ${name}:NAME: as added`;
      case 'already_listed':
        return $localize`:@@admin.productRequests.form.alreadyListed:Mark ${name}:NAME: as already listed`;
      case 'declined':
        return $localize`:@@admin.productRequests.form.declined:Decline ${name}:NAME:`;
    }
  }

  protected confirmLabel(kind: Decision): string {
    switch (kind) {
      case 'added':
        return $localize`:@@admin.productRequests.confirm.added:Mark as added`;
      case 'already_listed':
        return $localize`:@@admin.productRequests.confirm.alreadyListed:Mark as already listed`;
      case 'declined':
        return $localize`:@@admin.productRequests.confirm.declined:Decline request`;
    }
  }

  protected changeLabel(name: string): string {
    return $localize`:@@admin.productRequests.product.changeAria:Change the product, now ${name}:PRODUCT:`;
  }

  private doneMessage(kind: Decision, name: string): string {
    switch (kind) {
      case 'added':
        return $localize`:@@admin.productRequests.announce.added:${name}:NAME: marked as added. The vendor has been told.`;
      case 'already_listed':
        return $localize`:@@admin.productRequests.announce.alreadyListed:${name}:NAME: marked as already listed. The vendor has been told.`;
      case 'declined':
        return $localize`:@@admin.productRequests.announce.declined:${name}:NAME: declined. The vendor has been told.`;
    }
  }

  /** The chip tone for a product request status. Exhaustive: a new status fails to compile. */
  protected statusTone(status: ProductRequestStatus) {
    let key: AdminStatusKey;
    switch (status) {
      case 'open':
        key = 'open';
        break;
      case 'added':
        key = 'added';
        break;
      case 'already_listed':
        key = 'alreadyListed';
        break;
      case 'declined':
        key = 'declined';
        break;
    }
    return adminStatusTone(key);
  }

  /** The status in words: the filter's own labels. */
  protected statusLabel(status: ProductRequestStatus): string {
    return this.statusOptions.find((o) => o.key === status)?.label ?? status;
  }

  protected isOpen(id: string): boolean {
    return this.openIds().has(id);
  }

  protected toggleRow(id: string): void {
    this.openIds.update((ids) => {
      const next = new Set(ids);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** The row's name, true open or closed: `aria-expanded` carries the state. */
  protected rowLabel(row: AdminProductRequest): string {
    const name = row.name;
    const vendor = row.vendor?.name ?? $localize`:@@admin.productRequests.gone:No longer on record`;
    return $localize`:@@admin.productRequests.row.label:Product request for ${name}:name: from ${vendor}:vendor:`;
  }

  /** Drop a decided row, then move focus by the queues' one rule (AECI-2102). */
  private drop(id: string): void {
    const index = this.rows().findIndex((r) => r.id === id);
    this.rows.update((list) => list.filter((r) => r.id !== id));
    this.total.update((n) => Math.max(0, n - 1));
    this.openIds.update((ids) => {
      if (!ids.has(id)) return ids;
      const next = new Set(ids);
      next.delete(id);
      return next;
    });
    const target = queueFocusAfterRemoval(index, 1, 1, this.rows());
    if (target.kind === 'none') return;
    this.focusAfterRender(
      target.kind === 'heading' ? 'admin-product-requests-heading' : undefined,
      target.kind === 'row'
        ? `[aria-controls="product-request-${target.row.id}-detail"]`
        : undefined,
    );
  }

  /** Focus an element of this section once the next render lands. */
  private focusAfterRender(elementId: string | undefined, selector?: string): void {
    const query = selector ?? `[id="${elementId}"]`;
    afterNextRender(
      { write: () => this.host.nativeElement.querySelector<HTMLElement>(query)?.focus() },
      { injector: this.injector },
    );
  }
}

/** Map a failed decision to what the form does next. */
function refusalOf(err: unknown): Refusal {
  if (!(err instanceof HttpErrorResponse)) return 'failed';
  const code = (err.error as { error?: { code?: unknown } } | null)?.error?.code;
  if (err.status === 422 && code === 'PRODUCT_NOT_PROMOTED') return 'not_promoted';
  if (err.status === 422 || err.status === 404) return 'gone';
  return 'failed';
}
