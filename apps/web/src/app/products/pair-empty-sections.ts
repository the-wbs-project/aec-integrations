import { formatNumber } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  inject,
  input,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { RATING_VISIBILITY_MIN_REVIEWS, canonicalPairIds } from '@aeci/shared';
import type { FieldCorrection, ProductPairSubject } from '@aeci/shared';

import type { ExternalLinkContext } from '../analytics/analytics';
import { ExternalLinkTracker } from '../analytics/external-link-tracker';
import { ReviewStars } from '../reviews/review-stars';
import { AecCard } from '../shared/card/card';
import { Chip } from '../shared/chip/chip';
import { FieldCaptionLine, type FieldCaptionPage } from '../shared/field-caption/field-caption';
import { correctionInSlot, isUnderReview } from '../shared/field-caption/field-caption-facts';
import { UnderReviewMarker } from '../shared/field-caption/under-review';
import { AecIcon } from '../shared/icon/icon';
import { LogoOrInitial, logoAlt } from '../shared/logo-or-initial/logo-or-initial';
import { NewTabIcon } from '../shared/new-tab-icon/new-tab-icon';
import { TaxonomyBadge } from '../shared/taxonomy-badge/taxonomy-badge';
import { UnclaimedNote } from '../shared/unclaimed-note/unclaimed-note';
import { fieldOverrideLabel } from '../vendor/components/field-override-labels';

import { integrationNoun } from './integration-stat';
import { integrationsOnRecordCount } from './integrations-on-record';

/** A group heading: the overline with its 16px glyph, as on the product page. */
const GROUP_HEADING = 'aec-overline flex items-center gap-2 text-(--text-secondary)';

/** The shared focus ring on a light ground, 3px at 3px. */
const FOCUS_RING =
  'focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

/** One rating cell: the average at one decimal, or `null` under the §5.5 gate. */
function visibleRating(average: number | null, reviews: number): string | null {
  return reviews >= RATING_VISIBILITY_MIN_REVIEWS && average !== null ? average.toFixed(1) : null;
}

/**
 * Whether a product has anything for "Who each product is for": a term in one of the three
 * groups, or AECi's removal in an emptied group's slot. The product page's test
 * (`hasWhoItIsFor`) over the pair subject.
 */
function hasWho(p: ProductPairSubject): boolean {
  const corrections = p.captions?.corrections;
  return (
    p.audiences.length > 0 ||
    p.trades.length > 0 ||
    p.phases.length > 0 ||
    !!correctionInSlot(corrections, 'audience_slugs', false) ||
    !!correctionInSlot(corrections, 'trade_slugs', false) ||
    !!correctionInSlot(corrections, 'phase_slugs', false)
  );
}

/**
 * AECI-1827: the body of the empty pair page, the pair with no integration and no
 * connector-evidenced pair on record (`STAGE_1_5_SPEC.md` §11.4, `PLAN.md` §5.1). The hero
 * above it carries the status pill, the statement and the caveat (`ProductsPairPage`).
 *
 * Two sections, in §11.4's order (sections 2 to 5 of the template are later issues):
 *
 *  - **The two products, side by side.** A facts table (integrations on record, reviews,
 *    and the two ratings, each side its own cell, never blended) and "Who each product is
 *    for" (audiences, trades and project phases, in the order the product page uses, with
 *    the same corrections and "Maintained by" caption). With no reviews on either side the
 *    reviews row and both rating rows are absent. Under five reviews a side shows "Not yet
 *    rated", as on the product hero.
 *  - **Look it up yourself.** Each product's integrations page and API documentation, as
 *    new-tab links, under the legal-reviewed intro. A link shows exactly as on the product
 *    page's facts card: corrected, with "Corrected by"; hidden for checking, as "Under
 *    review"; removed, as "Removed by" and no link.
 *
 * The two products appear in URL order, context first. Nothing here orders, filters or
 * features by a paid-plan input. Every value is a static listing field, so the cached SSR
 * HTML is the same for every visitor. An unclaimed product shows its initial tile, never
 * its logo, and the Unclaimed note.
 */
@Component({
  selector: 'aec-pair-empty-sections',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    AecCard,
    AecIcon,
    Chip,
    ExternalLinkTracker,
    FieldCaptionLine,
    LogoOrInitial,
    NewTabIcon,
    ReviewStars,
    RouterLink,
    TaxonomyBadge,
    UnclaimedNote,
    UnderReviewMarker,
  ],
  host: { class: 'block' },
  template: `
    <div class="grid gap-16 md:gap-24">
      <section
        aria-labelledby="pair-side-by-side-title"
        class="space-y-8"
        data-testid="pair-empty-side-by-side"
      >
        <h2 id="pair-side-by-side-title" class="m-0">
          <span
            class="font-display text-t-36 leading-[1.1] tracking-[-0.02em]"
            i18n="@@pair.empty.sideBySide.title"
            >The two products, side by side</span
          >
        </h2>

        <div aecCard class="min-w-0 p-4 sm:p-6 md:p-8">
          <table
            class="w-full table-fixed border-collapse text-start"
            aria-labelledby="pair-side-by-side-title"
            data-testid="pair-empty-facts"
          >
            <colgroup>
              <col class="w-[28%] sm:w-1/4" />
              <col />
              <col />
            </colgroup>
            <thead>
              <tr>
                <td></td>
                @for (s of sides(); track s.key) {
                  <th scope="col" class="px-2 pb-4 align-bottom text-start font-normal sm:px-4">
                    <span class="flex min-w-0 flex-col items-start gap-2">
                      <aec-logo-or-initial
                        [name]="s.product.name"
                        [src]="s.product.logo_url"
                        [alt]="logoAlt(s.product.name)"
                        [claimStatus]="s.product.claim_status"
                        size="sm"
                      />
                      <a
                        [routerLink]="['/products', s.product.slug]"
                        class="min-w-0 font-display text-t-16 font-semibold break-words text-(--text-primary) no-underline underline-offset-3 hover:text-(--accent-primary) hover:underline sm:text-t-20 {{
                          focusRing
                        }}"
                        >{{ s.product.name }}</a
                      >
                      @if (s.product.vendor) {
                        <span class="text-t-13 break-words text-(--text-secondary)">{{
                          s.product.vendor.name
                        }}</span>
                      }
                      @if (s.product.claim_status === 'unclaimed') {
                        <aec-unclaimed-note />
                      }
                    </span>
                  </th>
                }
              </tr>
            </thead>
            <tbody>
              <tr class="border-t" data-testid="pair-empty-facts-integrations">
                <th scope="row" [class]="rowHeader">
                  <span i18n="@@pair.empty.facts.integrations">Integrations on record</span>
                </th>
                @for (s of sides(); track s.key) {
                  <td [class]="cell">
                    <!-- The product page facts card's figure (integrationsOnRecordCount),
                         so the two pages print the same number. A zero is words, never a
                         bare 0 (ruling 96, option B). -->
                    @if (s.onRecord > 0) {
                      <span
                        class="block font-display text-t-20 leading-[1.1] font-semibold tabular-nums text-(--text-primary)"
                        >{{ count(s.onRecord) }}</span
                      >&ngsp;
                      <span class="text-t-13 text-(--text-secondary)">{{ noun(s.onRecord) }}</span>
                    } @else {
                      <span
                        class="text-t-14 text-(--text-secondary)"
                        i18n="@@pair.empty.facts.integrationsNone"
                        >None on record yet</span
                      >
                    }
                  </td>
                }
              </tr>
              @if (hasReviews()) {
                <tr class="border-t" data-testid="pair-empty-facts-reviews">
                  <th scope="row" [class]="rowHeader">
                    <span i18n="@@pair.empty.facts.reviews">Reviews</span>
                  </th>
                  @for (s of sides(); track s.key) {
                    <td [class]="cell">
                      <span class="text-t-14 text-(--text-primary)">{{
                        reviewCountLabel(s.product.review_count)
                      }}</span>
                    </td>
                  }
                </tr>
                <tr class="border-t" data-testid="pair-empty-facts-overall">
                  <th scope="row" [class]="rowHeader">
                    <span i18n="@@products.detail.hero.rating.overall">Overall</span>
                  </th>
                  @for (s of sides(); track s.key) {
                    <td [class]="cell">
                      @if (s.overall; as value) {
                        <span class="flex flex-col items-start gap-1">
                          <span
                            class="font-display text-t-20 leading-none font-semibold tabular-nums text-(--text-primary)"
                            >{{ value }}</span
                          >
                          <aec-review-stars
                            [rating]="s.product.rating_overall_avg!"
                            kind="overall"
                          />
                        </span>
                      } @else {
                        <aec-chip tone="quiet" i18n="@@products.detail.hero.notRated"
                          >Not yet rated</aec-chip
                        >
                      }
                    </td>
                  }
                </tr>
                <tr class="border-t" data-testid="pair-empty-facts-onboarding">
                  <th scope="row" [class]="rowHeader">
                    <span i18n="@@products.detail.hero.rating.onboarding">Onboarding</span>
                  </th>
                  @for (s of sides(); track s.key) {
                    <td [class]="cell">
                      @if (s.onboarding; as value) {
                        <span class="flex flex-col items-start gap-1">
                          <span
                            class="font-display text-t-20 leading-none font-semibold tabular-nums text-(--text-primary)"
                            >{{ value }}</span
                          >
                          <aec-review-stars
                            [rating]="s.product.rating_onboarding_avg!"
                            kind="onboarding"
                          />
                        </span>
                      } @else {
                        <aec-chip tone="quiet" i18n="@@products.detail.hero.notRated"
                          >Not yet rated</aec-chip
                        >
                      }
                    </td>
                  }
                </tr>
              }
            </tbody>
          </table>
        </div>

        @if (showWho()) {
          <section
            aecCard
            aria-labelledby="pair-who-title"
            class="space-y-6 p-6 md:p-8"
            data-testid="pair-empty-who"
          >
            <h3 id="pair-who-title" class="m-0">
              <span class="font-display text-t-24 font-semibold" i18n="@@pair.empty.who.title"
                >Who each product is for</span
              >
            </h3>
            <div class="grid gap-8 md:grid-cols-2 md:gap-12">
              @for (s of sides(); track s.key) {
                @let p = s.product;
                <section
                  [attr.aria-labelledby]="'pair-who-' + s.key"
                  class="min-w-0 space-y-5"
                  [attr.data-testid]="'pair-empty-who-' + s.key"
                >
                  <h4 [id]="'pair-who-' + s.key" class="m-0 font-display text-t-20 font-semibold">
                    {{ p.name }}
                  </h4>
                  @if (!s.hasWho) {
                    <p class="text-t-14 text-(--text-secondary)" i18n="@@pair.empty.who.none">
                      Nothing listed yet.
                    </p>
                  }
                  @if (p.audiences.length > 0 || slot(p, 'audience_slugs', false)) {
                    <div class="min-w-0 space-y-3">
                      <h5 [class]="groupHeading">
                        <aec-icon name="users" decorative [size]="4" />
                        <span i18n="@@products.detail.metadata.audiences">Audiences</span>
                      </h5>
                      @if (p.audiences.length > 0) {
                        <div class="flex flex-wrap gap-2">
                          @for (d of p.audiences; track d.slug) {
                            <aec-taxonomy-badge kind="audience" [slug]="d.slug" [name]="d.name" />
                          }
                        </div>
                      }
                      <aec-field-caption
                        [correction]="slot(p, 'audience_slugs', p.audiences.length > 0)"
                        [page]="page()"
                      />
                    </div>
                  }
                  @if (p.trades.length > 0 || slot(p, 'trade_slugs', false)) {
                    <div class="min-w-0 space-y-3">
                      <h5 [class]="groupHeading">
                        <aec-icon name="hard-hat" decorative [size]="4" />
                        <span i18n="@@products.detail.metadata.trades">Trades</span>
                      </h5>
                      @if (p.trades.length > 0) {
                        <div class="flex flex-wrap gap-2">
                          @for (tr of p.trades; track tr.slug) {
                            <aec-taxonomy-badge kind="trade" [slug]="tr.slug" [name]="tr.name" />
                          }
                        </div>
                      }
                      <aec-field-caption
                        [correction]="slot(p, 'trade_slugs', p.trades.length > 0)"
                        [page]="page()"
                      />
                    </div>
                  }
                  @if (p.phases.length > 0 || slot(p, 'phase_slugs', false)) {
                    <div class="min-w-0 space-y-3">
                      <h5 [class]="groupHeading">
                        <aec-icon name="gantt" decorative [size]="4" />
                        <span i18n="@@products.detail.metadata.phases">Project phases</span>
                      </h5>
                      @if (p.phases.length > 0) {
                        <div class="flex flex-wrap gap-2">
                          @for (ph of p.phases; track ph.slug) {
                            <aec-taxonomy-badge kind="phase" [slug]="ph.slug" [name]="ph.name" />
                          }
                        </div>
                      }
                      <aec-field-caption
                        [correction]="slot(p, 'phase_slugs', p.phases.length > 0)"
                        [page]="page()"
                      />
                    </div>
                  }
                  <!-- The Managed group's line, while one of the three groups has a term,
                       as on the product page's "Who it is for". -->
                  @if (s.whoCaption; as c) {
                    <aec-field-caption
                      data-testid="pair-who-managed-caption"
                      [caption]="c"
                      [page]="page()"
                    />
                  }
                </section>
              }
            </div>
          </section>
        }
      </section>

      <section
        aria-labelledby="pair-look-it-up-title"
        class="space-y-8"
        data-testid="pair-empty-look-it-up"
      >
        <div class="max-w-prose space-y-3">
          <h2 id="pair-look-it-up-title" class="m-0">
            <span
              class="font-display text-t-36 leading-[1.1] tracking-[-0.02em]"
              i18n="@@pair.empty.lookItUp.title"
              >Look it up yourself</span
            >
          </h2>
          <p
            class="text-t-16 leading-relaxed text-(--text-secondary)"
            data-testid="pair-empty-look-it-up-intro"
            i18n="@@pair.empty.lookItUp.intro"
          >
            Linked as each vendor publishes them. What they say about building a connection is
            theirs, not ours.
          </p>
        </div>

        <div class="grid gap-6 md:grid-cols-2">
          @for (s of sides(); track s.key) {
            @let p = s.product;
            <section
              aecCard
              [attr.aria-labelledby]="'pair-look-' + s.key"
              class="min-w-0 space-y-4 p-6"
              [attr.data-testid]="'pair-empty-look-' + s.key"
            >
              <div class="flex min-w-0 items-center gap-3">
                <aec-logo-or-initial
                  [name]="p.name"
                  [src]="p.logo_url"
                  [alt]="logoAlt(p.name)"
                  [claimStatus]="p.claim_status"
                  size="sm"
                />
                <div class="min-w-0">
                  <h3 [id]="'pair-look-' + s.key" class="m-0">
                    <span class="font-display text-t-20 font-semibold break-words">{{
                      p.name
                    }}</span>
                  </h3>
                  @if (p.vendor) {
                    <p class="m-0 text-t-13 text-(--text-secondary)">{{ p.vendor.name }}</p>
                  }
                </div>
              </div>
              @if (p.claim_status === 'unclaimed') {
                <aec-unclaimed-note />
              }

              @if (s.hasLinkSlot) {
                <ul class="m-0 grid list-none gap-0.5 p-0">
                  @if (p.tool_integrations_url) {
                    <li>
                      <a
                        [href]="p.tool_integrations_url"
                        target="_blank"
                        rel="noopener nofollow"
                        aecTrackExternalLink="pair_detail"
                        [aecLinkContext]="linkContext(p, 'listing')"
                        [class]="resourceLinkClass"
                        [attr.data-testid]="'pair-look-integrations-' + s.key"
                      >
                        <span [class]="resourceTileClass"
                          ><aec-icon name="grid" decorative [size]="4"
                        /></span>
                        <span
                          class="min-w-0 flex-1"
                          i18n="@@products.detail.metadata.integrationsPage"
                          >Integrations page</span
                        >
                        <span class="text-(--text-secondary)"><aec-new-tab-icon /></span>
                      </a>
                      @if (slot(p, 'tool_integrations_url', true); as c) {
                        <aec-field-caption class="mt-1" [correction]="c" [page]="page()" />
                      }
                    </li>
                  } @else if (review(p, 'tool_integrations_url')) {
                    <li>
                      <aec-under-review
                        [attr.data-testid]="'pair-look-integrations-under-review-' + s.key"
                        [label]="correctionLabel('tool_integrations_url')"
                      />
                    </li>
                  } @else if (slot(p, 'tool_integrations_url', false); as c) {
                    <li>
                      <aec-field-caption
                        [correction]="c"
                        [label]="correctionLabel('tool_integrations_url')"
                        [page]="page()"
                      />
                    </li>
                  }
                  @if (p.api_docs_url) {
                    <li>
                      <a
                        [href]="p.api_docs_url"
                        target="_blank"
                        rel="noopener nofollow"
                        aecTrackExternalLink="pair_detail"
                        [aecLinkContext]="linkContext(p, 'docs')"
                        [class]="resourceLinkClass"
                        [attr.data-testid]="'pair-look-api-' + s.key"
                      >
                        <span [class]="resourceTileClass"
                          ><aec-icon name="code" decorative [size]="4"
                        /></span>
                        <span class="min-w-0 flex-1" i18n="@@products.detail.metadata.apiDocs"
                          >API documentation</span
                        >
                        <span class="text-(--text-secondary)"><aec-new-tab-icon /></span>
                      </a>
                      @if (slot(p, 'api_docs_url', true); as c) {
                        <aec-field-caption class="mt-1" [correction]="c" [page]="page()" />
                      }
                    </li>
                  } @else if (review(p, 'api_docs_url')) {
                    <li>
                      <aec-under-review
                        [attr.data-testid]="'pair-look-api-under-review-' + s.key"
                        [label]="correctionLabel('api_docs_url')"
                      />
                    </li>
                  } @else if (slot(p, 'api_docs_url', false); as c) {
                    <li>
                      <aec-field-caption
                        [correction]="c"
                        [label]="correctionLabel('api_docs_url')"
                        [page]="page()"
                      />
                    </li>
                  }
                </ul>
              }
              <!-- The Managed group's line beside the links, while one of them shows, as
                   on the product page's facts card. -->
              @if (s.linkCaption; as c) {
                <aec-field-caption
                  data-testid="pair-look-managed-caption"
                  [caption]="c"
                  [page]="page()"
                />
              }
              @if (s.noDirectory; as line) {
                <p
                  class="flex gap-2 rounded-panel bg-(--surface-sunken) p-4 text-t-14 leading-normal text-(--text-secondary)"
                  [attr.data-testid]="'pair-look-no-directory-' + s.key"
                >
                  <aec-icon name="info" class="mt-0.5 shrink-0" decorative [size]="4" />
                  <span>{{ line }}</span>
                </p>
              }
            </section>
          }
        </div>

        <!-- Legal review item 10: an API is not an integration. The words are the ones
             STAGE_1_5_SPEC.md section 11.4 fixed, shared with the product page. -->
        <p
          class="flex max-w-prose gap-2 rounded-panel bg-(--accent-warm) p-4 text-t-14 leading-normal text-(--text-primary)"
          data-testid="pair-look-api-note"
        >
          <aec-icon name="info" class="mt-0.5 shrink-0" decorative [size]="4" />
          <span i18n="@@products.detail.body.integrations.zero.apiNote"
            >An API is not an integration. We list an integration only when we can show that one
            exists.</span
          >
        </p>
      </section>
    </div>
  `,
})
export class PairEmptySections {
  /** The URL's first product. */
  readonly context = input.required<ProductPairSubject>();
  /** The URL's second product. */
  readonly other = input.required<ProductPairSubject>();
  /** The pair page, for each caption's source link click. */
  readonly page = input.required<FieldCaptionPage>();

  private readonly locale = inject(LOCALE_ID);

  protected readonly logoAlt = logoAlt;
  protected readonly correctionLabel = fieldOverrideLabel;
  protected readonly groupHeading = GROUP_HEADING;
  protected readonly focusRing = FOCUS_RING;
  protected readonly rowHeader =
    'py-4 pe-2 text-start align-top text-t-13 font-semibold text-(--text-secondary) sm:text-t-14';
  protected readonly cell = 'px-2 py-4 align-top sm:px-4';

  /** The facts card's Resources link classes, so the two read as one pattern. */
  protected readonly resourceLinkClass =
    '-ms-2 flex items-center gap-3 rounded-control py-2 ps-2 pe-3 text-t-16 font-semibold text-(--text-primary) no-underline transition-colors duration-fast ease-standard hover:bg-(--surface-sunken) ' +
    FOCUS_RING;

  protected readonly resourceTileClass =
    'grid size-8 shrink-0 place-items-center rounded-control bg-(--accent-primary-soft) text-(--accent-primary)';

  /** The two sides in URL order, context first, with what each cell shows. */
  protected readonly sides = computed(() =>
    (
      [
        ['context', this.context()],
        ['other', this.other()],
      ] as const
    ).map(([key, product]) => {
      const hasLink = !!product.tool_integrations_url || !!product.api_docs_url;
      const hasTerms =
        product.audiences.length > 0 || product.trades.length > 0 || product.phases.length > 0;
      const managed = product.captions?.managed ?? null;
      return {
        key,
        product,
        onRecord: integrationsOnRecordCount(
          product.integration_count,
          product.listed_integration_count ?? 0,
        ),
        overall: visibleRating(product.rating_overall_avg, product.review_count),
        onboarding: visibleRating(product.rating_onboarding_avg, product.review_count),
        hasWho: hasWho(product),
        whoCaption: hasTerms ? managed : null,
        linkCaption: hasLink ? managed : null,
        hasLinkSlot:
          hasLink ||
          (['tool_integrations_url', 'api_docs_url'] as const).some(
            (field) =>
              isUnderReview(product.under_review, field) ||
              !!correctionInSlot(product.captions?.corrections, field, false),
          ),
        noDirectory: this.noDirectoryLine(product),
      };
    }),
  );

  /** §11.4: with no reviews on either side the reviews row and both rating rows go. */
  protected readonly hasReviews = computed(
    () => this.context().review_count > 0 || this.other().review_count > 0,
  );

  /** Whether "Who each product is for" has anything to show on either side. */
  protected readonly showWho = computed(() => hasWho(this.context()) || hasWho(this.other()));

  /** The printed count, as the product page's facts card prints it. */
  protected count(value: number): string {
    return formatNumber(value, this.locale, '1.0-0');
  }

  protected noun(count: number): string {
    return integrationNoun(count);
  }

  /** The product hero's review-count words, from the same message ids. */
  protected reviewCountLabel(count: number): string {
    if (count === 0) return $localize`:@@products.detail.hero.reviewCount.none:No reviews yet`;
    if (count === 1) return $localize`:@@products.detail.hero.reviewCount.one:1 review`;
    return $localize`:@@products.detail.hero.reviewCount.other:${count}:COUNT: reviews`;
  }

  /** AECi's correction in one value's slot (AECI-1628), as on the product page. */
  protected slot(p: ProductPairSubject, field: string, present: boolean): FieldCorrection | null {
    return correctionInSlot(p.captions?.corrections, field, present);
  }

  /** AECI-1238 (§11d.7): whether AECi hid `field` while it checks it. */
  protected review(p: ProductPairSubject, field: string): boolean {
    return isUnderReview(p.under_review, field);
  }

  /**
   * A click on a vendor's own link. The owner is the product's primary vendor, as on the
   * product page. The source is the pair, under its canonical key (AECI-933).
   */
  protected linkContext(p: ProductPairSubject, purpose: 'listing' | 'docs'): ExternalLinkContext {
    return {
      owner_vendor_id: p.vendor?.id ?? null,
      link_origin: 'vendor',
      source_entity_type: 'pair',
      source_entity_id: canonicalPairIds(this.context().id, this.other().id).join(':'),
      link_purpose: purpose,
    };
  }

  /**
   * "We have not found an integrations page published by {vendor}.", or `null`. The
   * product page's rule (`showsNoIntegrationsDirectory`): a vendor and no link, and the
   * link neither hidden for checking nor removed by AECi.
   */
  private noDirectoryLine(p: ProductPairSubject): string | null {
    if (!p.vendor || p.tool_integrations_url) return null;
    if (isUnderReview(p.under_review, 'tool_integrations_url')) return null;
    if (correctionInSlot(p.captions?.corrections, 'tool_integrations_url', false)) return null;
    const vendor = p.vendor.name;
    return $localize`:@@products.detail.body.integrations.zero.noDirectory:We have not found an integrations page published by ${vendor}:VENDOR:.`;
  }
}
