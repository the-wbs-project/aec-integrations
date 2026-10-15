import { DatePipe } from '@angular/common';
import {
  Component,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import type { VendorProductRequest } from '@aeci/shared';

import { VendorApi } from '../vendor-api';
import { VendorPortalStore } from '../vendor-portal-store';

type LoadState = 'idle' | 'loading' | 'loaded' | 'failed';

/**
 * "Products you asked us to add" (AECI-1377, `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §4.7.6): the vendor's product requests, under "Add an integration" on the
 * Integrations tab. Every seat of the vendor sees every request.
 *
 * ── WHAT IT SHOWS ───────────────────────────────────────────────────────────
 * Newest first, as `GET /api/vendor/product-requests` returns them: the name, the
 * maker, the date and a status ("Waiting for AECi", "Added", "Already listed as
 * {name}", "Declined: {reason}"). An Added or Already listed row has "Add the
 * integration", the deep link to its context product's Integrations tab with
 * `?create=open&counterpart={slug}`. It renders nothing when there are no requests.
 *
 * ── STAYING CURRENT ─────────────────────────────────────────────────────────
 * Not a cursor scope of its own (`STAGE_2_REALTIME_SPEC.md` §2.3). A decision
 * always writes the vendor's portal row in its batch, so the `notifications`
 * scope moves, and the store refetches the feed. This list re-reads whenever the
 * store's feed changes, once it has loaded itself. The tab also calls
 * {@link reload} after a request is sent.
 *
 * Read in `afterNextRender`, never during SSR. A failed read shows a retry rather
 * than nothing, because the 409 sentence on the form points here.
 */
@Component({
  selector: 'aec-vendor-product-requests-list',
  imports: [DatePipe, RouterLink],
  host: { class: 'block' },
  template: `
    @if (state() === 'failed') {
      <div class="space-y-2" data-testid="product-requests-failed">
        <p class="text-sm text-(--text-primary)" i18n="@@vendor.productRequests.failed">
          Could not load the products you asked us to add.
        </p>
        <button
          type="button"
          [class]="retryClass"
          (click)="reload()"
          i18n="@@vendor.productRequests.retry"
        >
          Try again
        </button>
      </div>
    } @else if (requests().length > 0) {
      <section
        class="max-w-3xl space-y-3"
        aria-labelledby="vendor-product-requests-heading"
        data-testid="product-requests"
      >
        <h2 id="vendor-product-requests-heading" class="m-0">
          <!-- The size and face live on the span: styles.css sets the h2 size and
               display face outside any cascade layer, so utilities on the h2 are dead. -->
          <span
            class="block font-body text-sm font-semibold text-(--text-primary)"
            i18n="@@vendor.productRequests.heading"
            >Products you asked us to add</span
          >
        </h2>
        <ul
          class="m-0 list-none divide-y divide-(--border-default) rounded-(--radius-md) border border-(--border-default) p-0"
        >
          @for (request of requests(); track request.id) {
            <li
              class="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
              [attr.data-request-id]="request.id"
            >
              <div class="min-w-0 space-y-0.5">
                <p class="text-sm font-medium text-(--text-primary)">{{ request.name }}</p>
                <p class="text-xs text-(--text-secondary)">
                  <span>{{ request.maker }}</span>
                  <span aria-hidden="true"> · </span>
                  <span>{{ request.created_at | date: 'mediumDate' }}</span>
                </p>
                <p class="max-w-prose text-xs text-(--text-primary)" data-testid="request-status">
                  {{ statusLine(request) }}
                </p>
              </div>
              @if (addLink(request); as link) {
                <a
                  [routerLink]="link.path"
                  [queryParams]="link.queryParams"
                  [attr.aria-label]="addLabel(request)"
                  class="shrink-0 text-sm font-medium text-(--accent-primary) underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  data-testid="request-add-integration"
                  i18n="@@vendor.productRequests.add"
                  >Add the integration</a
                >
              }
            </li>
          }
        </ul>
      </section>
    }
  `,
})
export class VendorProductRequestsList {
  private readonly api = inject(VendorApi);
  private readonly store = inject(VendorPortalStore);

  /** Whether the host is the routed `…/products/:slug/integrations` page. The
   *  single-page concept links from the portal root instead. */
  readonly routed = input(false);

  protected readonly requests = signal<readonly VendorProductRequest[]>([]);
  protected readonly state = signal<LoadState>('idle');
  /** Drops a response that an overlapping later read has superseded. */
  private seq = 0;

  /** Product id → slug, from the portal's own product list, for the deep link. */
  private readonly productSlugs = computed(
    () => new Map((this.store.me()?.products ?? []).map((p) => [p.id, p.slug])),
  );

  protected readonly retryClass =
    'rounded-(--radius-sm) border border-(--border-default) px-3 py-1.5 text-sm font-medium text-(--text-primary) transition-colors hover:border-(--border-strong) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  constructor() {
    afterNextRender(() => void this.reload());

    // A moved `notifications` scope refetches the feed, so a new array here means
    // a decision may have landed. The first run only records the starting value.
    let first = true;
    effect(() => {
      this.store.notifications();
      if (first) {
        first = false;
        return;
      }
      untracked(() => {
        if (this.state() === 'loaded') void this.reload();
      });
    });
  }

  /** Re-read the list. Called after a request is sent, and on a moved feed. */
  async reload(): Promise<void> {
    const mine = ++this.seq;
    if (this.state() !== 'loaded') this.state.set('loading');
    try {
      const { requests } = await this.api.listProductRequests();
      if (mine !== this.seq) return;
      this.requests.set(requests);
      this.state.set('loaded');
    } catch {
      if (mine !== this.seq) return;
      // Keep the last good list. Only a list that never loaded shows the retry.
      if (this.requests().length === 0) this.state.set('failed');
    }
  }

  protected statusLine(request: VendorProductRequest): string {
    switch (request.status) {
      case 'open':
        return $localize`:@@vendor.productRequests.status.open:Waiting for AECi`;
      case 'added':
        return $localize`:@@vendor.productRequests.status.added:Added`;
      case 'already_listed': {
        const listed = request.resolved_product?.name ?? request.name;
        return $localize`:@@vendor.productRequests.status.alreadyListed:Already listed as ${listed}:NAME:`;
      }
      case 'declined': {
        const reason = request.decline_reason ?? '';
        return $localize`:@@vendor.productRequests.status.declined:Declined: ${reason}:REASON:`;
      }
    }
  }

  protected addLabel(request: VendorProductRequest): string {
    const name = request.resolved_product?.name ?? request.name;
    return $localize`:@@vendor.productRequests.addAria:Add the integration with ${name}:NAME:`;
  }

  /**
   * The deep link for an Added or Already listed row: the context product's
   * Integrations tab, with the form open and the product chosen. `null` when the
   * request is open or declined, has no linked product, or its context product
   * is no longer one of the vendor's.
   */
  protected addLink(
    request: VendorProductRequest,
  ): { path: readonly string[]; queryParams: Record<string, string> } | null {
    if (request.status !== 'added' && request.status !== 'already_listed') return null;
    const product = request.resolved_product;
    const slug = this.productSlugs().get(request.context_product_id);
    if (!product || !slug) return null;
    // Routed, this sits on `…/products/:productSlug/integrations`, and `..` pops one
    // URL segment (`products/:productSlug` is one route of two segments), so three
    // reach the portal root. They go in ONE command: the router reads `..` only in
    // the first command, and a later `'..'` is a literal segment. Unrouted, the link
    // resolves from the root.
    const tab = ['products', slug, 'integrations'];
    const path = this.routed() ? ['../../..', ...tab] : tab;
    return { path, queryParams: { create: 'open', counterpart: product.slug } };
  }
}
