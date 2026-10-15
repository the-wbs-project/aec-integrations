import { DatePipe } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { AdminProductRequest, ProductRequestStatus } from '@aeci/shared';

import { LogoOrInitial } from '../../shared/logo-or-initial/logo-or-initial';
import { NewTabIcon } from '../../shared/new-tab-icon/new-tab-icon';
import {
  ProductCombobox,
  type ProductComboboxItem,
  type ProductComboboxSearch,
} from '../../shared/product-combobox/product-combobox';
import { AdminSummaryStore } from '../admin-summary.store';
import { AdminRequestsApi } from './admin-requests-api';

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
  imports: [DatePipe, LogoOrInitial, NewTabIcon, ProductCombobox, RouterLink],
  host: { class: 'mt-14 block' },
  template: `
    <section aria-labelledby="admin-product-requests-heading" data-testid="product-request-queue">
      <div class="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2
            id="admin-product-requests-heading"
            class="text-lg font-bold text-(--text-primary)"
            i18n="@@admin.productRequests.heading"
          >
            Product requests from vendors
          </h2>
          <p class="mt-1 text-sm text-(--text-secondary)" i18n="@@admin.productRequests.lede">
            Products a vendor asked us to add so it can list an integration with them. To add one,
            create it in the review app and promote it, then mark it Added here.
          </p>
        </div>
        <div
          role="group"
          aria-labelledby="admin-product-requests-heading"
          class="inline-flex flex-wrap gap-1 rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-1"
        >
          @for (opt of statusOptions; track opt.key) {
            <button
              type="button"
              (click)="setStatus(opt.key)"
              [attr.aria-pressed]="status() === opt.key"
              class="rounded-(--radius-sm) px-3 py-1 text-xs font-bold text-(--text-secondary) transition-colors hover:text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) aria-pressed:bg-(--accent-primary) aria-pressed:text-(--surface-base)"
            >
              {{ opt.label }}
            </button>
          }
        </div>
      </div>

      <p class="sr-only" role="status" aria-live="polite">{{ liveMessage() }}</p>

      @if (loading()) {
        <p class="mt-6 text-sm text-(--text-secondary)" i18n="@@admin.productRequests.loading">
          Loading product requests…
        </p>
      } @else if (loadFailed()) {
        <p class="mt-6 text-sm font-medium text-(--text-primary)" role="alert">
          <span i18n="@@admin.productRequests.loadFailed">We couldn't load product requests.</span>
          {{ ' ' }}
          <button
            type="button"
            (click)="load()"
            class="font-semibold text-(--accent-primary) underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@admin.requests.retry"
          >
            Try again
          </button>
        </p>
      } @else if (rows().length === 0) {
        <p class="mt-6 text-sm text-(--text-secondary)" i18n="@@admin.productRequests.empty">
          No product requests match this filter.
        </p>
      } @else {
        @if (truncated()) {
          <p
            class="mt-6 text-xs text-(--text-secondary)"
            data-testid="product-requests-capped"
            i18n="@@admin.productRequests.cappedNote"
          >
            Showing the first {{ rows().length }} of {{ total() }} product requests. Decide these to
            see the rest.
          </p>
        }
        <ul role="list" class="mt-6 space-y-5">
          @for (r of rows(); track r.id) {
            <li>
              <article
                [attr.aria-labelledby]="'product-request-' + r.id"
                class="rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-6"
                [attr.data-product-request]="r.id"
              >
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <h3
                    [id]="'product-request-' + r.id"
                    class="text-base font-bold text-(--text-primary)"
                  >
                    {{ r.name }}
                  </h3>
                  <span class="shrink-0 text-xs text-(--text-secondary)">{{
                    r.created_at | date: 'medium'
                  }}</span>
                </div>
                <dl
                  class="mt-3 grid gap-x-6 gap-y-1 text-xs text-(--text-secondary) sm:grid-cols-2"
                >
                  <div class="flex flex-wrap gap-1.5">
                    <dt class="font-bold" i18n="@@admin.productRequests.maker">Maker</dt>
                    <dd>{{ r.maker }}</dd>
                  </div>
                  <div class="flex flex-wrap gap-1.5">
                    <dt class="font-bold" i18n="@@admin.productRequests.vendor">Vendor</dt>
                    <dd>
                      @if (r.vendor; as vendor) {
                        <a
                          [routerLink]="['/admin/vendors', vendor.id]"
                          class="font-medium text-(--accent-primary) underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                          >{{ vendor.name }}</a
                        >
                      } @else {
                        <span i18n="@@admin.productRequests.gone">No longer on record</span>
                      }
                    </dd>
                  </div>
                  <div class="flex flex-wrap gap-1.5">
                    <dt class="font-bold" i18n="@@admin.productRequests.theirProduct">
                      Their product
                    </dt>
                    <dd>
                      @if (r.context_product; as product) {
                        {{ product.name }}
                      } @else {
                        <span i18n="@@admin.productRequests.gone">No longer on record</span>
                      }
                    </dd>
                  </div>
                  @if (r.website) {
                    <div class="flex flex-wrap gap-1.5">
                      <dt class="font-bold" i18n="@@admin.listingRequests.website">Website</dt>
                      <dd class="break-all">
                        {{ r.website }}
                        <a
                          [href]="r.website"
                          target="_blank"
                          rel="noopener noreferrer nofollow"
                          class="ms-1 inline-flex items-center gap-1 font-medium text-(--accent-primary) underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                          ><span i18n="@@admin.listingRequests.open">Open</span> <aec-new-tab-icon
                        /></a>
                      </dd>
                    </div>
                  }
                </dl>
                @if (r.body) {
                  <div class="mt-4">
                    <p
                      class="text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)"
                      i18n="@@admin.productRequests.note"
                    >
                      Note
                    </p>
                    <p
                      class="mt-1 whitespace-pre-line text-sm leading-relaxed text-(--text-secondary)"
                    >
                      {{ r.body }}
                    </p>
                  </div>
                }

                @if (r.status !== 'open') {
                  <p
                    class="mt-4 text-sm text-(--text-primary)"
                    data-testid="product-request-outcome"
                  >
                    {{ outcomeLine(r) }}
                  </p>
                } @else if (openId() === r.id && decision(); as kind) {
                  <form
                    class="mt-5 space-y-3 border-t border-(--border-default) pt-4"
                    novalidate
                    (submit)="submit($event, r)"
                    [attr.aria-label]="formLabel(kind, r)"
                    data-testid="product-request-decision"
                  >
                    @if (kind === 'declined') {
                      <label
                        [for]="'product-request-reason-' + r.id"
                        class="block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)"
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
                        class="w-full max-w-xl rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2 text-sm text-(--text-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                      ></textarea>
                      <p
                        [id]="'product-request-reason-hint-' + r.id"
                        class="text-xs text-(--text-secondary)"
                        i18n="@@admin.productRequests.reason.hint"
                      >
                        The vendor sees this reason.
                      </p>
                    } @else {
                      @if (chosen(); as product) {
                        <p
                          class="text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)"
                          i18n="@@admin.productRequests.product.label"
                        >
                          The product in the catalog
                        </p>
                        <div
                          class="flex max-w-sm items-center gap-3 rounded-(--radius-md) border border-(--border-default) bg-(--surface-base) px-3 py-2"
                          data-testid="product-request-chosen"
                        >
                          <aec-logo-or-initial
                            [src]="product.logo_url ?? null"
                            [name]="product.name"
                            size="sm"
                          />
                          <span class="flex min-w-0 flex-1 flex-col">
                            <span class="truncate text-sm font-medium text-(--text-primary)">{{
                              product.name
                            }}</span>
                            @if (product.vendor; as vendor) {
                              <span class="truncate text-xs text-(--text-secondary)">{{
                                vendor.name
                              }}</span>
                            }
                          </span>
                          <button
                            type="button"
                            (click)="chosen.set(null)"
                            [attr.aria-label]="changeLabel(product.name)"
                            class="inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-default) px-3 py-1.5 text-sm font-medium text-(--text-primary) hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                            i18n="@@admin.productRequests.product.change"
                          >
                            Change
                          </button>
                        </div>
                      } @else {
                        <label
                          [for]="'product-request-search-' + r.id"
                          class="block text-xs font-bold uppercase tracking-[0.08em] text-(--text-secondary)"
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
                          class="text-xs text-(--text-secondary)"
                          i18n="@@admin.productRequests.product.hint"
                        >
                          Only promoted products are listed. Promote a new product first.
                        </p>
                      }
                    }
                    @if (formError(); as message) {
                      <p
                        [id]="'product-request-error-' + r.id"
                        role="alert"
                        class="text-sm font-medium text-(--text-primary)"
                      >
                        {{ message }}
                      </p>
                    }
                    <div class="flex flex-wrap items-center gap-3">
                      <button
                        type="submit"
                        [disabled]="pending()"
                        class="inline-flex items-center justify-center rounded-(--radius-md) bg-(--accent-primary) px-5 py-2 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50"
                        data-testid="product-request-confirm"
                      >
                        {{ confirmLabel(kind) }}
                      </button>
                      <button
                        type="button"
                        (click)="cancel()"
                        [disabled]="pending()"
                        class="inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-5 py-2 text-sm font-bold text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary) disabled:cursor-not-allowed disabled:opacity-50"
                        i18n="@@admin.productRequests.cancel"
                      >
                        Cancel
                      </button>
                    </div>
                  </form>
                } @else {
                  <div class="mt-5 flex flex-wrap items-center gap-3">
                    @for (opt of decisionOptions; track opt.key) {
                      <button
                        type="button"
                        (click)="start(r, opt.key)"
                        [attr.data-decision]="opt.key"
                        [class]="opt.key === 'declined' ? secondaryClass : primaryClass"
                      >
                        {{ opt.label }}
                      </button>
                    }
                  </div>
                }
              </article>
            </li>
          }
        </ul>
      }
    </section>
  `,
})
export class ProductRequestQueue {
  private readonly api = inject(AdminRequestsApi);
  private readonly summaryStore = inject(AdminSummaryStore);

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

  protected readonly primaryClass =
    'inline-flex items-center justify-center rounded-(--radius-md) bg-(--accent-primary) px-5 py-2 text-sm font-bold text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';
  protected readonly secondaryClass =
    'inline-flex items-center justify-center rounded-(--radius-md) border border-(--border-strong) bg-(--surface-base) px-5 py-2 text-sm font-bold text-(--text-primary) transition-colors hover:bg-(--surface-sunken) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

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

  private drop(id: string): void {
    this.rows.update((list) => list.filter((r) => r.id !== id));
    this.total.update((n) => Math.max(0, n - 1));
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
