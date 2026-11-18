import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AecCard } from '../shared/card/card';
import { correctionLabel } from '../shared/field-caption/correction-labels';
import { UnderReviewMarker } from '../shared/field-caption/under-review';
import { AecIcon } from '../shared/icon/icon';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';
import {
  contextDirectionLabel,
  dataObjectCountLabel,
  mechanismDisplay,
  mechanismKindLabel,
} from '../search/mechanism-labels';

import { AgreementBadge } from './agreement-badge';
import {
  MATCH_CARD_BLOCK_CLASS,
  MATCH_CARD_BODY_CLASS,
  MATCH_CARD_FOOT_CLASS,
  MATCH_CARD_GO_CLASS,
  MATCH_CARD_NAME_TEXT_CLASS,
  MATCH_CHIP_CLASS,
  MATCH_CHIP_ICON_CLASS,
  MATCH_CHIP_ROW_CLASS,
  matchChipIcon,
} from './match-card-recipe';
import {
  routeIntegrationLane,
  rowUnderReviewFields,
  type IntegrationLaneRow,
} from './connector-lane-grouping';

/**
 * AECI-1782: one integration as a card, the default view of the product page's
 * Integrations section (PLAN.md §5.2, clash 24 "blend"). AECI-1720 restored mock-up
 * 6's card body (`.card`): a 48px mark, the partner's vendor under its name, a
 * "What moves" block (the direction, then the types of data), a "How it connects"
 * block (the mechanism), and the pair-page link at the foot.
 *
 * The card says what the table row says, and a little more the row has no room
 * for. Content parity with `ProductIntegrationRow` is the rule: the partner and its
 * link, the direction with its "Direction:" prefix, the mechanism kinds and name,
 * the "Under review" markers, and the
 * pair-page link with the same words. What the card adds is data the API
 * already sends (AECI-1781, AECI-1720): the partner's vendor and categories, the
 * names of the data objects the integration moves, and the agreement state.
 *
 * **The agreement state is a label only** (ruling R1, PLAN.md §7.7). It renders
 * through the shared `aec-agreement-badge`, unattributed, so a `single_source` row
 * reads "Confirmed by one company" (ruling on AECI-1781, 2026-11-14). Nothing sorts,
 * filters, counts or features by it.
 *
 * **Two links, no nesting.** The partner name links to the partner's own page, as
 * on the row. The pair-page link at the foot reads "View the {partner} integration",
 * the row chevron's accessible name, now visible, and is stretched over the whole
 * card (`after:absolute after:inset-0`), so a click anywhere on the card opens the
 * pair page. Every other interactive element sits above the stretched layer with
 * `relative z-10`, so it keeps its own destination.
 *
 * Attribute selector on `<li>`: the lane renders its cards as one named list, the
 * card view's version of §13.3's one table per lane.
 *
 * **The integration card recipe** (`match-card-recipe.ts`, DESIGN.md "The integration
 * card"), shared with the empty pair page's closest-match card since AECI-1720: 24px
 * padding on a phone and 32px from md, 20px between blocks, the name at the Title
 * role, the recipe's 31px chips with a glyph where the icon map has one, and the 34px
 * round button with the chevron at the foot.
 */
@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'li[aec-product-integration-card]',
  imports: [
    AecCard,
    AecIcon,
    AgreementBadge,
    LogoOrInitial,
    NgTemplateOutlet,
    RouterLink,
    UnderReviewMarker,
  ],
  host: { class: 'group/card block min-w-0' },
  template: `
    <article
      aecCard
      interactive
      [nested]="nested()"
      [class]="cardClass"
      data-testid="integration-card"
    >
      <!-- Mock-up 6, .card .top: a 48px mark beside the partner name, with the
           partner's vendor under it. -->
      <div class="flex items-center gap-4">
        <aec-logo-or-initial
          class="shrink-0"
          [claimStatus]="'server-filtered'"
          [src]="row().other.logo_url"
          [name]="row().other.name"
          size="md"
        />
        <!-- The heading level follows the section: h4 under a one-lane page's list
             heading or a lane card's h3, h5 under a category group's h4. The size sits
             on the link, not on the heading, because the unlayered heading rules beat
             a text-* utility on the heading itself (the Unlayered-Heading Rule). -->
        <div class="min-w-0 flex-1">
          @switch (headingLevel()) {
            @case (3) {
              <h3 class="break-words">
                <ng-container [ngTemplateOutlet]="partnerLink" />
              </h3>
            }
            @case (5) {
              <h5 class="break-words">
                <ng-container [ngTemplateOutlet]="partnerLink" />
              </h5>
            }
            @default {
              <h4 class="break-words">
                <ng-container [ngTemplateOutlet]="partnerLink" />
              </h4>
            }
          }
          @if (vendorLine(); as line) {
            <p
              class="mt-0.5 break-words text-t-13 text-(--text-secondary)"
              data-testid="integration-card-vendor"
            >
              {{ line }}
            </p>
          }
        </div>
      </div>

      <!-- Each chip row carries a small visible label (approved 2026-11-16). The list
           takes the same words as its accessible name, so a screen reader hears it as
           the name of the chip group; the visible label is aria-hidden to say it once. -->
      @if (row().integration.partner_categories.length > 0) {
        <div [class]="blockClass">
          <span
            class="aec-overline block text-(--text-secondary)"
            aria-hidden="true"
            data-testid="integration-card-categories-label"
            >{{ categoriesLabel }}</span
          >
          <ul
            [class]="chipRowClass"
            [attr.aria-label]="categoriesLabel"
            data-testid="integration-card-categories"
          >
            @for (category of row().integration.partner_categories; track category.slug) {
              <li [class]="chipClass">
                <aec-icon name="tag" [class]="chipIconClass" decorative [size]="3.5" />
                {{ category.name }}
              </li>
            }
          </ul>
        </div>
      }

      <!-- Mock-up 6's "What moves": the direction, then the types of data. The data
           list keeps "Types of data" as its accessible name, the filter's words. -->
      <div [class]="blockClass" data-testid="integration-card-moves">
        <span
          class="aec-overline block text-(--text-secondary)"
          data-testid="integration-card-moves-label"
          i18n="@@products.detail.integrations.card.whatMoves"
          >What moves</span
        >
        <p class="flex flex-wrap items-center gap-x-1.5 text-t-14 font-semibold">
          <span class="sr-only" i18n="@@products.detail.integrations.direction.srLabel"
            >Direction:</span
          >
          @if (direction().token) {
            <span
              class="inline-block leading-none text-(--accent-primary) rtl:-scale-x-100"
              aria-hidden="true"
              >{{ direction().glyph }}</span
            >
            <span>{{ direction().label }}</span>
          } @else {
            <span
              class="font-normal text-(--text-secondary)"
              i18n="@@products.detail.integrations.direction.none"
              i18n-aria-label="@@products.detail.integrations.direction.none.aria"
              aria-label="Direction not listed"
              >–</span
            >
          }
        </p>

        @if (row().dataObjects.length > 0) {
          <ul
            [class]="chipRowClass"
            [attr.aria-label]="dataTypesLabel"
            data-testid="integration-card-data-objects"
          >
            @for (object of row().dataObjects; track object.slug) {
              <li [class]="chipClass">
                @if (icon(object.slug); as glyph) {
                  <aec-icon [name]="glyph" [class]="chipIconClass" decorative [size]="3.5" />
                }
                {{ object.name }}
              </li>
            }
          </ul>
        } @else if (dataObjectLabel(); as objects) {
          <!-- Slugs with no names on the wire: the row's count label, never nothing. -->
          <p>
            <span [class]="chipClass" data-testid="row-data-objects">{{ objects }}</span>
          </p>
        }
      </div>

      <!-- Mock-up 6's "How it connects": the mechanism kinds, then its name. -->
      <div [class]="blockClass" data-testid="integration-card-connects">
        <span
          class="aec-overline block text-(--text-secondary)"
          data-testid="integration-card-connects-label"
          i18n="@@products.detail.integrations.card.howItConnects"
          >How it connects</span
        >
        <div class="flex flex-col items-start gap-1 text-t-14 text-(--text-secondary)">
          @if (mechanism().labels.length > 0) {
            <span [class]="chipRowClass">
              @for (label of mechanism().labels; track label) {
                <span [class]="chipClass">{{ label }}</span>
              }
            </span>
          } @else if (!isViaLane()) {
            <span
              i18n="@@products.detail.integrations.mechanism.none"
              i18n-aria-label="@@products.detail.integrations.mechanism.none.aria"
              aria-label="Mechanism not listed"
              >–</span
            >
          }
          @if (mechanism().name; as name) {
            <span class="text-t-13" data-testid="integration-card-mechanism-name">{{ name }}</span>
          }
        </div>
      </div>

      @if (row().agreement; as agreement) {
        <div>
          <aec-agreement-badge [agreement]="agreement" />
        </div>
      }

      <!-- AECI-1666 ruling 2: no "Maintained by" or correction line on an integration.
           The pair page's "About this listing" panel carries them, and this page's panel
           says so. The "Under review" markers stay in the card. -->
      @if (rowUnderReview().length > 0) {
        <div class="relative z-10 flex flex-col gap-1">
          @for (entry of rowUnderReview(); track entry.field) {
            <aec-under-review [label]="entry.label" />
          }
        </div>
      }

      <!-- The pair-page link at the foot (mock-up 6, .card .go). Its words are the row
           chevron's accessible name, "View the {partner} integration", now visible, so
           the name and the label match (WCAG 2.5.3). Stretched over the card, so a click
           anywhere on it opens the pair page. The glyph is a chevron, never an arrow:
           an arrow on this page means data-flow direction (the Arrow Rule). -->
      <a [routerLink]="pairLink()" [class]="footClass" data-testid="integration-card-pair-link">
        <span class="min-w-0 break-words">{{ pairLabel() }}</span>
        <span [class]="goClass" aria-hidden="true" data-testid="integration-card-go">
          <aec-icon name="chevron-right" decorative [size]="4" [mirrorRtl]="true" />
        </span>
      </a>
    </article>

    <ng-template #partnerLink>
      <!-- relative z-10 lifts the partner link above the stretched pair link, so it
           keeps its own destination. py-0.5 with -my-0.5 keeps a 24px target. The
           link draws its own ring, and the article's has-[.aec-partner-link] rule
           drops the card ring meanwhile: the card ring means the pair-page link, so
           showing both drew two rings around two different destinations. -->
      <a [routerLink]="['/products', row().other.slug]" [class]="partnerLinkClass">{{
        row().other.name
      }}</a>
    </ng-template>
  `,
})
export class ProductIntegrationCard {
  /** The lane row: one edge, or a collapsed Via (connector, partner) row. */
  readonly row = input.required<IntegrationLaneRow>();
  /** This page's product slug; the pair-page context. */
  readonly contextSlug = input.required<string>();
  /**
   * 4 under a one-lane page's list heading (`h3`) or inside a lane card, 5 under a
   * category group's `h4`. 3 is kept for a caller with no heading above the list.
   */
  readonly headingLevel = input<3 | 4 | 5>(4);
  /** Inside a lane card: the nested card surface (tint, no shadow). */
  readonly nested = input(false);

  // The integration card recipe (match-card-recipe.ts). The card is `interactive`, so
  // the card surface owns its hover and focus ring; the body takes the recipe's room.
  protected readonly cardClass = `${MATCH_CARD_BODY_CLASS} text-(--text-primary) has-[.aec-partner-link:focus-visible]:outline-0`;
  protected readonly blockClass = MATCH_CARD_BLOCK_CLASS;
  protected readonly chipRowClass = MATCH_CHIP_ROW_CLASS;
  protected readonly chipClass = MATCH_CHIP_CLASS;
  protected readonly chipIconClass = MATCH_CHIP_ICON_CLASS;
  protected readonly footClass = `${MATCH_CARD_FOOT_CLASS} focus-visible:outline-0`;
  protected readonly goClass = MATCH_CARD_GO_CLASS;
  protected readonly partnerLinkClass = `aec-partner-link relative z-10 -my-0.5 inline-block rounded-sm py-0.5 ${MATCH_CARD_NAME_TEXT_CLASS} transition-colors hover:text-(--accent-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)`;
  protected readonly icon = matchChipIcon;

  // The chip-row labels, in TS so one string is both the visible label and the list's
  // name. The same message ids as the filter panel's "Categories" and "Types of data".
  protected readonly categoriesLabel = $localize`:@@search.facet.categories:Categories`;
  protected readonly dataTypesLabel = $localize`:@@products.detail.body.integrations.dataTypes:Types of data`;

  protected readonly pairLink = computed(() => [
    '/products',
    this.contextSlug(),
    'integrations',
    this.row().other.slug,
  ]);

  // The row's own label builders, so a card and a row can never word a fact two ways.
  protected readonly mechanismKindLabels = computed(() =>
    this.row()
      .mechanismKinds.map((kind) => mechanismKindLabel(kind))
      .filter((label) => label !== ''),
  );

  /**
   * The kind chips and the mechanism's name, each fact once (`mechanismDisplay`): "REST
   * API" replaces an "API" chip, and "Native" under a "Native" chip is not repeated.
   */
  protected readonly mechanism = computed(() =>
    mechanismDisplay(this.mechanismKindLabels(), this.row().integration.mechanism_name),
  );

  /** "by {vendor}" (mock-up 6), or `null` when the partner has no vendor on record. */
  protected readonly vendorLine = computed(() => {
    const vendor = this.row().integration.partner_vendor_name;
    return vendor
      ? $localize`:@@products.detail.integrations.card.byVendor:by ${vendor}:VENDOR:`
      : null;
  });

  protected readonly dataObjectLabel = computed(() =>
    dataObjectCountLabel(this.row().dataObjectSlugs.length),
  );

  protected readonly direction = computed(() =>
    contextDirectionLabel(this.row().direction, this.row().other.name),
  );

  protected readonly isViaLane = computed(
    () => routeIntegrationLane(this.row().integration).lane === 'via',
  );

  protected readonly rowUnderReview = computed(() =>
    rowUnderReviewFields(this.row().integration).map((field) => ({
      field,
      label: correctionLabel(field),
    })),
  );

  // Built in TS, as on the row. The same message id as the row's chevron name, so the
  // two links read alike. On the card it is the link's visible text.
  protected readonly pairLabel = computed(
    () =>
      $localize`:@@products.detail.integrations.row.aria:View the ${this.row().other.name}:PARTNER: integration`,
  );
}
