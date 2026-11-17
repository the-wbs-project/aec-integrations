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
import type { LinkRef, ProductPairSubject } from '@aeci/shared';

import type { ExternalLinkContext } from '../analytics/analytics';
import { ExternalLinkTracker } from '../analytics/external-link-tracker';
import { ReviewStars } from '../reviews/review-stars';
import { BAND_WRAP_CLASS } from '../shared/band-wrap';
import { AecCard } from '../shared/card/card';
import { Chip } from '../shared/chip/chip';
import { correctionLabel } from '../shared/field-caption/correction-labels';
import {
  correctionsInSlots,
  countUnderReview,
  isUnderReview,
} from '../shared/field-caption/field-caption-facts';
import { UnderReviewMarker } from '../shared/field-caption/under-review';
import { AecIcon } from '../shared/icon/icon';
import type { AecIconName } from '../shared/icon/icon-registry';
import { LogoOrInitial, logoAlt } from '../shared/logo-or-initial/logo-or-initial';
import { NewTabIcon } from '../shared/new-tab-icon/new-tab-icon';
import type {
  ProvenanceCorrection,
  ProvenanceGroup,
} from '../shared/listing-provenance/listing-provenance';
import { UnclaimedNote } from '../shared/unclaimed-note/unclaimed-note';

import { integrationsOnRecordCount, withoutTrailingFullStop } from './integrations-on-record';

/** The shared focus ring on a light ground, 3px at 3px. */
const FOCUS_RING =
  'focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

/** A 20px mark inside a chip: the 32px logo-or-initial drawn in a 20px box. */
const CHIP_MARK = '[&>*]:size-5 [&>span]:text-t-12';

type Side = 'context' | 'other';
type FacetKey = 'audiences' | 'phases' | 'trades';

/** One facet, in mock-up 5's order: Audiences, Phases, Trades. */
const FACETS: readonly {
  key: FacetKey;
  field: string;
  icon: AecIconName;
  route: string;
}[] = [
  { key: 'audiences', field: 'audience_slugs', icon: 'users', route: '/audiences' },
  { key: 'phases', field: 'phase_slugs', icon: 'gantt', route: '/phases' },
  { key: 'trades', field: 'trade_slugs', icon: 'hard-hat', route: '/trades' },
];

/** One rating cell: the average at one decimal, or `null` under the §5.5 gate. */
function visibleRating(average: number | null, reviews: number): string | null {
  return reviews >= RATING_VISIBILITY_MIN_REVIEWS && average !== null ? average.toFixed(1) : null;
}

/** A link as the mock-up prints it under its label: host and path, no scheme. */
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

/** One meter's fill, as a share of the larger of the two sides. */
function share(value: number, a: number, b: number): number {
  const max = Math.max(a, b);
  return max > 0 ? Math.round((value / max) * 100) : 0;
}

/**
 * AECI-1827, restyled to mock-up 5 by AECI-1835: the body of the empty pair page, the pair
 * with no integration and no connector-evidenced pair on record (`STAGE_1_5_SPEC.md`
 * §11.4, `PLAN.md` §5.1). The hero above it carries the pill, the statement, the caveat,
 * the correction entry and the diagram (`ProductsPairPage`, `PairEmptyStage`).
 *
 * Two white bands, each the mock-up's small label over its large heading:
 *
 *  - **"The two products, side by side" / "What we have on record for each".** The
 *    ledger (integrations on record, reviews, and the Product quality and Onboarding
 *    experience scores),
 *    each side its own value and meter, never blended. The integrations figure is the
 *    product's own facts card figure (`integrationsOnRecordCount`), "None on record yet"
 *    at zero. With no reviews on either side the three review rows are absent. Under five
 *    reviews a side reads "Not yet rated". Beside it, "Who each product is for": each
 *    facet's terms, one chip each, a term both products carry once as "Both". Terms keep
 *    the product page's order.
 *  - **"Look it up yourself" / "Each vendor's own pages".** One card per product: its API
 *    documentation and its integrations directory as new-tab links, and its own page on
 *    AEC Integrations. A link hidden for checking reads "Under review" in its slot, and a
 *    link AECi removed is gone, as on the product page. The head says "Published by
 *    {vendor}" only while every link shown is the vendor's own value, and a corrected
 *    directory link keeps the neutral "Integrations page" label.
 *
 * No caption or correction renders here (AECI-1666, `STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §4.5.8). They are in the page's "About this listing" panel, which `ProductsPairPage`
 * builds with {@link emptyPairProvenance} and projects at the end of the last band.
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
    LogoOrInitial,
    NewTabIcon,
    ReviewStars,
    RouterLink,
    UnclaimedNote,
    UnderReviewMarker,
  ],
  host: { class: 'block' },
  template: `
    @let ctx = context();
    @let oth = other();
    <section
      aria-labelledby="pair-side-by-side-title"
      class="bg-(--surface-base) text-(--text-primary)"
      data-testid="pair-empty-side-by-side"
    >
      <div [class]="wrap">
        <div class="mb-6 md:mb-12">
          <p class="aec-overline mb-3 text-(--text-secondary)" i18n="@@pair.empty.sideBySide.title">
            The two products, side by side
          </p>
          <h2 id="pair-side-by-side-title" class="m-0">
            <span
              class="block font-display text-t-36 leading-[1.1] tracking-[-0.02em]"
              i18n="@@pair.empty.sideBySide.heading"
              >What we have on record for each</span
            >
          </h2>
        </div>

        <div [class]="sbsGrid()">
          <div aecCard class="min-w-0 px-4 py-6 md:p-8">
            <div
              role="table"
              aria-labelledby="pair-side-by-side-title"
              data-testid="pair-empty-facts"
            >
              <div role="rowgroup">
                <div [class]="ledgerGrid" class="mb-4" role="row">
                  <div
                    role="columnheader"
                    class="aec-overline hidden text-center text-(--text-secondary) md:col-start-2 md:row-start-1 md:block"
                    i18n="@@pair.empty.facts.onRecord"
                  >
                    On record
                  </div>
                  @for (s of sides(); track s.key) {
                    <div
                      role="columnheader"
                      class="row-start-1 flex min-w-0 items-center gap-3"
                      [class]="
                        s.key === 'context'
                          ? 'col-start-1'
                          : 'col-start-2 flex-row-reverse text-end md:col-start-3'
                      "
                    >
                      <aec-logo-or-initial
                        class="max-md:hidden"
                        [name]="s.product.name"
                        [src]="s.product.logo_url"
                        [alt]="logoAlt(s.product.name)"
                        [claimStatus]="s.product.claim_status"
                        size="sm"
                      />
                      <span class="flex min-w-0 flex-col">
                        <a
                          [routerLink]="['/products', s.product.slug]"
                          class="font-display text-t-20 leading-[1.1] font-semibold break-words text-(--text-primary) no-underline hover:text-(--accent-primary) hover:underline {{
                            focusRing
                          }}"
                          >{{ s.product.name }}</a
                        >
                        @if (s.product.vendor; as v) {
                          <span
                            class="text-t-13 text-(--text-secondary)"
                            i18n="@@pair.empty.facts.by"
                            >by {{ v.name }}</span
                          >
                        }
                      </span>
                    </div>
                  }
                </div>
              </div>
              <div role="rowgroup">
                <!-- Integrations on record: the product's own facts card figure. A zero is
                     words, never a bare 0 (ruling 96, option B). -->
                <div
                  [class]="ledgerRowShaded"
                  role="row"
                  data-testid="pair-empty-facts-integrations"
                >
                  <div role="rowheader" [class]="rowHeader">
                    <aec-icon
                      name="link"
                      class="hidden text-(--accent-primary) md:inline-flex"
                      decorative
                      [size]="4"
                    />
                    <span
                      class="block text-t-14 font-semibold"
                      i18n="@@pair.empty.facts.integrations"
                      >Integrations on record</span
                    >
                  </div>
                  @for (s of sides(); track s.key) {
                    <div role="cell" [class]="cellClass(s.key)">
                      @if (s.onRecord > 0) {
                        <span [class]="numClass(s.key)">{{ count(s.onRecord) }}</span>
                        <span [class]="meterClass" aria-hidden="true"
                          ><span
                            [class]="fillClass(s.key)"
                            [style.width.%]="meter(s.onRecord, ctxRecord(), othRecord())"
                          ></span
                        ></span>
                      } @else {
                        <span
                          class="text-t-14 text-(--text-secondary)"
                          i18n="@@pair.empty.facts.integrationsNone"
                          >None on record yet</span
                        >
                      }
                    </div>
                  }
                </div>
                @if (hasReviews()) {
                  <div [class]="ledgerRow" role="row" data-testid="pair-empty-facts-reviews">
                    <div role="rowheader" [class]="rowHeader">
                      <aec-icon
                        name="users"
                        class="hidden text-(--accent-primary) md:inline-flex"
                        decorative
                        [size]="4"
                      />
                      <span class="block text-t-14 font-semibold" i18n="@@pair.empty.facts.reviews"
                        >Reviews</span
                      >
                    </div>
                    @for (s of sides(); track s.key) {
                      <div role="cell" [class]="cellClass(s.key)">
                        @if (s.product.review_count > 0) {
                          <span [class]="numClass(s.key)">{{ count(s.product.review_count) }}</span>
                          <span [class]="meterClass" aria-hidden="true"
                            ><span
                              [class]="fillClass(s.key)"
                              [style.width.%]="
                                meter(s.product.review_count, ctx.review_count, oth.review_count)
                              "
                            ></span
                          ></span>
                        } @else {
                          <span
                            class="text-t-14 text-(--text-secondary)"
                            i18n="@@products.detail.hero.reviewCount.none"
                            >No reviews yet</span
                          >
                        }
                      </div>
                    }
                  </div>
                  @for (r of ratingRows; track r.key) {
                    <div
                      [class]="r.key === 'overall' ? ledgerRowShaded : ledgerRow"
                      role="row"
                      [attr.data-testid]="'pair-empty-facts-' + r.key"
                    >
                      <div role="rowheader" [class]="rowHeader">
                        <aec-icon
                          name="star"
                          class="hidden text-(--accent-primary) md:inline-flex"
                          decorative
                          [size]="4"
                        />
                        @if (r.key === 'overall') {
                          <!-- The product page's names for the two scores (Same-Behavior
                               Rule): its hero's message ids, so one site names them one way. -->
                          <span
                            class="block text-t-14 font-semibold"
                            i18n="@@products.detail.hero.rating.overall"
                            >Product quality</span
                          >
                        } @else {
                          <span
                            class="block text-t-14 font-semibold"
                            i18n="@@products.detail.hero.rating.onboarding"
                            >Onboarding experience</span
                          >
                        }
                      </div>
                      @for (s of sides(); track s.key) {
                        @let value = r.key === 'overall' ? s.overall : s.onboarding;
                        <div role="cell" [class]="cellClass(s.key)">
                          @if (value) {
                            <span [class]="numClass(s.key)"
                              >{{ value
                              }}<span class="ms-1 text-t-16 font-normal text-(--text-secondary)"
                                >/5</span
                              ></span
                            >
                            <aec-review-stars
                              [rating]="
                                r.key === 'overall'
                                  ? s.product.rating_overall_avg!
                                  : s.product.rating_onboarding_avg!
                              "
                              [kind]="r.key"
                            />
                          } @else {
                            <aec-chip tone="quiet" i18n="@@products.detail.hero.notRated"
                              >Not yet rated</aec-chip
                            >
                          }
                        </div>
                      }
                    </div>
                  }
                }
              </div>
            </div>
          </div>

          @if (showWho()) {
            <section
              aecCard
              aria-labelledby="pair-who-title"
              class="min-w-0 space-y-6 px-4 py-6 md:p-8"
              data-testid="pair-empty-who"
            >
              <div class="space-y-2">
                <h3 id="pair-who-title" class="m-0">
                  <span class="font-display text-t-24 font-semibold" i18n="@@pair.empty.who.title"
                    >Who each product is for</span
                  >
                </h3>
                @if (hasBoth()) {
                  <p
                    class="m-0 flex flex-wrap items-center gap-2 text-t-14 text-(--text-secondary)"
                  >
                    <aec-chip tone="wash" aria-hidden="true">
                      <span class="inline-flex">
                        <aec-logo-or-initial
                          [class]="chipMark"
                          [name]="ctx.name"
                          [src]="ctx.logo_url"
                          [claimStatus]="ctx.claim_status"
                          size="sm"
                        />
                        <aec-logo-or-initial
                          [class]="chipMark"
                          class="-ms-2"
                          [name]="oth.name"
                          [src]="oth.logo_url"
                          [claimStatus]="oth.claim_status"
                          size="sm"
                        />
                      </span>
                      <aec-chip density="dense" i18n="@@pair.empty.who.both">Both</aec-chip>
                    </aec-chip>
                    <span i18n="@@pair.empty.who.legend">appears on both products</span>
                  </p>
                }
              </div>
              @for (f of facets(); track f.key) {
                <div class="min-w-0 space-y-3" [attr.data-testid]="'pair-empty-who-' + f.key">
                  <h4 class="aec-overline m-0 flex items-center gap-2 text-(--text-secondary)">
                    <aec-icon [name]="f.icon" decorative [size]="4" />
                    @switch (f.key) {
                      @case ('audiences') {
                        <span i18n="@@products.detail.metadata.audiences">Audiences</span>
                      }
                      @case ('phases') {
                        <span i18n="@@pair.empty.who.phases">Phases</span>
                      }
                      @case ('trades') {
                        <span i18n="@@products.detail.metadata.trades">Trades</span>
                      }
                    }
                  </h4>
                  @if (f.chips.length > 0) {
                    <div class="flex flex-wrap gap-2">
                      @for (c of f.chips; track c.side + c.term.slug) {
                        <aec-chip
                          [tone]="c.side === 'both' ? 'wash' : null"
                          [link]="[f.route, c.term.slug]"
                        >
                          <span class="inline-flex">
                            @if (c.side !== 'other') {
                              <aec-logo-or-initial
                                [class]="chipMark"
                                [name]="ctx.name"
                                [src]="ctx.logo_url"
                                [claimStatus]="ctx.claim_status"
                                size="sm"
                              />
                            }
                            @if (c.side !== 'context') {
                              <aec-logo-or-initial
                                [class]="chipMark"
                                [class.-ms-2]="c.side === 'both'"
                                [name]="oth.name"
                                [src]="oth.logo_url"
                                [claimStatus]="oth.claim_status"
                                size="sm"
                              />
                            }
                          </span>
                          <span>{{ c.term.name }}</span
                          >&ngsp;
                          @if (c.side === 'both') {
                            <aec-chip density="dense" i18n="@@pair.empty.who.both">Both</aec-chip>
                          } @else {
                            <span class="sr-only" i18n="@@pair.empty.who.only"
                              >({{ c.side === 'context' ? ctx.name : oth.name }} only)</span
                            >
                          }
                        </aec-chip>
                      }
                    </div>
                  }
                </div>
              }
              @for (s of sides(); track s.key) {
                @if (!s.hasWho) {
                  <p
                    class="m-0 text-t-14 text-(--text-secondary)"
                    [attr.data-testid]="'pair-empty-who-none-' + s.key"
                  >
                    <span class="font-semibold text-(--text-primary)">{{ s.product.name }}</span
                    >&ngsp;<span i18n="@@pair.empty.who.none">Nothing listed yet.</span>
                  </p>
                }
              }
            </section>
          }
        </div>
      </div>
    </section>

    <section
      aria-labelledby="pair-look-it-up-title"
      class="bg-(--surface-base) text-(--text-primary)"
      data-testid="pair-empty-look-it-up"
    >
      <div [class]="wrap">
        <div class="mb-6 max-w-prose md:mb-12">
          <p class="aec-overline mb-3 text-(--text-secondary)" i18n="@@pair.empty.lookItUp.title">
            Look it up yourself
          </p>
          <h2 id="pair-look-it-up-title" class="m-0">
            <span
              class="block font-display text-t-36 leading-[1.1] tracking-[-0.02em]"
              i18n="@@pair.empty.lookItUp.heading"
              >Each vendor's own pages</span
            >
          </h2>
          <p
            class="mt-4 text-t-16 leading-relaxed text-(--text-secondary)"
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
              class="min-w-0 overflow-hidden"
              [attr.data-testid]="'pair-empty-look-' + s.key"
            >
              <!-- Mock-up 5's head: a coloured band for a claimed product, in AECi's own
                   Forest (we hold no vendor brand colours), and the neutral head for an
                   unclaimed one, which gets no colour (ruling R7). -->
              <div
                [class]="p.claim_status === 'claimed' ? headClaimed : headNeutral"
                [attr.data-head]="p.claim_status === 'claimed' ? 'brand' : 'neutral'"
              >
                <span
                  [class]="p.claim_status === 'claimed' ? sheenClaimed : sheenNeutral"
                  aria-hidden="true"
                ></span>
                <span class="relative size-13.5 shrink-0 [&>*]:size-full [&_span]:text-t-24">
                  <aec-logo-or-initial
                    [name]="p.name"
                    [src]="p.logo_url"
                    [alt]="logoAlt(p.name)"
                    [claimStatus]="p.claim_status"
                    size="hero"
                  />
                </span>
                <div class="relative min-w-0">
                  <h3 [id]="'pair-look-' + s.key" class="m-0">
                    <span class="font-display text-t-24 leading-[1.1] font-semibold break-words">{{
                      p.name
                    }}</span>
                  </h3>
                  <!-- "Published by" only while every link the card shows is the vendor's own
                       value: a link AECi corrected is a value AECi set, and a card with no
                       link has nothing the vendor published. Otherwise the plain byline. -->
                  @if (p.vendor; as v) {
                    @if (s.publishedBy) {
                      <p
                        [class]="p.claim_status === 'claimed' ? bylineClaimed : bylineNeutral"
                        data-testid="pair-look-published-by"
                        i18n="@@pair.empty.look.publishedBy"
                      >
                        Published by {{ v.name }}
                      </p>
                    } @else {
                      <p
                        [class]="p.claim_status === 'claimed' ? bylineClaimed : bylineNeutral"
                        data-testid="pair-look-by"
                        i18n="@@pair.empty.facts.by"
                      >
                        by {{ v.name }}
                      </p>
                    }
                  }
                  @if (p.claim_status === 'unclaimed') {
                    <aec-unclaimed-note class="mt-1" />
                  }
                </div>
              </div>

              <ul class="m-0 grid list-none gap-1 p-3">
                @if (p.api_docs_url; as url) {
                  <li>
                    <a
                      [href]="url"
                      target="_blank"
                      rel="noopener nofollow"
                      aecTrackExternalLink="pair_detail"
                      [aecLinkContext]="linkContext(p, 'docs')"
                      [class]="linkRowClass"
                      [attr.data-testid]="'pair-look-api-' + s.key"
                    >
                      <span [class]="tileClass"
                        ><aec-icon name="code" decorative [size]="5"
                      /></span>
                      <span class="min-w-0 flex-1">
                        <span
                          class="block text-t-16 font-semibold"
                          i18n="@@products.detail.metadata.apiDocs"
                          >API documentation</span
                        >
                        <span class="block truncate text-t-14 text-(--text-secondary)">{{
                          display(url)
                        }}</span>
                      </span>
                      <span class="text-(--text-secondary)"><aec-new-tab-icon /></span>
                    </a>
                  </li>
                } @else if (review(p, 'api_docs_url')) {
                  <li class="px-4 py-2">
                    <aec-under-review
                      [attr.data-testid]="'pair-look-api-under-review-' + s.key"
                      [label]="correctionLabel('api_docs_url')"
                    />
                  </li>
                }

                @if (p.tool_integrations_url; as url) {
                  <li>
                    <a
                      [href]="url"
                      target="_blank"
                      rel="noopener nofollow"
                      aecTrackExternalLink="pair_detail"
                      [aecLinkContext]="linkContext(p, 'listing')"
                      [class]="linkRowClass"
                      [attr.data-testid]="'pair-look-integrations-' + s.key"
                    >
                      <span [class]="tileClass"
                        ><aec-icon name="grid-plus" decorative [size]="5"
                      /></span>
                      <span class="min-w-0 flex-1">
                        <!-- The vendor's name only on the vendor's own value. A link AECi
                             corrected keeps the product page's neutral label. -->
                        @if (p.vendor && !corrected(p, 'tool_integrations_url')) {
                          <span
                            class="block text-t-16 font-semibold"
                            i18n="@@pair.empty.look.directory"
                            >{{ p.vendor.name }} integrations directory</span
                          >
                        } @else {
                          <span
                            class="block text-t-16 font-semibold"
                            i18n="@@products.detail.metadata.integrationsPage"
                            >Integrations page</span
                          >
                        }
                        <span class="block truncate text-t-14 text-(--text-secondary)">{{
                          display(url)
                        }}</span>
                      </span>
                      <span class="text-(--text-secondary)"><aec-new-tab-icon /></span>
                    </a>
                  </li>
                } @else if (review(p, 'tool_integrations_url')) {
                  <li class="px-4 py-2">
                    <aec-under-review
                      [attr.data-testid]="'pair-look-integrations-under-review-' + s.key"
                      [label]="correctionLabel('tool_integrations_url')"
                    />
                  </li>
                } @else if (s.noDirectory; as line) {
                  <li
                    class="mx-1 flex gap-2 rounded-panel bg-(--surface-sunken) p-4 text-t-14 leading-normal text-(--text-secondary)"
                    [attr.data-testid]="'pair-look-no-directory-' + s.key"
                  >
                    <aec-icon name="info" class="mt-0.5 shrink-0" decorative [size]="4" />
                    <span>{{ line }}</span>
                  </li>
                }

                @if (s.onRecord > 0) {
                  <li>
                    <a
                      [routerLink]="['/products', p.slug]"
                      fragment="integrations"
                      [class]="linkRowClass"
                      [attr.data-testid]="'pair-look-all-' + s.key"
                    >
                      <span [class]="tileClass"
                        ><aec-icon name="list" decorative [size]="5"
                      /></span>
                      <span class="min-w-0 flex-1">
                        <span class="block text-t-16 font-semibold">{{
                          allLabel(s.onRecord, p.name)
                        }}</span>
                        <span
                          class="block text-t-14 text-(--text-secondary)"
                          i18n="@@pair.empty.look.onAeci"
                          >On AEC Integrations</span
                        >
                      </span>
                      <span class="text-(--text-secondary)"
                        ><aec-icon
                          name="arrow-right"
                          class="rtl:-scale-x-100"
                          decorative
                          [size]="4"
                      /></span>
                    </a>
                  </li>
                }
              </ul>
            </section>
          }
        </div>

        <!-- Legal review item 10: an API is not an integration. The words are the ones
             STAGE_1_5_SPEC.md section 11.4 fixed, shared with the product page. -->
        <p
          class="mx-auto mt-6 flex max-w-prose items-start gap-3 text-t-16 text-(--text-secondary) md:justify-center md:text-center"
          data-testid="pair-look-api-note"
        >
          <aec-icon
            name="info"
            class="mt-1 shrink-0 text-(--accent-primary)"
            decorative
            [size]="4"
          />
          <span i18n="@@products.detail.body.integrations.zero.apiNote"
            >An API is not an integration. We list an integration only when we can show that one
            exists.</span
          >
        </p>
        <!-- AECI-1666: the page's "About this listing" panel, which the pair page projects
             here so it ends the page body's last band (STAGE_2_VENDOR_PORTAL_SPEC.md 4.5.8). -->
        <ng-content />
      </div>
    </section>
  `,
})
export class PairEmptySections {
  /** The URL's first product. */
  readonly context = input.required<ProductPairSubject>();
  /** The URL's second product. */
  readonly other = input.required<ProductPairSubject>();

  private readonly locale = inject(LOCALE_ID);

  protected readonly logoAlt = logoAlt;
  protected readonly correctionLabel = correctionLabel;
  protected readonly focusRing = FOCUS_RING;
  protected readonly chipMark = CHIP_MARK;
  protected readonly display = displayUrl;

  /** The vendor card head (mock-up 5 `.lc-head`): Forest for a claimed product, neutral
   *  for an unclaimed one, with the mock-up's sheen circle. */
  protected readonly headClaimed =
    'relative flex items-center gap-4 overflow-hidden bg-(--accent-primary) p-6 text-(--text-on-brand) md:px-8';
  protected readonly headNeutral =
    'relative flex items-center gap-4 overflow-hidden bg-(--surface-sunken) p-6 md:px-8';
  protected readonly sheenClaimed =
    'pointer-events-none absolute -end-15 -top-20 size-60 rounded-full bg-(--surface-on-brand-wash)';
  protected readonly sheenNeutral =
    'pointer-events-none absolute -end-15 -top-20 size-60 rounded-full bg-(--surface-sunken-hover) opacity-50';
  protected readonly bylineClaimed = 'm-0 text-t-14 text-(--text-on-brand-secondary)';
  protected readonly bylineNeutral = 'm-0 text-t-14 text-(--text-secondary)';

  /** Mock-up 5's band: 96px above and below from md, 64px below it. */
  protected readonly wrap = `${BAND_WRAP_CLASS} py-16 md:py-24`;

  /** The ledger's three columns from md; below it the label spans the row above two. */
  protected readonly ledgerGrid =
    'grid grid-cols-2 items-center gap-x-4 gap-y-2 md:grid-cols-[minmax(0,1fr)_170px_minmax(0,1fr)]';
  protected readonly ledgerRow = `${this.ledgerGrid} px-2 py-4 md:px-4`;
  /** Every other row on the mock-up's sunken fill. */
  protected readonly ledgerRowShaded = `${this.ledgerRow} rounded-panel bg-(--surface-sunken)`;

  /** The ledger and "Who each product is for" side by side from lg, at mock-up 5's split. */
  protected readonly sbsGrid = computed(() =>
    this.showWho()
      ? 'grid items-stretch gap-6 lg:grid-cols-[minmax(0,1.42fr)_minmax(0,1fr)]'
      : 'grid items-stretch gap-6',
  );
  protected readonly rowHeader =
    'col-span-2 row-start-1 flex flex-col items-center gap-1 text-center md:col-span-1 md:col-start-2';
  protected readonly meterClass =
    'relative h-2.5 w-full overflow-hidden rounded-pill bg-(--border-default) md:h-3.5 md:flex-1';

  protected readonly ratingRows = [{ key: 'overall' as const }, { key: 'onboarding' as const }];

  protected readonly linkRowClass =
    'grid grid-cols-[44px_minmax(0,1fr)_auto] items-center gap-4 rounded-panel p-4 text-(--text-primary) no-underline transition-colors duration-base ease-standard hover:bg-(--surface-sunken) ' +
    FOCUS_RING;

  protected readonly tileClass =
    'grid size-11 place-items-center rounded-control bg-(--accent-primary-soft) text-(--accent-primary)';

  /** Each product's facts card figure (ruling 96). */
  protected readonly ctxRecord = computed(() => onRecord(this.context()));
  protected readonly othRecord = computed(() => onRecord(this.other()));

  /** The two sides in URL order, context first, with what each cell shows. */
  protected readonly sides = computed(() =>
    (
      [
        ['context', this.context()],
        ['other', this.other()],
      ] as const
    ).map(([key, product]) => {
      return {
        key,
        product,
        onRecord: onRecord(product),
        overall: visibleRating(product.rating_overall_avg, product.review_count),
        onboarding: visibleRating(product.rating_onboarding_avg, product.review_count),
        hasWho: hasWho(product),
        noDirectory: this.noDirectoryLine(product),
        publishedBy: publishedByVendor(product),
      };
    }),
  );

  /** §11.4: with no reviews on either side the review rows go. */
  protected readonly hasReviews = computed(
    () => this.context().review_count > 0 || this.other().review_count > 0,
  );

  /** Whether "Who each product is for" has anything to show on either side. */
  protected readonly showWho = computed(() => hasWho(this.context()) || hasWho(this.other()));

  /**
   * Each facet with its chips: the context product's terms in its own order, a term the
   * other product also carries marked "Both", then the other product's remaining terms in
   * its order. A facet with no term on either side is absent.
   */
  protected readonly facets = computed(() => {
    const a = this.context();
    const b = this.other();
    return FACETS.flatMap((f) => {
      const aTerms: readonly LinkRef[] = a[f.key];
      const bTerms: readonly LinkRef[] = b[f.key];
      const bSlugs = new Set(bTerms.map((t) => t.slug));
      const aSlugs = new Set(aTerms.map((t) => t.slug));
      const chips = [
        ...aTerms.map((term) => ({
          term,
          side: (bSlugs.has(term.slug) ? 'both' : 'context') as 'both' | Side,
        })),
        ...bTerms
          .filter((t) => !aSlugs.has(t.slug))
          .map((term) => ({ term, side: 'other' as const })),
      ];
      return chips.length > 0 ? [{ ...f, chips }] : [];
    });
  });

  /** Whether any facet has a term both products carry: the legend explains "Both". */
  protected readonly hasBoth = computed(() =>
    this.facets().some((f) => f.chips.some((c) => c.side === 'both')),
  );

  /** The printed count, as the product page's facts card prints it. */
  protected count(value: number): string {
    return formatNumber(value, this.locale, '1.0-0');
  }

  protected meter(value: number, a: number, b: number): number {
    return share(value, a, b);
  }

  /** Side A reads toward the middle (meter, then number); side B away from it. */
  protected cellClass(side: Side): string {
    return side === 'context'
      ? 'col-start-1 row-start-2 flex min-w-0 flex-col items-start gap-2 md:row-start-1 md:flex-row-reverse md:items-center md:gap-4'
      : 'col-start-2 row-start-2 flex min-w-0 flex-col items-end gap-2 md:col-start-3 md:row-start-1 md:flex-row md:items-center md:gap-4';
  }

  protected numClass(side: Side): string {
    return `min-w-[2.1em] text-t-20 leading-none font-semibold tabular-nums ${
      side === 'context' ? 'md:text-end' : ''
    }`;
  }

  protected fillClass(side: Side): string {
    return `absolute inset-y-0 rounded-pill bg-(--accent-primary) ${
      side === 'context' ? 'start-0 md:start-auto md:end-0' : 'end-0 md:end-auto md:start-0'
    }`;
  }

  /** "All 14 Bluebeam Revu integrations", or the singular for one. */
  protected allLabel(count: number, product: string): string {
    const n = formatNumber(count, this.locale, '1.0-0');
    return count === 1
      ? $localize`:@@pair.empty.look.allOne:${n}:COUNT: ${product}:PRODUCT: integration`
      : $localize`:@@pair.empty.look.all:All ${n}:COUNT: ${product}:PRODUCT: integrations`;
  }

  /** Whether AECi corrected the value `field` shows. The panel lists it, the slot does not. */
  protected corrected(p: ProductPairSubject, field: string): boolean {
    return correctionsInSlots(p.captions?.corrections, { [field]: true }).length > 0;
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
    if (correctionsInSlots(p.captions?.corrections, { tool_integrations_url: false }).length > 0) {
      return null;
    }
    // As on the product page: "Acme Inc." ends the sentence once, never "Inc..".
    const vendor = withoutTrailingFullStop(p.vendor.name);
    return $localize`:@@products.detail.body.integrations.zero.noDirectory:We have not found an integrations page published by ${vendor}:VENDOR:.`;
  }
}

/** The product page facts card's figure (ruling 96): the stored count unless it is 0. */
function onRecord(p: ProductPairSubject): number {
  return integrationsOnRecordCount(p.integration_count, p.listed_integration_count ?? 0);
}

/**
 * Whether the vendor card may say "Published by {vendor}": it shows at least one link, and
 * every link it shows is the vendor's own value. A link AECi corrected is a value AECi set
 * (the panel lists it as corrected), so a card holding one says only "by {vendor}".
 */
function publishedByVendor(p: ProductPairSubject): boolean {
  const corrections = p.captions?.corrections;
  const shown = (['api_docs_url', 'tool_integrations_url'] as const).filter((f) => !!p[f]);
  return (
    shown.length > 0 &&
    correctionsInSlots(corrections, Object.fromEntries(shown.map((f) => [f, true]))).length === 0
  );
}

/**
 * Whether a product has anything for "Who each product is for": a term in one of the three
 * groups. The product page's test (`hasWhoItIsFor`) over the pair subject. A group a removal
 * emptied disappears (AECI-1666, ruling 1).
 */
function hasWho(p: ProductPairSubject): boolean {
  return p.audiences.length > 0 || p.trades.length > 0 || p.phases.length > 0;
}

/** The look-it-up card's two links, the fields it marks "Under review" when hidden. */
const LOOK_UP_MARKED_FIELDS = ['api_docs_url', 'tool_integrations_url'] as const;

/**
 * What "About this listing" holds on an empty pair page (AECI-1666,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.8). Every listing shows the panel, so the empty pair
 * does too, though it has no integration row. It lists only what this page renders for
 * each product: the Managed group's caption while that product shows a term or a link,
 * and AECi's corrections on the three term groups and the two links, by the product
 * page's slot rule. Each line names its product, as a pair card's line names its
 * mechanism. The under-review count is the look-it-up cards' own markers.
 *
 * `claimed`: the pair is claimed when either product is, as on a pair with integrations.
 */
export function emptyPairProvenance(
  context: ProductPairSubject,
  other: ProductPairSubject,
): {
  claimed: boolean;
  groups: ProvenanceGroup[];
  corrections: ProvenanceCorrection[];
  underReviewCount: number;
} {
  const groups: ProvenanceGroup[] = [];
  const corrections: ProvenanceCorrection[] = [];
  let underReviewCount = 0;
  for (const p of [context, other]) {
    const named = (field: string) =>
      $localize`:@@pair.provenance.mechanismField:${p.name}:MECHANISM:, ${field}:FIELD:`;
    const managed = p.captions?.managed;
    const shows = hasWho(p) || !!p.tool_integrations_url || !!p.api_docs_url;
    if (managed && shows) {
      groups.push({
        label: named(
          $localize`:@@products.detail.provenance.group.managed:Audiences, trades, phases and resources`,
        ),
        caption: managed,
      });
    }
    for (const correction of correctionsInSlots(p.captions?.corrections, {
      audience_slugs: p.audiences.length > 0,
      trade_slugs: p.trades.length > 0,
      phase_slugs: p.phases.length > 0,
      api_docs_url: !!p.api_docs_url,
      tool_integrations_url: !!p.tool_integrations_url,
    })) {
      corrections.push({ correction, label: named(correctionLabel(correction.field)) });
    }
    underReviewCount += countUnderReview(p.under_review, LOOK_UP_MARKED_FIELDS);
  }
  return {
    claimed: context.claim_status !== 'unclaimed' || other.claim_status !== 'unclaimed',
    groups,
    corrections,
    underReviewCount,
  };
}
