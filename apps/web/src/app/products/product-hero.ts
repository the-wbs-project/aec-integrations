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
import { FieldCaptionLine, type FieldCaptionPage } from '../shared/field-caption/field-caption';
import { correctionInSlot, isUnderReview } from '../shared/field-caption/field-caption-facts';
import { UnderReviewMarker } from '../shared/field-caption/under-review';
import { HeroBand } from '../shared/hero-band/hero-band';
import { LogoOrInitial, logoAlt } from '../shared/logo-or-initial/logo-or-initial';
import { MaintenanceMarker } from '../shared/maintenance-marker/maintenance-marker';
import { NewTabIcon } from '../shared/new-tab-icon/new-tab-icon';
import { UnclaimedNote } from '../shared/unclaimed-note/unclaimed-note';
import { fieldOverrideLabel } from '../vendor/components/field-override-labels';

import { connectedProductCount } from './powered-hub-grouping';
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
 *   - the kicker row: the role chip and the maintenance chip with
 *     its "Reviewed" or "Updated" date (ruling R3, decision 12);
 *   - the mark and the name. The band renders the page's only `h1`. An unclaimed product's
 *     104px mark is the initial tile (the logo rule, AECI-1769, until counsel answers
 *     AECI-1826), and its small sourced logo with the "not affiliated" note sits under the
 *     name, as on the shipped page;
 *   - the vendor line, the connector reach line and the logo correction caption;
 *   - the ratings panel: the two averages kept apart, each shown only when the API sends
 *     it (it nulls them under five reviews), at one decimal, then the review count;
 *   - "Visit website" (the one filled button, `on-brand`) and "Write a review"
 *     (`on-brand-secondary`), with the website's correction and under-review lines.
 *
 * The `heroPanel` slot is left empty. Ruling R3 decision 1 settled the visual as a category
 * hub with a pair finder, and AECI-1787 builds it.
 *
 * Nothing here orders anything. No paid-plan input is read.
 */
@Component({
  selector: 'aec-product-hero',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AecBreadcrumb,
    AecButton,
    Chip,
    ExternalLinkTracker,
    FieldCaptionLine,
    HeroBand,
    LogoOrInitial,
    MaintenanceMarker,
    NewTabIcon,
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
    <aec-hero-band>
      <aec-breadcrumb heroCrumbs tone="on-brand" [items]="crumbs()" />

      <!-- The role chip renders nothing for the default "application" role, so most
           products show the maintenance chip alone. A connector or hybrid is flagged where
           the visitor first looks (Stage 1.5 Addendum B). No "Product" eyebrow: the
           breadcrumb already says Products, and mock-up 6 drops it (AECI-1778). -->
      <div heroKicker class="mt-4 flex flex-wrap items-center gap-2">
        <aec-role-badge [role]="p.product_role" />
        <aec-maintenance-marker
          [maintainedBy]="p.maintenance.maintained_by"
          [reviewedAt]="p.maintenance.last_reviewed_at"
          [ownerName]="p.vendor?.name ?? null"
        />
      </div>

      <!-- The logo rule decides the mark (AECI-1769): a claimed product's logo, or the
           initial tile. An unclaimed product is the tile at this size whatever the payload
           holds. -->
      <aec-logo-or-initial
        heroMark
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
        <!-- AECI-1628: AECi replaced or removed the logo a vendor holds. The mark sits
             beside this column, so the line names it. -->
        @if (slotCorrection('logo_url', !!p.logo_url); as c) {
          <aec-field-caption
            data-testid="logo-correction"
            tone="on-brand"
            [correction]="c"
            [label]="logoLabel"
            [page]="captionPage()"
          />
        }
      </div>

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
      @if (p.review_count > 0) {
        <div
          class="mt-8 inline-flex max-w-full flex-wrap items-stretch rounded-card border aec-on-brand-rule bg-(--surface-hero-panel)"
          data-testid="product-hero-ratings"
        >
          @if (p.rating_overall_avg !== null) {
            <div class="flex flex-col justify-center gap-1 px-6 py-4">
              <span class="flex items-center gap-3">
                <span
                  class="font-display text-t-24 font-semibold tabular-nums text-(--text-on-brand)"
                  >{{ decimal(p.rating_overall_avg) }}</span
                >
                <aec-review-stars [rating]="p.rating_overall_avg" kind="overall" />
              </span>
              <span
                class="text-t-14 font-semibold text-(--text-on-brand-secondary)"
                i18n="@@products.detail.hero.rating.overall"
                >Overall</span
              >
            </div>
            @if (p.rating_onboarding_avg !== null) {
              <div
                class="flex flex-col justify-center gap-1 px-6 py-4 sm:border-s aec-on-brand-rule"
              >
                <span class="flex items-center gap-3">
                  <span
                    class="font-display text-t-24 font-semibold tabular-nums text-(--text-on-brand)"
                    >{{ decimal(p.rating_onboarding_avg) }}</span
                  >
                  <aec-review-stars [rating]="p.rating_onboarding_avg" kind="onboarding" />
                </span>
                <span
                  class="text-t-14 font-semibold text-(--text-on-brand-secondary)"
                  i18n="@@products.detail.hero.rating.onboarding"
                  >Onboarding</span
                >
              </div>
            }
          } @else {
            <div class="flex items-center px-6 py-4">
              <aec-chip tone="quiet" i18n="@@products.detail.hero.notRated">Not yet rated</aec-chip>
            </div>
          }
          <div class="flex items-center px-6 py-4 sm:border-s aec-on-brand-rule">
            <a
              [href]="'/products/' + p.slug + '#reviews'"
              data-smooth-scroll
              class="text-t-14 font-semibold text-(--text-on-brand) underline decoration-(--border-on-brand-strong) underline-offset-4 hover:decoration-(--text-on-brand)"
            >
              {{ reviewCountLabel(p.review_count) }}
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

      @if (slotCorrection('website', !!p.website); as c) {
        <aec-field-caption
          class="mt-4"
          tone="on-brand"
          [correction]="c"
          [label]="websiteLabel"
          [page]="captionPage()"
        />
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
      <!-- AECI-1614: the profile caption (website and categories) sits under Categories.
           With no categories, it sits here with the website. -->
      @if (p.categories.length === 0 && p.captions?.profile; as c) {
        <aec-field-caption
          class="mt-4"
          tone="on-brand"
          data-testid="profile-caption"
          [caption]="c"
          [page]="captionPage()"
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
    </aec-hero-band>
  `,
})
export class ProductHero {
  readonly product = input.required<ProductDetail>();

  protected readonly logoAlt = logoAlt;
  protected readonly websiteLabel = fieldOverrideLabel('website');
  protected readonly logoLabel = fieldOverrideLabel('logo_url');

  protected readonly crumbs = computed<BreadcrumbItem[]>(() => [
    homeCrumb(),
    { label: $localize`:@@products.detail.breadcrumbs.products:Products`, link: '/products' },
    { label: this.product().name },
  ]);

  /** The page, for each caption's source link click. */
  protected readonly captionPage = computed<FieldCaptionPage>(() => ({
    surface: 'product_detail',
    entityType: 'product',
    entityId: this.product().id,
  }));

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

  /** AECi's correction in one value's slot (AECI-1628). */
  protected slotCorrection(field: string, present: boolean) {
    return correctionInSlot(this.product().captions?.corrections, field, present);
  }

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
