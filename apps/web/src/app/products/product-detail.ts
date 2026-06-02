import { NgOptimizedImage, NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type { IntegrationListItem, ProductDetail, ProductLink } from '@aeci/shared';

import { DetailLayout } from '../layouts/detail-layout';
import { NotFound } from '../not-found/not-found';
import { TaxonomyBadge } from '../shared/taxonomy-badge/taxonomy-badge';

/**
 * AECI-57 — Product detail page at `/products/:slug`.
 *
 * Single page with sections (sub-routes were explicitly rejected by the
 * Phase 2 decision — see §3.2). All data is supplied by
 * `productDetailResolver` via `route.data['product']`:
 *
 *   - `product === null` → render the global `aec-not-found` shell (AECI-62);
 *     the resolver already set `RESPONSE_INIT.status = 404` and
 *     `MetaService.setNotFoundMeta`. URL stays at /products/:slug so the
 *     visitor can correct a typo in place — no router redirect.
 *   - `product` set → render hero / metadata sidebar / description /
 *     integrations sections inside the shared `DetailLayout`.
 *
 * Integrations section: if the combined source + target list exceeds 20,
 * everything past the first 20 ships behind an `@defer (on viewport)` block
 * so the initial render stays light. Each integration links to
 * `/integrations/:id` with the *other* product also linked alongside, per
 * AC line "each integration links to `/integrations/:id` with the *other*
 * product also linked".
 *
 * Cache discipline: tags are written by the SSR runtime (vendor + each
 * integration shown), and the page-view payload was queued by the resolver.
 * Nothing here triggers HTTP — hydration reads the resolved data out of
 * `route.data`.
 */
@Component({
  selector: 'aec-product-detail',
  imports: [DetailLayout, NgOptimizedImage, NgTemplateOutlet, NotFound, RouterLink, TaxonomyBadge],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let p = product();
    @if (p === null) {
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
              i18n="@@products.detail.breadcrumbs.home"
            >
              Home
            </a>
          </li>
          <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
          <li>
            <a
              routerLink="/products"
              class="text-(--text-secondary) no-underline hover:text-(--accent-primary)"
              i18n="@@products.detail.breadcrumbs.products"
            >
              Products
            </a>
          </li>
          <li aria-hidden="true" class="text-(--text-tertiary)">›</li>
          <li class="text-(--text-primary)" aria-current="page">{{ p.name }}</li>
        </ol>

        <div slot="hero" class="space-y-5">
          <div class="flex items-start gap-5">
            @if (p.logo_url) {
              <img
                [ngSrc]="p.logo_url"
                [alt]="p.name + ' logo'"
                width="64"
                height="64"
                priority
                class="h-16 w-16 shrink-0 rounded-(--radius-md) border border-(--border-default)
                  bg-(--surface-raised) object-contain"
              />
            } @else {
              <span
                class="flex h-16 w-16 shrink-0 items-center justify-center
                  rounded-(--radius-md) border border-(--border-default)
                  bg-(--surface-raised) font-display text-2xl font-semibold text-(--text-primary)"
                aria-hidden="true"
              >
                {{ initial() }}
              </span>
            }
            <div class="min-w-0 space-y-2">
              <p
                class="text-xs uppercase tracking-[0.14em] text-(--text-tertiary)"
                i18n="@@products.detail.eyebrow"
              >
                Product
              </p>
              <h1
                class="font-display text-3xl font-semibold leading-tight tracking-tight text-(--text-primary) sm:text-4xl"
              >
                {{ p.name }}
              </h1>
              @if (p.vendor; as v) {
                <p class="text-sm text-(--text-secondary)">
                  <ng-container i18n="@@products.detail.by">by</ng-container>
                  <a
                    [routerLink]="['/vendors', v.slug]"
                    class="ml-1 text-(--accent-primary) underline underline-offset-2"
                  >
                    {{ v.name }}
                  </a>
                </p>
              }
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            @if (p.website) {
              <a
                [attr.href]="p.website"
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
                <ng-container i18n="@@products.detail.visitWebsite">Visit website</ng-container>
                <span aria-hidden="true">↗</span>
              </a>
            }
            <span
              class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default)
                bg-(--surface-raised) px-3 py-1 text-[0.8125rem] font-bold tracking-[0.01em]
                text-(--text-secondary)"
              [attr.aria-label]="productRoleAria()"
            >
              {{ productRoleLabel() }}
            </span>
          </div>
        </div>

        <div slot="metadata" class="space-y-6">
          <section aria-labelledby="vendor-card-title" class="space-y-3">
            <h2
              id="vendor-card-title"
              class="text-[0.8125rem] font-bold uppercase tracking-[0.08em] text-(--text-tertiary)"
              i18n="@@products.detail.metadata.vendor"
            >
              Vendor
            </h2>
            @if (p.vendor; as v) {
              <a
                [routerLink]="['/vendors', v.slug]"
                class="flex items-center gap-3 rounded-(--radius-lg) border border-(--border-default)
                  bg-(--surface-raised) p-4 no-underline transition-colors
                  hover:border-(--border-strong)"
              >
                @if (v.logo_url) {
                  <img
                    [ngSrc]="v.logo_url"
                    alt=""
                    width="32"
                    height="32"
                    class="h-8 w-8 shrink-0 rounded-(--radius-sm) object-contain"
                  />
                }
                <span class="font-bold text-(--text-primary)">{{ v.name }}</span>
              </a>
            } @else {
              <p
                class="rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised)
                  p-4 text-(--text-tertiary)"
                i18n="@@products.detail.vendor.none"
              >
                No vendor listed
              </p>
            }
          </section>

          @if (p.categories.length > 0) {
            <section aria-labelledby="categories-label" class="space-y-3">
              <h2
                id="categories-label"
                class="text-[0.8125rem] font-bold uppercase tracking-[0.08em] text-(--text-tertiary)"
                i18n="@@products.detail.metadata.categories"
              >
                Categories
              </h2>
              <div class="flex flex-wrap gap-2">
                @for (c of p.categories; track c.slug) {
                  <aec-taxonomy-badge kind="category" [slug]="c.slug" [name]="c.name" />
                }
              </div>
            </section>
          }

          @if (p.disciplines.length > 0) {
            <section aria-labelledby="disciplines-label" class="space-y-3">
              <h2
                id="disciplines-label"
                class="text-[0.8125rem] font-bold uppercase tracking-[0.08em] text-(--text-tertiary)"
                i18n="@@products.detail.metadata.disciplines"
              >
                Disciplines
              </h2>
              <div class="flex flex-wrap gap-2">
                @for (d of p.disciplines; track d.slug) {
                  <aec-taxonomy-badge kind="discipline" [slug]="d.slug" [name]="d.name" />
                }
              </div>
            </section>
          }

          @if (p.phases.length > 0) {
            <section aria-labelledby="phases-label" class="space-y-3">
              <h2
                id="phases-label"
                class="text-[0.8125rem] font-bold uppercase tracking-[0.08em] text-(--text-tertiary)"
                i18n="@@products.detail.metadata.phases"
              >
                Project phases
              </h2>
              <div class="flex flex-wrap gap-2">
                @for (ph of p.phases; track ph.slug) {
                  <aec-taxonomy-badge kind="phase" [slug]="ph.slug" [name]="ph.name" />
                }
              </div>
            </section>
          }

          <section aria-labelledby="actions-label" class="space-y-3">
            <h2
              id="actions-label"
              class="text-[0.8125rem] font-bold uppercase tracking-[0.08em] text-(--text-tertiary)"
              i18n="@@products.detail.metadata.actions"
            >
              Actions
            </h2>
            <div class="flex flex-col gap-2">
              <a
                [routerLink]="['/products', p.slug, 'claim']"
                class="inline-flex items-center justify-center rounded-(--radius-md)
                  border border-(--border-default) bg-(--surface-raised) px-4 py-2.5
                  text-sm font-bold text-(--text-primary) no-underline transition-colors
                  hover:border-(--border-strong) hover:text-(--accent-primary)
                  focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                  focus-visible:ring-offset-(--surface-base)"
                i18n="@@products.detail.metadata.claim"
              >
                Claim this listing
              </a>
              <a
                [routerLink]="['/products', p.slug, 'correction']"
                class="inline-flex items-center justify-center rounded-(--radius-md)
                  border border-(--border-default) bg-(--surface-raised) px-4 py-2.5
                  text-sm font-bold text-(--text-primary) no-underline transition-colors
                  hover:border-(--border-strong) hover:text-(--accent-primary)
                  focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                  focus-visible:ring-offset-(--surface-base)"
                i18n="@@products.detail.metadata.correction"
              >
                Suggest a correction
              </a>
            </div>
          </section>
        </div>

        <div slot="body" class="space-y-12">
          @if (p.description) {
            <section aria-labelledby="description-title" class="space-y-4">
              <h2
                id="description-title"
                class="font-display text-2xl font-semibold text-(--text-primary)"
                i18n="@@products.detail.body.description"
              >
                About
              </h2>
              <p class="max-w-prose text-base leading-relaxed text-(--text-secondary)">
                {{ p.description }}
              </p>
            </section>
          }

          <section aria-labelledby="integrations-title" class="space-y-4">
            <div class="flex items-baseline justify-between gap-4">
              <h2
                id="integrations-title"
                class="font-display text-2xl font-semibold text-(--text-primary)"
                i18n="@@products.detail.body.integrations"
              >
                Integrations
              </h2>
              <span class="text-sm text-(--text-tertiary)">{{ integrationCountLabel() }}</span>
            </div>

            @if (integrations().length === 0) {
              <p
                class="rounded-(--radius-lg) border border-dashed border-(--border-default)
                  bg-(--surface-sunken) p-6 text-sm text-(--text-secondary)"
                i18n="@@products.detail.body.integrations.empty"
              >
                No integrations recorded yet. Vendor data is curated — if you know of one,
                <a
                  [routerLink]="['/products', p.slug, 'correction']"
                  class="text-(--accent-primary) underline underline-offset-2"
                  >suggest a correction</a
                >.
              </p>
            } @else {
              <ng-template #integrationRow let-item>
                <li>
                  <a
                    [routerLink]="['/integrations', item.integration.id]"
                    class="flex items-center gap-3 rounded-(--radius-lg)
                      border border-(--border-default) bg-(--surface-raised) p-4
                      text-(--text-primary) no-underline transition-colors
                      hover:border-(--border-strong)"
                  >
                    <span class="min-w-0 flex-1">
                      <span class="block text-sm font-bold">{{ item.integration.name }}</span>
                      <span class="block text-sm text-(--text-secondary)">
                        <ng-container i18n="@@products.detail.body.integrations.with"
                          >with</ng-container
                        >
                        <a
                          [routerLink]="['/products', item.other.slug]"
                          class="ml-1 text-(--accent-primary) underline underline-offset-2"
                          (click)="$event.stopPropagation()"
                        >
                          {{ item.other.name }}
                        </a>
                      </span>
                    </span>
                    <span class="text-(--text-tertiary)" aria-hidden="true">→</span>
                  </a>
                </li>
              </ng-template>

              <ul class="grid gap-3">
                @for (item of integrationsAbove(); track item.integration.id) {
                  <ng-container
                    [ngTemplateOutlet]="integrationRow"
                    [ngTemplateOutletContext]="{ $implicit: item }"
                  ></ng-container>
                }
              </ul>

              @if (integrationsDeferred().length > 0) {
                @defer (on viewport) {
                  <ul class="mt-3 grid gap-3">
                    @for (item of integrationsDeferred(); track item.integration.id) {
                      <ng-container
                        [ngTemplateOutlet]="integrationRow"
                        [ngTemplateOutletContext]="{ $implicit: item }"
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
export class ProductDetailPage {
  private readonly route = inject(ActivatedRoute);

  /**
   * Resolved data. `productDetailResolver` runs server-side and on hydration
   * reads from `TransferState`; the snapshot value is the SSR-resolved
   * product (or null on a NOT_FOUND).
   */
  protected readonly product = toSignal<ProductDetail | null, ProductDetail | null>(
    this.route.data.pipe(map((d) => (d['product'] ?? null) as ProductDetail | null)),
    { initialValue: (this.route.snapshot.data['product'] ?? null) as ProductDetail | null },
  );

  protected readonly initial = computed(() => {
    const name = this.product()?.name ?? '';
    return name.charAt(0).toUpperCase() || '·';
  });

  /**
   * Normalized integration list. Each entry pairs the integration with the
   * *other* product (the one that isn't this page's product), so the
   * template can render both endpoints with the other product's link.
   * Source and target buckets are concatenated; the spec doesn't require a
   * particular ordering.
   */
  protected readonly integrations = computed<
    ReadonlyArray<{ integration: IntegrationListItem; other: ProductLink }>
  >(() => {
    const p = this.product();
    if (!p) return [];
    const items: { integration: IntegrationListItem; other: ProductLink }[] = [];
    for (const integration of p.integrations_as_source) {
      items.push({ integration, other: integration.target });
    }
    for (const integration of p.integrations_as_target) {
      items.push({ integration, other: integration.source });
    }
    return items;
  });

  /** First 20 integrations — rendered in the initial response. */
  protected readonly integrationsAbove = computed(() => this.integrations().slice(0, 20));

  /** Anything past 20 is deferred via `@defer (on viewport)`. */
  protected readonly integrationsDeferred = computed(() => this.integrations().slice(20));

  protected readonly integrationCountLabel = computed(() => {
    const count = this.integrations().length;
    return $localize`:@@products.detail.body.integrations.count:${count}:INTERPOLATION:`;
  });

  protected readonly productRoleLabel = computed(() => {
    const role = this.product()?.product_role;
    switch (role) {
      case 'application':
        return $localize`:@@products.detail.role.application:Application`;
      case 'connector':
        return $localize`:@@products.detail.role.connector:Connector`;
      case 'hybrid':
        return $localize`:@@products.detail.role.hybrid:Hybrid`;
      default:
        return '';
    }
  });

  protected readonly productRoleAria = computed(() => {
    const role = this.productRoleLabel();
    return $localize`:@@products.detail.role.aria:Product role: ${role}:ROLE:`;
  });
}
