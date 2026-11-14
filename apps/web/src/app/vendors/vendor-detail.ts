import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';

import type { ProductListItem, VendorDetail } from '@aeci/shared';

import { AecButton } from '../shared/button/button';
import type { ExternalLinkContext } from '../analytics/analytics';
import { ExternalLinkTracker } from '../analytics/external-link-tracker';
import { DetailLayout } from '../layouts/detail-layout';
import { NotFound } from '../not-found/not-found';
import { fieldOverrideLabel } from '../vendor/components/field-override-labels';
import { RequestDrawer } from '../requests/request-drawer';
import { RequestTrigger } from '../requests/request-trigger';
import { CompanyFactsNote } from '../shared/company-facts-note/company-facts-note';
import { LogoOrInitial, logoAlt } from '../shared/logo-or-initial/logo-or-initial';
import { UnclaimedNote } from '../shared/unclaimed-note/unclaimed-note';
import { MailingListSignup } from '../shared/mailing-list-signup/mailing-list-signup';
import { FieldCaptionLine, type FieldCaptionPage } from '../shared/field-caption/field-caption';
import { correctionInSlot, isUnderReview } from '../shared/field-caption/field-caption-facts';
import { UnderReviewMarker } from '../shared/field-caption/under-review';
import { MaintenanceMarker } from '../shared/maintenance-marker/maintenance-marker';
import { NewTabIcon } from '../shared/new-tab-icon/new-tab-icon';

import { CompanyFacts } from './company-facts';
import { VendorProductRow } from './vendor-product-row';
import { AecIcon } from '../shared/icon/icon';

/** Hero social platforms, in launch priority order (PRODUCT.md §B0). */
type SocialKey = 'linkedin' | 'x' | 'youtube' | 'facebook' | 'instagram';

/** The hero row's links, in its order: the fields a hidden link names (AECI-1238). */
const HERO_LINK_FIELDS = [
  'website',
  'linkedin_url',
  'x_url',
  'youtube_url',
  'facebook_url',
  'instagram_url',
] as const;

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
 *     products table sections inside the shared `DetailLayout`.
 *
 * Products table: a column-aligned `<table>` (product · category · rating ·
 * integrations), one `VendorProductRow` per product — mirroring the
 * integrations table on the product-detail page, and replacing the former stack
 * of near-identical product cards which was harder to scan. Category + Rating
 * collapse at `md` (matching `ProductCard` / the browse tables), the category
 * folding into the product cell. If `vendor.products` exceeds 20, everything
 * past the first 20 ships as deferred `<tr>`s in an
 * `@defer (on viewport; hydrate on viewport)` block inside the same `<tbody>`.
 * Under v22 incremental hydration the deferred rows are SSR-rendered (crawlable,
 * no hydration layout shift); the `on viewport` trigger still defers the block
 * on client-side navigations. Each row's whole surface links to `/products/:slug`:
 * the trailing arrow is the real link and a click elsewhere on the row is
 * forwarded to it (`VendorProductRow`), with the category chip linked
 * separately. See AECI-130.
 *
 * Cache discipline: tags are written by the SSR runtime (the path matcher
 * emits `route:detail` + `vendor:{slug}`; the resolver pushes
 * `product:{slug}` for each shown product onto `ctx.embedded`). Nothing here
 * triggers HTTP
 * — hydration reads the resolved data out of `route.data`.
 *
 * No account or plan label in the hero (AECI-1264, marketing review B1). The
 * "Active on AEC Integrations" badge is gone: it implied a vendor without it was
 * inactive, and it marked publicly who pays. The claim CTA below is stateless
 * too (AECI-1266): every listing reads "Claim <Company>" (AECI-1365), and
 * `VendorDetail` no longer carries the plan mirror at all.
 *
 * Company facts live in the sidebar (AECI-1310, `CompanyFacts`). Headquarters and
 * founded year moved there from the hero, so each fact shows once, with its source.
 */
@Component({
  selector: 'aec-vendor-detail',
  imports: [
    AecButton,
    AecIcon,
    CompanyFacts,
    CompanyFactsNote,
    DetailLayout,
    ExternalLinkTracker,
    FieldCaptionLine,
    LogoOrInitial,
    UnclaimedNote,
    MailingListSignup,
    MaintenanceMarker,
    NewTabIcon,
    NotFound,
    RequestDrawer,
    RequestTrigger,
    RouterLink,
    UnderReviewMarker,
    VendorProductRow,
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
          <!-- items-center, not items-start. The logo is a 64px square and the
               column beside it opens with a row of ~29px chips, so top-aligning
               anchored the logo to the chip row and left it relating to nothing:
               its optical centre landed in the gap ABOVE the name. Centring ties
               it to the h1, which is what it belongs to. The column is always
               taller than 64px (eyebrow + h1 clears it at every breakpoint), so
               the logo never becomes the taller item and start-align the text. -->
          <div class="flex items-center gap-5">
            @if (v.claim_status !== 'unclaimed') {
              <aec-logo-or-initial
                [src]="v.logo_url"
                [name]="v.company_name"
                [alt]="logoAlt(v.company_name)"
                size="lg"
                [priority]="true"
              />
            }
            <div class="min-w-0 space-y-2">
              <div class="flex flex-wrap items-center gap-2">
                <p
                  class="text-xs uppercase tracking-[0.14em] text-(--text-secondary)"
                  i18n="@@vendors.detail.eyebrow"
                >
                  Vendor
                </p>
                <aec-maintenance-marker
                  [maintainedBy]="v.maintenance.maintained_by"
                  [reviewedAt]="v.maintenance.last_reviewed_at"
                  [ownerName]="v.company_name"
                />
              </div>
              <h1
                class="font-display text-3xl font-semibold leading-tight tracking-tight text-(--text-primary) break-words sm:text-4xl"
              >
                {{ v.company_name }}
              </h1>
              <!-- AECI-1628: AECi replaced or removed the logo the vendor holds. The logo
                   sits beside this column, so the line names it. -->
              @if (logoCorrection(); as c) {
                <aec-field-caption
                  data-testid="logo-correction"
                  [correction]="c"
                  [label]="logoLabel"
                  [page]="captionPage()"
                />
              }
              <!-- AECI-1618: an unclaimed listing keeps a small logo, not a header
                   image, with counsel's wording directly beside it. -->
              @if (v.claim_status === 'unclaimed') {
                <div class="flex items-center gap-2 pt-1">
                  <aec-logo-or-initial
                    [src]="v.logo_url"
                    [name]="v.company_name"
                    [alt]="logoAlt(v.company_name)"
                    size="sm"
                    [priority]="true"
                  />
                  <aec-unclaimed-note />
                </div>
              }
            </div>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            @if (v.website) {
              <a
                aecButton
                [href]="v.website"
                target="_blank"
                rel="noopener nofollow"
                aecTrackExternalLink="vendor_detail"
                [aecLinkContext]="linkContexts()!.website"
              >
                <ng-container i18n="@@vendors.detail.visitWebsite">Visit website</ng-container>
                <aec-new-tab-icon />
              </a>
            }
            @if (socialLinks().length > 0) {
              <span class="flex items-center gap-2" role="list" [attr.aria-label]="socialAria">
                @for (link of socialLinks(); track link.key) {
                  <a
                    role="listitem"
                    [href]="link.href"
                    target="_blank"
                    rel="noopener nofollow"
                    aecTrackExternalLink="vendor_detail_social"
                    [aecLinkContext]="linkContexts()!.social"
                    class="inline-flex h-9 w-9 items-center justify-center rounded-(--radius-sm)
                      border border-(--border-default) bg-(--surface-raised) text-(--text-secondary)
                      transition-colors hover:border-(--border-strong) hover:text-(--accent-primary)
                      focus-visible:outline-none focus-visible:ring-2
                      focus-visible:ring-(--accent-primary) focus-visible:ring-offset-2
                      focus-visible:ring-offset-(--surface-base)"
                    [attr.aria-label]="link.aria"
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

          <!-- AECI-1614: AECi's corrections on the facts in the row above. That row is
               chips and icons in one wrap, with no room under any one value, so each line
               names its field. AECI-1628: a removal reads "Removed by" here too, since the
               value it removed has no slot left on the page. Corrected only: this page takes no Maintained caption
               (ruling 2026-11-05). -->
          @if (factCorrections().length > 0) {
            <div class="space-y-1" data-testid="vendor-corrections">
              @for (entry of factCorrections(); track entry.correction.field) {
                <aec-field-caption
                  [correction]="entry.correction"
                  [label]="entry.label"
                  [page]="captionPage()"
                />
              }
            </div>
          }
          <!-- AECI-1238 (§11d.7): a link AECi hid while it checks it. Its icon is gone
               from the row above, so each line names the field. -->
          @if (linksUnderReview().length > 0) {
            <div class="space-y-1" data-testid="vendor-under-review">
              @for (entry of linksUnderReview(); track entry.field) {
                <aec-under-review [label]="entry.label" />
              }
            </div>
          }
        </div>

        <!--
          One instance, two formats, same contract as the product page. Docked
          sidebar at lg; below lg the layout places it directly under About, where
          it reads as a contained fact panel (groups pair up from sm, actions sit
          inline at their natural width) rather than a stack of full-bleed rows at
          the bottom of the page. See DetailLayout.
        -->
        <div
          slot="metadata"
          class="grid gap-x-8 gap-y-6 rounded-(--radius-lg) border border-(--border-default)
            bg-(--surface-raised) p-5 sm:grid-cols-2 sm:p-6 lg:block lg:space-y-6
            lg:rounded-none lg:border-0 lg:bg-transparent lg:p-0"
        >
          <section aria-labelledby="vendor-stats-title" class="space-y-3">
            <h2
              id="vendor-stats-title"
              class="aec-overline text-(--text-secondary)"
              i18n="@@vendors.detail.metadata.stats"
            >
              At a glance
            </h2>
            <dl
              class="grid grid-cols-2 gap-3 rounded-(--radius-lg) border
                border-(--border-default) bg-(--surface-base) p-4
                lg:bg-(--surface-raised)"
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

          <aec-company-facts [facts]="v.company_facts" [underReview]="v.under_review ?? []" />

          <section aria-labelledby="vendor-actions-label" class="space-y-3">
            <h2
              id="vendor-actions-label"
              class="aec-overline text-(--text-secondary)"
              i18n="@@vendors.detail.metadata.actions"
            >
              Actions
            </h2>
            <div class="flex flex-wrap gap-2 lg:flex-col">
              <a
                aecButton
                variant="secondary"
                aecRequestTrigger
                [entity]="'vendor'"
                [kind]="'claim'"
                [slug]="v.slug"
                [company]="v.company_name"
                [href]="'/vendors/' + v.slug + '/claim'"
              >
                <aec-icon name="flag" decorative [size]="4" />
                <!-- AECI-1365: a claim is on the company (VENDOR_SIGNUP_PROCESS.md §3). -->
                <ng-container i18n="@@vendors.detail.metadata.claimCompany"
                  >Claim {{ v.company_name }}</ng-container
                >
              </a>
              <a
                aecButton
                variant="secondary"
                aecRequestTrigger
                [entity]="'vendor'"
                [kind]="'correction'"
                [slug]="v.slug"
                [href]="'/vendors/' + v.slug + '/correction'"
              >
                <aec-icon name="pen" decorative [size]="4" />
                <ng-container i18n="@@vendors.detail.metadata.correction"
                  >Suggest a correction</ng-container
                >
              </a>
            </div>
          </section>
          <aec-company-facts-note class="block sm:col-span-2 lg:col-span-1" />
        </div>

        <!-- About goes in the LEAD slot so the metadata panel lands under it below
             xl instead of at the foot of the page. See DetailLayout. -->
        <div slot="body-lead" class="space-y-12">
          @if (v.description || descriptionUnderReview()) {
            <section aria-labelledby="vendor-description-title" class="space-y-4">
              <h2
                id="vendor-description-title"
                class="font-display text-2xl font-semibold text-(--text-primary)"
                i18n="@@vendors.detail.body.description"
              >
                About
              </h2>
              @if (v.description) {
                <p
                  class="max-w-prose break-words text-base leading-relaxed text-(--text-secondary)"
                >
                  {{ v.description }}
                </p>
              } @else {
                <aec-under-review data-testid="vendor-description-under-review" />
              }
            </section>
          }
        </div>

        <div slot="body" class="space-y-12">
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
              <!-- Real table (replaces the former card stack) mirroring the
                   integrations table on the product page, so the vendor's
                   portfolio aligns into scannable columns. Rating collapses at
                   md (matching ProductCard / the browse tables). The table has
                   four columns: product, rating, integrations, and the row link.

                   The min width is 34rem, not the former 44rem. AECI-853 moved
                   DetailLayout's sidebar dock from xl to lg, which makes 608px
                   the narrowest this body column ever gets. At 44rem (704px) the
                   table overflowed that by 96px and scrolled inside a narrow
                   well. The 648px worst case measured for AECI-853 included a
                   category column that has since been removed, so the table is
                   narrower now than that figure. Do not raise this back above
                   38rem. -->
              <div class="overflow-x-auto">
                <table
                  class="w-full border-collapse text-start text-sm md:min-w-[34rem]"
                  i18n-aria-label="@@vendors.detail.body.products.table.aria"
                  aria-label="Products"
                >
                  <thead
                    class="border-b border-(--border-default) text-start text-xs
                      font-semibold tracking-wide text-(--text-secondary)"
                  >
                    <tr>
                      <th
                        scope="col"
                        class="px-4 py-3 text-start font-semibold"
                        i18n="@@vendors.detail.body.products.col.product"
                      >
                        Product
                      </th>
                      <th
                        scope="col"
                        class="hidden px-4 py-3 text-end font-semibold md:table-cell"
                        i18n="@@vendors.detail.body.products.col.rating"
                      >
                        Rating
                      </th>
                      <th
                        scope="col"
                        class="px-4 py-3 text-end font-semibold"
                        i18n="@@vendors.detail.body.products.col.integrations"
                      >
                        Integrations
                      </th>
                      <th scope="col" class="px-4 py-3">
                        <span class="sr-only" i18n="@@vendors.detail.body.products.col.details"
                          >Details</span
                        >
                      </th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-(--border-default)">
                    @for (product of productsAbove(); track product.id) {
                      <tr aec-vendor-product-row [product]="product"></tr>
                    }
                    @if (productsDeferred().length > 0) {
                      @defer (on viewport; hydrate on viewport) {
                        @for (product of productsDeferred(); track product.id) {
                          <tr aec-vendor-product-row [product]="product"></tr>
                        }
                      } @placeholder (minimum 100ms) {
                        <tr aria-hidden="true">
                          <td colspan="4" class="px-4 py-3">
                            <div
                              class="h-16 animate-pulse rounded-(--radius-lg)
                                border border-(--border-default) bg-(--surface-sunken)"
                            ></div>
                          </td>
                        </tr>
                      }
                    }
                  </tbody>
                </table>
              </div>
            }
          </section>
        </div>
      </aec-detail-layout>

      <aec-mailing-list-signup />

      <!-- In-place claim/correction drawer (AECI-128); opened by the
           aecRequestTrigger anchors above. Renders nothing until opened. -->
      <aec-request-drawer />
    }
  `,
})
export class VendorDetailPage {
  private readonly route = inject(ActivatedRoute);

  protected readonly logoAlt = logoAlt;

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
  // present URLs, in the launch priority order (LinkedIn, X, YouTube,
  // Facebook, Instagram — DESIGN/PRODUCT B0). All are full URLs from the
  // contract.
  private readonly socialLabels: Record<SocialKey, string> = {
    linkedin: $localize`:@@vendors.detail.social.linkedin:LinkedIn`,
    x: $localize`:@@vendors.detail.social.x:X (Twitter)`,
    youtube: $localize`:@@vendors.detail.social.youtube:YouTube`,
    facebook: $localize`:@@vendors.detail.social.facebook:Facebook`,
    instagram: $localize`:@@vendors.detail.social.instagram:Instagram`,
  };

  private readonly socialPaths: Record<SocialKey, string> = {
    linkedin:
      'M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 0 1-2.063-2.065 2.064 2.064 0 1 1 2.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.225 0z',
    x: 'M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z',
    youtube:
      'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
    facebook:
      'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z',
    instagram:
      'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163c-3.259 0-3.667.014-4.947.072-4.358.2-6.78 2.618-6.98 6.98-.059 1.281-.073 1.689-.073 4.948 0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98 1.281.058 1.689.072 4.948.072 3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98-1.281-.059-1.69-.073-4.949-.073zm0 5.838c-3.403 0-6.162 2.759-6.162 6.162s2.759 6.163 6.162 6.163 6.162-2.759 6.162-6.163c0-3.403-2.759-6.162-6.162-6.162zm0 10.162c-2.209 0-4-1.79-4-4 0-2.209 1.791-4 4-4s4 1.791 4 4c0 2.21-1.791 4-4 4zm6.406-11.845c-.796 0-1.441.645-1.441 1.44s.645 1.44 1.441 1.44c.795 0 1.439-.645 1.439-1.44s-.644-1.44-1.439-1.44z',
  };

  /** The page, for each caption's source link click. */
  protected readonly captionPage = computed<FieldCaptionPage>(() => ({
    surface: 'vendor_detail',
    entityType: 'vendor',
    entityId: this.vendor()?.id ?? '',
  }));

  protected readonly logoLabel = fieldOverrideLabel('logo_url');

  /** AECi's correction on the logo (AECI-1628): a replacement while it shows, a removal
   *  while there is none. */
  protected readonly logoCorrection = computed(() => {
    const v = this.vendor();
    return v ? correctionInSlot(v.corrections, 'logo_url', !!v.logo_url) : null;
  });

  /**
   * The corrections whose slot this page shows. A correction that set a value shows while
   * that value renders in the row above. One that cleared a value (AECI-1628) shows as
   * "Removed by" in its place, which takes in headquarters and founded year too: the
   * Company facts panel names a correction on its own row, but only while the row has a
   * value. A correction on a field the page never renders (the phone number, say) has no
   * slot.
   */
  protected readonly factCorrections = computed(() => {
    const v = this.vendor();
    if (!v) return [];
    const shown: Readonly<Record<string, unknown>> = {
      website: v.website,
      linkedin_url: v.linkedin_url,
      x_url: v.x_url,
      youtube_url: v.youtube_url,
      facebook_url: v.facebook_url,
      instagram_url: v.instagram_url,
    };
    const removable = new Set([...Object.keys(shown), 'headquarters', 'founded_year']);
    return (v.corrections ?? [])
      .filter((correction) =>
        correction.cleared
          ? removable.has(correction.field) &&
            (shown[correction.field] == null || shown[correction.field] === '')
          : shown[correction.field] != null && shown[correction.field] !== '',
      )
      .map((correction) => ({ correction, label: fieldOverrideLabel(correction.field) }));
  });

  /** AECI-1238 (§11d.7): the company description is hidden while AECi checks it. */
  protected readonly descriptionUnderReview = computed(() =>
    isUnderReview(this.vendor()?.under_review, 'description'),
  );

  /**
   * AECI-1238 (§11d.7): the hero links AECi hid while it checks them, in the row's own
   * order. The value is `null`, so its icon is not rendered and the line names it.
   */
  protected readonly linksUnderReview = computed(() => {
    const v = this.vendor();
    if (!v) return [];
    return HERO_LINK_FIELDS.filter((field) => isUnderReview(v.under_review, field)).map(
      (field) => ({ field, label: fieldOverrideLabel(field) }),
    );
  });

  protected readonly socialLinks = computed(() => {
    const v = this.vendor();
    if (!v) return [];
    const ordered: Array<{ key: SocialKey; href: string | null }> = [
      { key: 'linkedin', href: v.linkedin_url },
      { key: 'x', href: v.x_url },
      { key: 'youtube', href: v.youtube_url },
      { key: 'facebook', href: v.facebook_url },
      { key: 'instagram', href: v.instagram_url },
    ];
    return ordered
      .filter((s): s is { key: SocialKey; href: string } => !!s.href)
      .map(({ key, href }) => ({
        key,
        href,
        label: this.socialLabels[key],
        // A brand glyph is the ONE shape the drawn new-tab cue cannot join — a
        // 9x9 icon button has no room for a second mark, and adding one would
        // read as a sixth platform. So this link discloses the new tab in its
        // accessible name only, which is also its only name (AECI-980). The
        // `title` stays the bare platform so the hover tooltip is not a
        // sentence.
        aria: $localize`:@@vendors.detail.social.aria:${this.socialLabels[key]}:PLATFORM: (opens in a new tab)`,
        path: this.socialPaths[key],
      }));
  });

  /**
   * Ownership facts for the hero's outbound clicks (AECI-933). The vendor owns its
   * own website and social profiles, so the owner is always this vendor.
   */
  protected readonly linkContexts = computed<{
    website: ExternalLinkContext;
    social: ExternalLinkContext;
  } | null>(() => {
    const v = this.vendor();
    if (!v) return null;
    const base = {
      owner_vendor_id: v.id,
      link_origin: 'vendor',
      source_entity_type: 'vendor',
      source_entity_id: v.id,
    } as const;
    return {
      website: { ...base, link_purpose: 'website' },
      social: { ...base, link_purpose: 'social' },
    };
  });
}
