import { NgTemplateOutlet } from '@angular/common';
import { Component, afterNextRender, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type { IntegrationListItem, ProductDetail, ProductLink } from '@aeci/shared';

import { Analytics } from '../analytics/analytics';
import { ExternalLinkTracker } from '../analytics/external-link-tracker';
import { DetailLayout } from '../layouts/detail-layout';
import { NotFound } from '../not-found/not-found';
import { RequestDrawer } from '../requests/request-drawer';
import { RequestTrigger } from '../requests/request-trigger';
import { ReviewCta } from '../reviews/review-cta';
import { ReviewStars } from '../reviews/review-stars';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';
import { SectionNav, type SectionNavItem } from '../shared/section-nav/section-nav';
import { TaxonomyBadge } from '../shared/taxonomy-badge/taxonomy-badge';

import { ProductReviews } from './product-reviews';
import { ProductUsefulnessSection } from './product-usefulness';

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
 * everything past the first 20 ships in an `@defer (on viewport; hydrate on
 * viewport)` block. Under v22 incremental hydration the deferred rows are
 * SSR-rendered (crawlable, no hydration layout shift); the `on viewport`
 * trigger still defers the block on client-side navigations (see AECI-130).
 * Each integration links to the product-PAIR page
 * `/products/:contextSlug/integrations/:otherSlug` (this product as the context
 * slug) with the *other* product also linked alongside — AECI-294 retired the
 * standalone `/integrations/:id` detail route the original AC named.
 *
 * Cache discipline: tags are written by the SSR runtime (vendor + each
 * integration shown), and the page-view payload was queued by the resolver.
 * Nothing here triggers HTTP — hydration reads the resolved data out of
 * `route.data`.
 */
@Component({
  selector: 'aec-product-detail',
  imports: [
    DetailLayout,
    ExternalLinkTracker,
    LogoOrInitial,
    NgTemplateOutlet,
    NotFound,
    ProductReviews,
    ProductUsefulnessSection,
    RequestDrawer,
    RequestTrigger,
    ReviewCta,
    ReviewStars,
    RouterLink,
    SectionNav,
    TaxonomyBadge,
  ],
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
          <li class="min-w-0 break-words text-(--text-primary)" aria-current="page">
            {{ p.name }}
          </li>
        </ol>

        <div slot="hero" class="space-y-5">
          <div class="flex items-start gap-5">
            <aec-logo-or-initial
              [src]="p.logo_url"
              [name]="p.name"
              [alt]="p.name + ' logo'"
              size="lg"
              [priority]="true"
            />
            <div class="min-w-0 space-y-2">
              <p
                class="text-xs uppercase tracking-[0.14em] text-(--text-secondary)"
                i18n="@@products.detail.eyebrow"
              >
                Product
              </p>
              <h1
                class="font-display text-3xl font-semibold leading-tight tracking-tight text-(--text-primary) break-words sm:text-4xl"
              >
                {{ p.name }}
              </h1>
            </div>
          </div>

          <!-- Rating / review meta line. Always rendered: a rated product (≥5
               approved reviews) shows the aggregate; below that §5.5 threshold the
               API nulls the average, so we show a "Not Yet Rated" label + the live
               review count instead of hiding the line. Every value derives from
               static product fields, so this stays edge-cache-neutral (§8). -->
          <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            @if (p.rating_overall_avg !== null) {
              <aec-review-stars [rating]="p.rating_overall_avg" kind="overall" />
              <span class="font-display text-xl font-semibold text-(--text-primary)">{{
                decimal(p.rating_overall_avg)
              }}</span>
            } @else {
              <span
                class="inline-flex items-center rounded-(--radius-sm) border border-(--border-default)
                  bg-(--surface-raised) px-2 py-0.5 text-xs font-medium uppercase tracking-[0.08em]
                  text-(--text-secondary)"
                i18n="@@products.detail.hero.notRated"
              >
                Not Yet Rated
              </span>
            }
            <span aria-hidden="true" class="text-(--text-tertiary)">·</span>
            @if (p.review_count > 0) {
              <a
                [href]="'/products/' + p.slug + '#reviews'"
                class="text-sm font-medium text-(--text-secondary) no-underline transition-colors
                  hover:text-(--accent-primary) focus-visible:outline-none
                  focus-visible:rounded-(--radius-sm) focus-visible:ring-2
                  focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                  focus-visible:ring-offset-(--surface-base)"
              >
                {{ reviewCountLabel(p.review_count) }}
              </a>
            } @else {
              <span class="text-sm font-medium text-(--text-secondary)">{{
                reviewCountLabel(p.review_count)
              }}</span>
            }
          </div>

          <!-- Primary action ("Visit website", when present) sits beside the
               write-a-review CTA. The CTA reuses the cache-neutral, auth-aware
               aec-review-cta (its SSR render is the generic "Write a review"); the
               secondary variant keeps "Visit website" the single accent button.
               The row renders even with no website so the CTA is always present. -->
          <div class="flex flex-wrap items-center gap-3">
            @if (p.website) {
              <a
                [href]="p.website"
                target="_blank"
                rel="noopener noreferrer"
                aecTrackExternalLink="product_detail"
                class="inline-flex items-center gap-2 rounded-(--radius-md)
                  border border-(--border-strong) bg-(--accent-primary)
                  px-4 py-2 text-sm font-bold text-(--surface-base) no-underline
                  transition-colors hover:bg-(--accent-primary-hover)
                  focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                  focus-visible:ring-offset-(--surface-base)"
              >
                <ng-container i18n="@@products.detail.visitWebsite">Visit website</ng-container>
                <span aria-hidden="true" class="inline-block rtl:-scale-x-100">↗</span>
              </a>
            }
            <aec-review-cta [slug]="p.slug" [productId]="p.id" variant="secondary" />
          </div>
        </div>

        <div slot="metadata" class="space-y-6">
          <section aria-labelledby="vendor-card-title" class="space-y-3">
            <h2
              id="vendor-card-title"
              class="aec-overline text-(--text-secondary)"
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
                <aec-logo-or-initial [src]="v.logo_url" [name]="v.name" alt="" size="sm" />
                <span class="min-w-0 break-words font-medium text-(--text-primary)">{{
                  v.name
                }}</span>
              </a>
            } @else {
              <p
                class="rounded-(--radius-lg) border border-(--border-default) bg-(--surface-raised)
                  p-4 text-(--text-secondary)"
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
                class="aec-overline text-(--text-secondary)"
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

          @if (p.audiences.length > 0) {
            <section aria-labelledby="audiences-label" class="space-y-3">
              <h2
                id="audiences-label"
                class="aec-overline text-(--text-secondary)"
                i18n="@@products.detail.metadata.audiences"
              >
                Audiences
              </h2>
              <div class="flex flex-wrap gap-2">
                @for (d of p.audiences; track d.slug) {
                  <aec-taxonomy-badge kind="audience" [slug]="d.slug" [name]="d.name" />
                }
              </div>
            </section>
          }

          @if (p.phases.length > 0) {
            <section aria-labelledby="phases-label" class="space-y-3">
              <h2
                id="phases-label"
                class="aec-overline text-(--text-secondary)"
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
              class="aec-overline text-(--text-secondary)"
              i18n="@@products.detail.metadata.actions"
            >
              Actions
            </h2>
            <div class="flex flex-col gap-2">
              <a
                aecRequestTrigger
                [entity]="'product'"
                [kind]="'claim'"
                [slug]="p.slug"
                [href]="'/products/' + p.slug + '/claim'"
                class="inline-flex items-center justify-center gap-2 rounded-(--radius-md)
                  border border-(--border-default) bg-(--surface-raised) px-4 py-2.5
                  text-sm font-medium text-(--text-secondary) no-underline transition-colors
                  hover:border-(--border-strong) hover:text-(--accent-primary)
                  focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                  focus-visible:ring-offset-(--surface-base)"
              >
                <svg
                  aria-hidden="true"
                  class="h-4 w-4 shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                  <path d="M4 22v-7" />
                </svg>
                <ng-container i18n="@@products.detail.metadata.claim"
                  >Claim this listing</ng-container
                >
              </a>
              <a
                aecRequestTrigger
                [entity]="'product'"
                [kind]="'correction'"
                [slug]="p.slug"
                [href]="'/products/' + p.slug + '/correction'"
                class="inline-flex items-center justify-center gap-2 rounded-(--radius-md)
                  border border-(--border-default) bg-(--surface-raised) px-4 py-2.5
                  text-sm font-medium text-(--text-secondary) no-underline transition-colors
                  hover:border-(--border-strong) hover:text-(--accent-primary)
                  focus-visible:outline-none focus-visible:ring-2
                  focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                  focus-visible:ring-offset-(--surface-base)"
              >
                <svg
                  aria-hidden="true"
                  class="h-4 w-4 shrink-0"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
                <ng-container i18n="@@products.detail.metadata.correction"
                  >Suggest a correction</ng-container
                >
              </a>
            </div>
          </section>
        </div>

        <div slot="body" class="space-y-12">
          @if (sectionNav().length >= 2) {
            <aec-section-nav [basePath]="'/products/' + p.slug" [sections]="sectionNav()" />
          }

          @if (p.description) {
            <section id="about" aria-labelledby="description-title" class="scroll-mt-20 space-y-4">
              <h2
                id="description-title"
                class="font-display text-2xl font-semibold text-(--text-primary)"
                i18n="@@products.detail.body.description"
              >
                About
              </h2>
              <p class="max-w-prose break-words text-base leading-relaxed text-(--text-secondary)">
                {{ p.description }}
              </p>
            </section>
          }

          @if (p.usefulness; as u) {
            <aec-product-usefulness id="how-teams-use-it" class="scroll-mt-20" [data]="u" />
          }

          <section
            id="integrations"
            aria-labelledby="integrations-title"
            class="scroll-mt-20 space-y-4"
          >
            <div class="flex items-baseline justify-between gap-4">
              <h2
                id="integrations-title"
                class="font-display text-2xl font-semibold text-(--text-primary)"
                i18n="@@products.detail.body.integrations"
              >
                Integrations
              </h2>
              <span class="text-sm text-(--text-secondary)">{{ integrationCountLabel() }}</span>
            </div>

            @if (integrations().length === 0) {
              <p
                class="rounded-(--radius-lg) border border-dashed border-(--border-default)
                  bg-(--surface-sunken) p-6 text-sm text-(--text-secondary)"
                i18n="@@products.detail.body.integrations.empty"
              >
                No integrations recorded yet. Vendor data is curated; if you know of one,
                <a
                  aecRequestTrigger
                  [entity]="'product'"
                  [kind]="'correction'"
                  [slug]="p.slug"
                  [href]="'/products/' + p.slug + '/correction'"
                  class="text-(--accent-primary) underline underline-offset-2"
                  >suggest a correction</a
                >.
              </p>
            } @else {
              <ng-template #integrationRow let-item let-contextSlug="contextSlug">
                <li>
                  <a
                    [routerLink]="['/products', contextSlug, 'integrations', item.other.slug]"
                    class="flex items-center gap-3 rounded-(--radius-lg)
                      border border-(--border-default) bg-(--surface-raised) p-4
                      text-(--text-primary) no-underline transition-colors
                      hover:border-(--border-strong)"
                  >
                    <span class="min-w-0 flex-1">
                      <span class="block break-words text-sm font-bold">{{
                        item.integration.name
                      }}</span>
                      <span class="block break-words text-sm text-(--text-secondary)">
                        <ng-container i18n="@@products.detail.body.integrations.with"
                          >with</ng-container
                        >
                        <a
                          [routerLink]="['/products', item.other.slug]"
                          class="ms-1 text-(--accent-primary) underline underline-offset-2"
                          (click)="$event.stopPropagation()"
                        >
                          {{ item.other.name }}
                        </a>
                      </span>
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
                @for (item of integrationsAbove(); track item.integration.id) {
                  <ng-container
                    [ngTemplateOutlet]="integrationRow"
                    [ngTemplateOutletContext]="{ $implicit: item, contextSlug: p.slug }"
                  ></ng-container>
                }
              </ul>

              @if (integrationsDeferred().length > 0) {
                @defer (on viewport; hydrate on viewport) {
                  <ul class="mt-3 grid gap-3">
                    @for (item of integrationsDeferred(); track item.integration.id) {
                      <ng-container
                        [ngTemplateOutlet]="integrationRow"
                        [ngTemplateOutletContext]="{ $implicit: item, contextSlug: p.slug }"
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

          <section id="reviews" aria-labelledby="reviews-title" class="scroll-mt-20">
            <aec-product-reviews
              [slug]="p.slug"
              [productId]="p.id"
              [reviewCount]="p.review_count"
              [ratingOverallAvg]="p.rating_overall_avg"
              [ratingOnboardingAvg]="p.rating_onboarding_avg"
              [firstPage]="p.reviews"
            />
          </section>
        </div>
      </aec-detail-layout>

      <!-- In-place claim/correction drawer (AECI-128); opened by the
           aecRequestTrigger anchors above. Renders nothing until opened. -->
      <aec-request-drawer />
    }
  `,
})
export class ProductDetailPage {
  private readonly route = inject(ActivatedRoute);
  private readonly analytics = inject(Analytics);

  /**
   * Resolved data. `productDetailResolver` runs server-side and on hydration
   * reads from `TransferState`; the snapshot value is the SSR-resolved
   * product (or null on a NOT_FOUND).
   */
  protected readonly product = toSignal<ProductDetail | null, ProductDetail | null>(
    this.route.data.pipe(map((d) => (d['product'] ?? null) as ProductDetail | null)),
    { initialValue: (this.route.snapshot.data['product'] ?? null) as ProductDetail | null },
  );

  constructor() {
    // Browser-only `product_viewed` (§14.1). `afterNextRender` keeps it out of
    // SSR; consent-gating + fire-and-forget live in `Analytics`. A fresh
    // component instance per route means this fires once per product view.
    afterNextRender(() => {
      const p = this.product();
      if (p) this.analytics.productViewed(p.id);
    });
  }

  /** One-decimal display of an average rating, e.g. 4 → "4.0", 4.25 → "4.3". */
  protected decimal(value: number): string {
    return value.toFixed(1);
  }

  /**
   * Hero review-count label. Now renders for any count (the meta line shows
   * "Not Yet Rated · N reviews" below the §5.5 5-review rating threshold, not
   * just for rated products), so it pluralizes all three cases. Pluralization
   * lives in the component rather than a template ICU, matching `IntegrationStat`.
   */
  protected reviewCountLabel(count: number): string {
    if (count === 0) return $localize`:@@products.detail.hero.reviewCount.none:No reviews yet`;
    if (count === 1) return $localize`:@@products.detail.hero.reviewCount.one:1 review`;
    return $localize`:@@products.detail.hero.reviewCount.other:${count}:COUNT: reviews`;
  }

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

  /**
   * Whether the "How teams use it" section actually renders. Mirrors
   * `ProductUsefulnessSection.hasContent` (product-usefulness.ts) — that child
   * hides itself via `[hidden]` when a non-null `usefulness` carries no usable
   * points, so the jump nav must apply the same test or it would link to a
   * collapsed section.
   */
  protected readonly hasUsefulness = computed(() => {
    const u = this.product()?.usefulness;
    if (!u) return false;
    return (
      u.audiences.some((g) => g.points.length > 0) || u.phases.some((g) => g.points.length > 0)
    );
  });

  /**
   * Present body sections, in render order, for the sticky in-page nav. Only
   * sections that are actually on the page are listed; Integrations always is
   * (its empty state still renders). The parent owns the (localized) labels so
   * `SectionNav` stays generic.
   */
  protected readonly sectionNav = computed<readonly SectionNavItem[]>(() => {
    const p = this.product();
    if (!p) return [];
    const items: SectionNavItem[] = [];
    if (p.description) {
      items.push({ id: 'about', label: $localize`:@@products.detail.nav.about:About` });
    }
    if (this.hasUsefulness()) {
      items.push({
        id: 'how-teams-use-it',
        label: $localize`:@@products.detail.nav.usefulness:How teams use it`,
      });
    }
    items.push({
      id: 'integrations',
      label: $localize`:@@products.detail.nav.integrations:Integrations`,
    });
    // Reviews always renders (its empty state still does), so it is always in
    // the nav — same rule as Integrations above.
    items.push({
      id: 'reviews',
      label: $localize`:@@products.detail.nav.reviews:Reviews`,
    });
    return items;
  });
}
