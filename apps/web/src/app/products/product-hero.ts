import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ProductDetail } from '@aeci/shared';

import type { ExternalLinkContext } from '../analytics/analytics';
import { ExternalLinkTracker } from '../analytics/external-link-tracker';
import { ReviewCta } from '../reviews/review-cta';
import { ReviewStars } from '../reviews/review-stars';
import { AecBreadcrumb, homeCrumb, type BreadcrumbItem } from '../shared/breadcrumb/breadcrumb';
import { AecButton } from '../shared/button/button';
import { Chip } from '../shared/chip/chip';
import { correctionLabel } from '../shared/field-caption/correction-labels';
import { isUnderReview } from '../shared/field-caption/field-caption-facts';
import { UnderReviewMarker } from '../shared/field-caption/under-review';
import { HeroBand } from '../shared/hero-band/hero-band';
import { AecIcon } from '../shared/icon/icon';
import { LogoOrInitial, logoAlt } from '../shared/logo-or-initial/logo-or-initial';
import { NewTabIcon } from '../shared/new-tab-icon/new-tab-icon';
import { UnclaimedNote } from '../shared/unclaimed-note/unclaimed-note';

import { descriptionParagraphs } from './product-about';
import { connectedProductCount } from './powered-hub-grouping';
import { ProductIntegrationWheel } from './product-integration-wheel';
import { RoleBadge } from './role-badge';

/**
 * AECI-1778 - the product page's Forest hero (`PLAN.md` §5.2 row 1, mock-up 6). It fills
 * the shared `aec-hero-band` (AECI-1766) and owns no frame of its own. Its own file, so the
 * other product-page issues (AECI-1779 to AECI-1788) do not collide in `product-detail.ts`.
 *
 * What it shows, all from the resolved `ProductDetail`, so the cached SSR HTML is the same
 * for every visitor:
 *
 *   - the breadcrumb, Bone on Forest;
 *   - the kicker row: the role chip, for a connector or hybrid only. The maintenance
 *     chip is retired (AECI-1666). Its words open "About this listing";
 *   - the mark and the name. The band renders the page's only `h1`. An unclaimed product's
 *     104px mark is the initial tile (the logo rule, AECI-1769, until counsel answers
 *     AECI-1826), and its small sourced logo with the "not affiliated" note sits under the
 *     name, as on the shipped page;
 *   - the vendor line and the connector reach line;
 *   - the ratings panel: the two averages kept apart, each shown only when the API sends
 *     it (it nulls them under five reviews), at one decimal, then the review count;
 *   - "Visit website" (the one filled button, `on-brand`) and "Write a review"
 *     (`on-brand-secondary`), with the website's under-review line. Every correction and
 *     caption is in "About this listing" (AECI-1666).
 *
 * The `heroPanel` slot holds the integrations wheel (`aec-product-integration-wheel`,
 * AECI-2018), which replaced ruling R3 decision 1's category hub and pair finder. It
 * shows the products this one has an integration with, A to Z by name (ruling R1). With
 * no integration on record there is no wheel and no panel: the facts card says so.
 *
 * Nothing else here orders anything. No paid-plan input is read.
 */
@Component({
  selector: 'aec-product-hero',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AecBreadcrumb,
    AecButton,
    AecIcon,
    Chip,
    ExternalLinkTracker,
    HeroBand,
    LogoOrInitial,
    NewTabIcon,
    ProductIntegrationWheel,
    ReviewCta,
    ReviewStars,
    RoleBadge,
    RouterLink,
    UnclaimedNote,
    UnderReviewMarker,
  ],
  host: { class: 'block' },
  template: `
    @let p = product();
    <aec-hero-band align="start">
      <aec-breadcrumb heroCrumbs tone="on-brand" [items]="crumbs()" />

      <!-- A connector or hybrid is flagged where the visitor first looks (Stage 1.5
           Addendum B). The role chip renders nothing for the default "application" role,
           so the row renders only for the other two. No "Product" eyebrow: the breadcrumb
           already says Products, and mock-up 6 drops it (AECI-1778). The maintenance chip
           that shared this row is retired (AECI-1666): its words open "About this
           listing". -->
      @if (p.product_role !== 'application') {
        <div heroKicker class="mt-4 flex flex-wrap items-center gap-2">
          <aec-role-badge [role]="p.product_role" />
        </div>
      }

      <!-- The logo rule decides the mark (AECI-1769): a claimed product's logo, or the
           initial tile. An unclaimed product is the tile at this size whatever the payload
           holds. -->
      <!-- Mock-up 6 .hero-mark: a soft 4px Bone ring and the card shadow around the mark.
           The radius stays the mark's own (AECI-1750 is still open). -->
      <aec-logo-or-initial
        heroMark
        class="rounded-mark shadow-card ring-4 ring-(--border-on-brand-subtle)"
        data-testid="product-hero-mark"
        [src]="p.logo_url"
        [name]="p.name"
        [alt]="logoAlt(p.name)"
        [claimStatus]="p.claim_status"
        size="hero"
        [priority]="true"
      />

      <span heroTitle>{{ p.name }}</span>

      <div heroByline class="space-y-3">
        @if (p.vendor; as v) {
          <p class="text-t-16 text-(--text-on-brand-secondary)" data-testid="product-hero-vendor">
            <ng-container i18n="@@products.detail.hero.byline"
              >by
              <a
                [routerLink]="['/vendors', v.slug]"
                class="underline decoration-(--border-on-brand-strong) underline-offset-4 hover:decoration-(--text-on-brand)"
                >{{ v.name }}</a
              ></ng-container
            >
          </p>
        }
        <!-- AECI-1618: an unclaimed listing keeps a small logo, not a header image, with
             counsel's wording directly beside it. -->
        @if (p.claim_status === 'unclaimed') {
          <div class="flex items-center gap-3">
            <aec-logo-or-initial
              [src]="p.logo_url"
              [name]="p.name"
              [alt]="logoAlt(p.name)"
              [claimStatus]="p.claim_status"
              [ownPage]="true"
              size="sm"
              [priority]="true"
            />
            <aec-unclaimed-note tone="on-brand" />
          </div>
        }
      </div>

      <!-- AECI-1720 restore C (mock-up 6, .lede): the start of the product's own
           description under the name, at --t-20 / 1.5 in the secondary on-brand ink,
           clamped to two lines. It is the description's first paragraph, its lines joined
           by a space, never new text. The full
           description is in the About band, so this copy is aria-hidden and a screen
           reader hears it once. The clamp is CSS on server-rendered text, so nothing
           shifts on hydration. No description, or one AECi hid while it checks it
           (the payload nulls it), prints nothing. -->
      @if (lede(); as text) {
        <p
          class="line-clamp-2 max-w-[32em] text-t-20 leading-normal text-(--text-on-brand-secondary)"
          aria-hidden="true"
          data-testid="product-hero-lede"
        >
          {{ text }}
        </p>
      }

      <!-- Connector reach line (Stage 1.5 Addendum C, §13.6). Shown whenever the product
           reaches at least one catalog product, with no role gate. "in the AEC
           Integrations catalog" carries §12.7's scope framing inline. -->
      @if (connectsLabel(); as connects) {
        <p class="text-t-16 text-(--text-on-brand-secondary)">{{ connects }}</p>
      }

      <!-- The ratings. Every value is a static product field, so it is cache-neutral. The
           API nulls each average under five reviews (§5.5): a rated product shows the
           averages it has, at one decimal, kept apart, then the count. With 1 to 4 reviews it
           shows "Not yet rated" and the count. At zero it is one plain line, not a panel:
           a lone bordered box read as a button. -->
      <!-- Mock-up 6 .hrate: the two scores and the review count in three cells, the figure
           at --t-fig. Below sm the two scores share the first row and the count takes its
           own row under a rule (mock-up 6 at 760px), so it never floats beside a score. -->
      @if (p.review_count > 0) {
        <div
          class="mt-8 grid max-w-full grid-cols-2 rounded-card border aec-on-brand-rule bg-(--surface-hero-panel) sm:inline-flex sm:items-stretch"
          data-testid="product-hero-ratings"
        >
          @if (p.rating_overall_avg !== null) {
            <div
              class="flex min-w-0 flex-col justify-center gap-1 px-4 py-4 sm:px-6"
              [class.col-span-2]="p.rating_onboarding_avg === null"
              data-testid="product-hero-rating-cell"
            >
              <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span
                  class="font-display text-t-fig font-semibold tabular-nums text-(--text-on-brand)"
                  >{{ decimal(p.rating_overall_avg) }}</span
                >
                <aec-review-stars [rating]="p.rating_overall_avg" kind="overall" />
              </span>
              <span
                class="text-t-13 font-semibold text-(--text-on-brand-secondary) sm:text-t-14"
                i18n="@@products.detail.hero.rating.overall"
                >Product quality</span
              >
            </div>
            @if (p.rating_onboarding_avg !== null) {
              <div
                class="flex min-w-0 flex-col justify-center gap-1 border-s px-4 py-4 aec-on-brand-rule sm:px-6"
                data-testid="product-hero-rating-cell"
              >
                <span class="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span
                    class="font-display text-t-fig font-semibold tabular-nums text-(--text-on-brand)"
                    >{{ decimal(p.rating_onboarding_avg) }}</span
                  >
                  <aec-review-stars [rating]="p.rating_onboarding_avg" kind="onboarding" />
                </span>
                <span
                  class="text-t-13 font-semibold text-(--text-on-brand-secondary) sm:text-t-14"
                  i18n="@@products.detail.hero.rating.onboarding"
                  >Onboarding experience</span
                >
              </div>
            }
          } @else {
            <div class="col-span-2 flex items-center px-4 py-4 sm:px-6">
              <aec-chip tone="quiet" i18n="@@products.detail.hero.notRated">Not yet rated</aec-chip>
            </div>
          }
          <div
            class="col-span-2 flex items-center border-t px-2 py-2 aec-on-brand-rule sm:border-s sm:border-t-0 sm:px-3"
            data-testid="product-hero-review-count"
          >
            <a
              [href]="'/products/' + p.slug + '#reviews'"
              data-smooth-scroll
              class="inline-flex min-h-11 items-center gap-2 rounded-control px-2 text-t-14 font-semibold text-(--text-on-brand) underline decoration-(--border-on-brand-strong) underline-offset-4 hover:decoration-(--text-on-brand) sm:px-3"
            >
              {{ reviewCountLabel(p.review_count) }}
              <aec-icon name="arrow-down" decorative [size]="4" />
            </a>
          </div>
        </div>
      } @else {
        <p
          class="mt-6 text-t-16 font-semibold text-(--text-on-brand-secondary)"
          data-testid="product-hero-ratings"
        >
          {{ reviewCountLabel(p.review_count) }}
        </p>
      }

      <!-- AECI-1238 (§11d.7): AECi hid the website while it checks it. -->
      @if (underReview('website')) {
        <aec-under-review
          class="mt-4"
          tone="on-brand"
          data-testid="website-under-review"
          [label]="websiteLabel"
        />
      }

      <!-- "Visit website" is the page's one filled button: Bone on Forest. The review CTA
           is cache-neutral and auth-aware (its SSR render is the generic "Write a review"). -->
      @if (p.website) {
        <a
          heroActions
          aecButton
          variant="on-brand"
          [href]="p.website"
          target="_blank"
          rel="noopener nofollow"
          aecTrackExternalLink="product_detail"
          [aecLinkContext]="websiteLinkContext()"
        >
          <ng-container i18n="@@products.detail.visitWebsite">Visit website</ng-container>
          <aec-new-tab-icon />
        </a>
      }
      <aec-review-cta heroActions [slug]="p.slug" [productId]="p.id" variant="on-brand-secondary" />

      <!-- AECI-2018: the integrations wheel. Its first slide is in the server HTML. With
           no integration on record it is not rendered, and the band draws no panel. -->
      @if (hasWheel()) {
        <div heroPanel data-testid="product-hero-visual">
          <aec-product-integration-wheel [product]="p" />
        </div>
      }
    </aec-hero-band>
  `,
})
export class ProductHero {
  readonly product = input.required<ProductDetail>();

  protected readonly logoAlt = logoAlt;

  /**
   * The hero lede (AECI-1720 restore C, mock-up 6 `.lede`): the description's first
   * paragraph, split the way the About band splits it, its lines joined by a space.
   * `null` with no description, which includes one AECi hid while it checks it.
   */
  protected readonly lede = computed(() => {
    const first = descriptionParagraphs(this.product().description)[0];
    return first ? first.join(' ') : null;
  });

  /** The wheel shows when the page has an endpoint row: every row has a partner. */
  protected readonly hasWheel = computed(() => {
    const p = this.product();
    return p.integrations_as_source.length + p.integrations_as_target.length > 0;
  });
  protected readonly websiteLabel = correctionLabel('website');

  protected readonly crumbs = computed<BreadcrumbItem[]>(() => [
    homeCrumb(),
    { label: $localize`:@@products.detail.breadcrumbs.products:Products`, link: '/products' },
    { label: this.product().name },
  ]);

  /**
   * Ownership facts for the "Visit website" click (AECI-933). The owner is the product's
   * primary vendor. A product with no vendor sends a `null` owner rather than guessing.
   */
  protected readonly websiteLinkContext = computed<ExternalLinkContext>(() => {
    const p = this.product();
    return {
      owner_vendor_id: p.vendor?.id ?? null,
      link_origin: 'vendor',
      source_entity_type: 'product',
      source_entity_id: p.id,
      link_purpose: 'website',
    };
  });

  /** AECI-1238 (§11d.7): whether AECi hid `field` while it checks it. */
  protected underReview(field: string): boolean {
    return isUnderReview(this.product().under_review, field);
  }

  /** One-decimal display of an average rating, e.g. 4 → "4.0", 4.25 → "4.3". */
  protected decimal(value: number): string {
    return value.toFixed(1);
  }

  /**
   * The review-count label, for any count, so it pluralizes all three cases. In the
   * component rather than a template ICU, matching `IntegrationStat`.
   */
  protected reviewCountLabel(count: number): string {
    if (count === 0) return $localize`:@@products.detail.hero.reviewCount.none:No reviews yet`;
    if (count === 1) return $localize`:@@products.detail.hero.reviewCount.one:1 review`;
    return $localize`:@@products.detail.hero.reviewCount.other:${count}:COUNT: reviews`;
  }

  /**
   * "Connects N products in the AEC Integrations catalog" (§13.6), or `null` at 0: a
   * connector with nothing to count says nothing rather than zero. Not gated on
   * `product_role`, the same data-driven reading the powered section takes.
   */
  protected readonly connectsLabel = computed<string | null>(() => {
    const p = this.product();
    const count = connectedProductCount(p.integrations_as_connector, p.slug);
    if (count === 0) return null;
    if (count === 1) {
      return $localize`:@@products.detail.hero.connects.one:Connects 1 product in the AEC Integrations catalog`;
    }
    return $localize`:@@products.detail.hero.connects.other:Connects ${count}:count: products in the AEC Integrations catalog`;
  });
}
