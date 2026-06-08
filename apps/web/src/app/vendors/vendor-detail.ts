import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type { ProductListItem, VendorDetail } from '@aeci/shared';

import { DetailLayout } from '../layouts/detail-layout';
import { NotFound } from '../not-found/not-found';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';

/**
 * AECI-59 — Vendor detail page at `/vendors/:slug`.
 *
 * Single page (no tabs — Phase 2 vendor pages are single-view per Stage 1
 * Spec §4.2.1). All data is supplied by `vendorDetailResolver` via
 * `route.data['vendor']`:
 *
 *   - `vendor === null` → render the global `aec-not-found` shell; the
 *     resolver already set `RESPONSE_INIT.status = 404` and
 *     `MetaService.setNotFoundMeta`.
 *   - `vendor` set → render hero / metadata sidebar / description /
 *     products grid sections inside the shared `DetailLayout`.
 *
 * Products grid: if `vendor.products` exceeds 20, everything past the first
 * 20 ships in an `@defer (on viewport; hydrate on viewport)` block. Under v22
 * incremental hydration the deferred rows are SSR-rendered (crawlable, no
 * hydration layout shift); the `on viewport` trigger still defers the block on
 * client-side navigations. Each product links to `/products/:slug`. See
 * AECI-130.
 *
 * Cache discipline: tags are written by the SSR runtime (the path matcher
 * emits `route:detail` + `vendor:{slug}`; the resolver pushes
 * `product:{slug}` for each shown product onto `ctx.embedded`). The
 * page-view payload was queued by the resolver. Nothing here triggers HTTP
 * — hydration reads the resolved data out of `route.data`.
 *
 * "Funding stage badge" from the AECI-59 acceptance criteria is omitted:
 * `VendorDetail` has no `funding_stage` field today. A follow-up issue would
 * need to extend the schema (column + Prisma select + Zod + mapper).
 */
@Component({
  selector: 'aec-vendor-detail',
  imports: [DetailLayout, LogoOrInitial, NgTemplateOutlet, NotFound, RouterLink],
  template: `
    @let v = vendor();
    @if (v === null) {
      <aec-not-found />
    } @else {
      <aec-detail-layout>
        <ol
          slot="breadcrumbs"
          class="flex flex-wrap items-center gap-2 text-sm text-(--text-secondary)"
        >
          <li>
            <a
              routerLink="/"
              class="text-(--text-secondary) no-underline hover:text-(--accent-primary)"
              i18n="@@vendors.detail.breadcrumbs.home"
            >
              Home
            </a>
          </li>
          <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
          <li>
            <a
              routerLink="/vendors"
              class="text-(--text-secondary) no-underline hover:text-(--accent-primary)"
              i18n="@@vendors.detail.breadcrumbs.vendors"
            >
              Vendors
            </a>
          </li>
          <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
          <li class="min-w-0 break-words text-(--text-primary)" aria-current="page">
            {{ v.company_name }}
          </li>
        </ol>

        <div slot="hero" class="space-y-5">
          <div class="flex items-start gap-5">
            <aec-logo-or-initial
              [src]="v.logo_url"
              [name]="v.company_name"
              [alt]="v.company_name + ' logo'"
              size="lg"
              [priority]="true"
            />
            <div class="min-w-0 space-y-2">
              <p
                class="text-xs uppercase tracking-[0.14em] text-(--text-tertiary)"
                i18n="@@vendors.detail.eyebrow"
              >
                Vendor
              </p>
              <h1
                class="font-display text-3xl font-semibold leading-tight tracking-tight text-(--text-primary) break-words sm:text-4xl"
              >
                {{ v.company_name }}
              </h1>
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            @if (v.website) {
              <a
                [href]="v.website"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center gap-2 rounded-(--radius-md)
                  border border-(--border-strong) bg-(--accent-primary)
                  px-4 py-2 text-sm font-bold text-(--surface-base) no-underline
                  transition-colors hover:bg-(--accent-primary-hover)
                  focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                  focus-visible:ring-offset-(--surface-base)"
              >
                <ng-container i18n="@@vendors.detail.visitWebsite">Visit website</ng-container>
                <span aria-hidden="true" class="inline-block rtl:-scale-x-100">↗</span>
              </a>
            }
            @if (v.headquarters) {
              <span
                class="inline-flex max-w-full items-center rounded-(--radius-sm) border border-(--border-default)
                  bg-(--surface-raised) px-3 py-1 text-[0.8125rem] tracking-[0.01em]
                  text-(--text-secondary)"
                [attr.aria-label]="hqAria()"
              >
                <span class="font-bold text-(--text-tertiary) me-2" i18n="@@vendors.detail.hq.label"
                  >HQ</span
                >
                <span class="min-w-0 break-words">{{ v.headquarters }}</span>
              </span>
            }
            @if (v.founded_year !== null) {
              <span
                class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default)
                  bg-(--surface-raised) px-3 py-1 text-[0.8125rem] tracking-[0.01em]
                  text-(--text-secondary)"
                [attr.aria-label]="foundedAria()"
              >
                <span
                  class="font-bold text-(--text-tertiary) me-2"
                  i18n="@@vendors.detail.founded.label"
                  >Founded</span
                >
                {{ v.founded_year }}
              </span>
            }
          </div>
        </div>

        <div slot="metadata" class="space-y-6">
          <section aria-labelledby="vendor-stats-title" class="space-y-3">
            <h2
              id="vendor-stats-title"
              class="text-[0.8125rem] font-bold uppercase tracking-[0.08em] text-(--text-tertiary)"
              i18n="@@vendors.detail.metadata.stats"
            >
              At a glance
            </h2>
            <dl
              class="grid grid-cols-2 gap-3 rounded-(--radius-lg) border border-(--border-default)
                bg-(--surface-raised) p-4"
            >
              <div>
                <dt
                  class="text-xs text-(--text-tertiary)"
                  i18n="@@vendors.detail.metadata.productCount"
                >
                  Products
                </dt>
                <dd class="mt-1 font-display text-xl font-semibold text-(--text-primary)">
                  {{ v.product_count }}
                </dd>
              </div>
              <div>
                <dt
                  class="text-xs text-(--text-tertiary)"
                  i18n="@@vendors.detail.metadata.integrationCount"
                >
                  Integrations
                </dt>
                <dd class="mt-1 font-display text-xl font-semibold text-(--text-primary)">
                  {{ v.integration_count }}
                </dd>
              </div>
            </dl>
          </section>

          <section aria-labelledby="vendor-actions-label" class="space-y-3">
            <h2
              id="vendor-actions-label"
              class="text-[0.8125rem] font-bold uppercase tracking-[0.08em] text-(--text-tertiary)"
              i18n="@@vendors.detail.metadata.actions"
            >
              Actions
            </h2>
            <div class="flex flex-col gap-2">
              <a
                [routerLink]="['/vendors', v.slug, 'claim']"
                class="inline-flex items-center justify-center rounded-(--radius-md)
                  border border-(--border-default) bg-(--surface-raised) px-4 py-2.5
                  text-sm font-bold text-(--text-primary) no-underline transition-colors
                  hover:border-(--border-strong) hover:text-(--accent-primary)
                  focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                  focus-visible:ring-offset-(--surface-base)"
                i18n="@@vendors.detail.metadata.claim"
              >
                Claim this listing
              </a>
              <a
                [routerLink]="['/vendors', v.slug, 'correction']"
                class="inline-flex items-center justify-center rounded-(--radius-md)
                  border border-(--border-default) bg-(--surface-raised) px-4 py-2.5
                  text-sm font-bold text-(--text-primary) no-underline transition-colors
                  hover:border-(--border-strong) hover:text-(--accent-primary)
                  focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                  focus-visible:ring-offset-(--surface-base)"
                i18n="@@vendors.detail.metadata.correction"
              >
                Suggest a correction
              </a>
            </div>
          </section>
        </div>

        <div slot="body" class="space-y-12">
          @if (v.description) {
            <section aria-labelledby="vendor-description-title" class="space-y-4">
              <h2
                id="vendor-description-title"
                class="font-display text-2xl font-semibold text-(--text-primary)"
                i18n="@@vendors.detail.body.description"
              >
                About
              </h2>
              <p class="max-w-prose break-words text-base leading-relaxed text-(--text-secondary)">
                {{ v.description }}
              </p>
            </section>
          }

          <section aria-labelledby="vendor-products-title" class="space-y-4">
            <div class="flex items-baseline justify-between gap-4">
              <h2
                id="vendor-products-title"
                class="font-display text-2xl font-semibold text-(--text-primary)"
                i18n="@@vendors.detail.body.products"
              >
                Products
              </h2>
              <span class="text-sm text-(--text-tertiary)">{{ productCountLabel() }}</span>
            </div>

            @if (v.products.length === 0) {
              <p
                class="rounded-(--radius-lg) border border-dashed border-(--border-default)
                  bg-(--surface-sunken) p-6 text-sm text-(--text-secondary)"
                i18n="@@vendors.detail.body.products.empty"
              >
                No products listed yet. Vendor data is curated; if you know of one,
                <a
                  [routerLink]="['/vendors', v.slug, 'correction']"
                  class="text-(--accent-primary) underline underline-offset-2"
                  >suggest a correction</a
                >.
              </p>
            } @else {
              <ng-template #productRow let-product>
                <li>
                  <a
                    [routerLink]="['/products', product.slug]"
                    class="flex items-center gap-3 rounded-(--radius-lg)
                      border border-(--border-default) bg-(--surface-raised) p-4
                      text-(--text-primary) no-underline transition-colors
                      hover:border-(--border-strong)"
                  >
                    <span class="min-w-0 flex-1">
                      <span class="block break-words text-sm font-bold">{{ product.name }}</span>
                      @if (product.primary_category; as cat) {
                        <span class="block break-words text-sm text-(--text-secondary)">{{
                          cat.name
                        }}</span>
                      }
                    </span>
                    <span
                      class="text-(--text-tertiary) inline-block rtl:-scale-x-100"
                      aria-hidden="true"
                      >→</span
                    >
                  </a>
                </li>
              </ng-template>

              <ul class="grid gap-3">
                @for (product of productsAbove(); track product.id) {
                  <ng-container
                    [ngTemplateOutlet]="productRow"
                    [ngTemplateOutletContext]="{ $implicit: product }"
                  ></ng-container>
                }
              </ul>

              @if (productsDeferred().length > 0) {
                @defer (on viewport; hydrate on viewport) {
                  <ul class="mt-3 grid gap-3">
                    @for (product of productsDeferred(); track product.id) {
                      <ng-container
                        [ngTemplateOutlet]="productRow"
                        [ngTemplateOutletContext]="{ $implicit: product }"
                      ></ng-container>
                    }
                  </ul>
                } @placeholder (minimum 100ms) {
                  <div
                    class="mt-3 h-24 animate-pulse rounded-(--radius-lg)
                      border border-(--border-default) bg-(--surface-sunken)"
                    aria-hidden="true"
                  ></div>
                }
              }
            }
          </section>
        </div>
      </aec-detail-layout>
    }
  `,
})
export class VendorDetailPage {
  private readonly route = inject(ActivatedRoute);

  /**
   * Resolved data. `vendorDetailResolver` runs server-side and on hydration
   * reads from `TransferState`; the snapshot value is the SSR-resolved
   * vendor (or null on a NOT_FOUND).
   */
  protected readonly vendor = toSignal<VendorDetail | null, VendorDetail | null>(
    this.route.data.pipe(map((d) => (d['vendor'] ?? null) as VendorDetail | null)),
    { initialValue: (this.route.snapshot.data['vendor'] ?? null) as VendorDetail | null },
  );

  protected readonly products = computed<ReadonlyArray<ProductListItem>>(
    () => this.vendor()?.products ?? [],
  );

  /** First 20 products — rendered in the initial response. */
  protected readonly productsAbove = computed(() => this.products().slice(0, 20));

  /** Anything past 20 is deferred via `@defer (on viewport)`. */
  protected readonly productsDeferred = computed(() => this.products().slice(20));

  protected readonly productCountLabel = computed(() => {
    const count = this.products().length;
    return $localize`:@@vendors.detail.body.products.count:${count}:INTERPOLATION:`;
  });

  protected readonly hqAria = computed(() => {
    const hq = this.vendor()?.headquarters ?? '';
    return $localize`:@@vendors.detail.hq.aria:Headquarters: ${hq}:HQ:`;
  });

  protected readonly foundedAria = computed(() => {
    const year = this.vendor()?.founded_year ?? 0;
    return $localize`:@@vendors.detail.founded.aria:Founded in ${year}:YEAR:`;
  });
}
