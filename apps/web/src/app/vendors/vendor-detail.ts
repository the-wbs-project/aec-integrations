import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type { ProductListItem, VendorDetail } from '@aeci/shared';

import { DetailLayout } from '../layouts/detail-layout';
import { NotFound } from '../not-found/not-found';
import { RequestDrawer } from '../requests/request-drawer';
import { RequestTrigger } from '../requests/request-trigger';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';

/** Hero social platforms, in launch priority order (PRODUCT.md §B0). */
type SocialKey = 'linkedin' | 'x' | 'youtube' | 'github' | 'facebook' | 'instagram';

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
  imports: [
    DetailLayout,
    LogoOrInitial,
    NgTemplateOutlet,
    NotFound,
    RequestDrawer,
    RequestTrigger,
    RouterLink,
  ],
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
                class="text-xs uppercase tracking-[0.14em] text-(--text-secondary)"
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
                <span
                  class="font-bold text-(--text-secondary) me-2"
                  i18n="@@vendors.detail.hq.label"
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
                  class="font-bold text-(--text-secondary) me-2"
                  i18n="@@vendors.detail.founded.label"
                  >Founded</span
                >
                {{ v.founded_year }}
              </span>
            }

            @if (socialLinks().length > 0) {
              <span class="flex items-center gap-2" role="list" [attr.aria-label]="socialAria">
                @for (link of socialLinks(); track link.key) {
                  <a
                    role="listitem"
                    [href]="link.href"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="inline-flex h-9 w-9 items-center justify-center rounded-(--radius-sm)
                      border border-(--border-default) bg-(--surface-raised) text-(--text-secondary)
                      transition-colors hover:border-(--border-strong) hover:text-(--accent-primary)
                      focus-visible:outline-none focus-visible:ring-2
                      focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                      focus-visible:ring-offset-(--surface-base)"
                    [attr.aria-label]="link.label"
                    [title]="link.label"
                  >
                    <svg
                      aria-hidden="true"
                      class="h-[18px] w-[18px]"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <path [attr.d]="link.path" />
                    </svg>
                  </a>
                }
              </span>
            }
          </div>
        </div>

        <div slot="metadata" class="space-y-6">
          <section aria-labelledby="vendor-stats-title" class="space-y-3">
            <h2
              id="vendor-stats-title"
              class="aec-overline text-(--text-secondary)"
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
                  class="text-xs text-(--text-secondary)"
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
                  class="text-xs text-(--text-secondary)"
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
              class="aec-overline text-(--text-secondary)"
              i18n="@@vendors.detail.metadata.actions"
            >
              Actions
            </h2>
            <div class="flex flex-col gap-2">
              <a
                aecRequestTrigger
                [entity]="'vendor'"
                [kind]="'claim'"
                [slug]="v.slug"
                [href]="'/vendors/' + v.slug + '/claim'"
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
                <ng-container i18n="@@vendors.detail.metadata.claim"
                  >Claim this listing</ng-container
                >
              </a>
              <a
                aecRequestTrigger
                [entity]="'vendor'"
                [kind]="'correction'"
                [slug]="v.slug"
                [href]="'/vendors/' + v.slug + '/correction'"
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
                <ng-container i18n="@@vendors.detail.metadata.correction"
                  >Suggest a correction</ng-container
                >
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
            <div class="flex items-baseline gap-2">
              <h2
                id="vendor-products-title"
                class="font-display text-2xl font-semibold text-(--text-primary)"
                i18n="@@vendors.detail.body.products"
              >
                Products
              </h2>
              <span class="text-base font-normal tabular-nums text-(--text-secondary)">{{
                productCountLabel()
              }}</span>
            </div>

            @if (v.products.length === 0) {
              <p
                class="rounded-(--radius-lg) border border-dashed border-(--border-default)
                  bg-(--surface-sunken) p-6 text-sm text-(--text-secondary)"
                i18n="@@vendors.detail.body.products.empty"
              >
                No products listed yet. Vendor data is curated; if you know of one,
                <a
                  aecRequestTrigger
                  [entity]="'vendor'"
                  [kind]="'correction'"
                  [slug]="v.slug"
                  [href]="'/vendors/' + v.slug + '/correction'"
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
                      border border-(--border-default) bg-(--surface-raised) p-3
                      text-(--text-primary) no-underline transition-colors
                      hover:border-(--border-strong)"
                  >
                    <aec-logo-or-initial
                      [src]="product.logo_url"
                      [name]="product.name"
                      alt=""
                      size="sm"
                    />
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

      <!-- In-place claim/correction drawer (AECI-128); opened by the
           aecRequestTrigger anchors above. Renders nothing until opened. -->
      <aec-request-drawer />
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

  /** Accessible name for the hero social-link cluster. */
  protected readonly socialAria = $localize`:@@vendors.detail.social.label:Social links`;

  // Per-platform accessible names (i18n) and brand glyphs (single-path,
  // fill="currentColor", 24×24). `socialLinks()` zips these with the vendor's
  // present URLs, in the launch priority order (LinkedIn, X, YouTube, GitHub,
  // Facebook, Instagram — DESIGN/PRODUCT B0). LinkedIn + the four B2 platforms
  // are full URLs from the contract; `github_url` is the mapper-derived one.
  private readonly socialLabels: Record<SocialKey, string> = {
    linkedin: $localize`:@@vendors.detail.social.linkedin:LinkedIn`,
    x: $localize`:@@vendors.detail.social.x:X (Twitter)`,
    youtube: $localize`:@@vendors.detail.social.youtube:YouTube`,
    github: $localize`:@@vendors.detail.social.github:GitHub`,
    facebook: $localize`:@@vendors.detail.social.facebook:Facebook`,
    instagram: $localize`:@@vendors.detail.social.instagram:Instagram`,
  };

  private readonly socialPaths: Record<SocialKey, string> = {
    linkedin:
      'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.225 0z',
    x: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z',
    youtube:
      'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
    github:
      'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
    facebook:
      'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z',
    instagram:
      'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z',
  };

  protected readonly socialLinks = computed(() => {
    const v = this.vendor();
    if (!v) return [];
    const ordered: Array<{ key: SocialKey; href: string | null }> = [
      { key: 'linkedin', href: v.linkedin_url },
      { key: 'x', href: v.x_url },
      { key: 'youtube', href: v.youtube_url },
      { key: 'github', href: v.github_url },
      { key: 'facebook', href: v.facebook_url },
      { key: 'instagram', href: v.instagram_url },
    ];
    return ordered
      .filter((s): s is { key: SocialKey; href: string } => !!s.href)
      .map(({ key, href }) => ({
        key,
        href,
        label: this.socialLabels[key],
        path: this.socialPaths[key],
      }));
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
