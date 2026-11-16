import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AecCard } from '../shared/card/card';
import { Chip } from '../shared/chip/chip';
import { FieldCaptionLine, type FieldCaptionPage } from '../shared/field-caption/field-caption';
import { newestCorrection } from '../shared/field-caption/field-caption-facts';
import { UnderReviewMarker } from '../shared/field-caption/under-review';
import { AecIcon } from '../shared/icon/icon';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';
import { fieldOverrideLabel } from '../vendor/components/field-override-labels';
import {
  contextDirectionLabel,
  dataObjectCountLabel,
  mechanismKindLabel,
} from '../search/mechanism-labels';

import { AgreementBadge } from './agreement-badge';
import { routeIntegrationLane, type IntegrationLaneRow } from './connector-lane-grouping';

/**
 * AECI-1782: one integration as a card, the default view of the product page's
 * Integrations section (PLAN.md §5.2, clash 24 "blend").
 *
 * The card says what the table row says, and a little more the row has no room
 * for. Content parity with `ProductIntegrationRow` is the rule: the partner and its
 * link, the direction with its "Direction:" prefix, the mechanism kinds and name,
 * the field caption, the corrections and the "Under review" markers, and the
 * pair-page link with the same accessible name. What the card adds is data the API
 * already sends (AECI-1781): the partner's categories, the names of the data objects
 * the integration moves, and the agreement state.
 *
 * **The agreement state is a label only** (ruling R1, PLAN.md §7.7). It renders
 * through the shared `aec-agreement-badge`, unattributed, so a `single_source` row
 * reads "Confirmed by one company" (ruling on AECI-1781, 2026-11-14). Nothing sorts,
 * filters, counts or features by it.
 *
 * **Two links, no nesting.** The partner name links to the partner's own page, as
 * on the row. The trailing chevron links to the pair page and is stretched over
 * the whole card (`after:absolute after:inset-0`), so a click anywhere on the card
 * opens the pair page. Every other interactive element sits above the stretched
 * layer with `relative z-10`, so it keeps its own destination.
 *
 * Attribute selector on `<li>`: the lane renders its cards as one named list, the
 * card view's version of §13.3's one table per lane.
 */
@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'li[aec-product-integration-card]',
  imports: [
    AecCard,
    AecIcon,
    AgreementBadge,
    Chip,
    FieldCaptionLine,
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
      class="flex h-full flex-col gap-4 p-6 text-(--text-primary) has-[.aec-partner-link:focus-visible]:outline-0"
      data-testid="integration-card"
    >
      <div class="flex items-start gap-3">
        <aec-logo-or-initial
          [claimStatus]="'server-filtered'"
          [src]="row().other.logo_url"
          [name]="row().other.name"
          size="sm"
        />
        <!-- The heading level follows the section: h3 under the section h2 on a
             one-lane page, h4 under a lane card's h3. The size sits on the link,
             not on the heading, because the unlayered heading rules beat a text-*
             utility on the heading itself (the Unlayered-Heading Rule). -->
        <div class="min-w-0 flex-1 self-center">
          @if (headingLevel() === 4) {
            <h4 class="break-words">
              <ng-container [ngTemplateOutlet]="partnerLink" />
            </h4>
          } @else {
            <h3 class="break-words">
              <ng-container [ngTemplateOutlet]="partnerLink" />
            </h3>
          }
        </div>
        <!-- The pair-page link: the same accessible name as the row's chevron, and
             stretched over the card. size-6 keeps the target at 24px. -->
        <a
          [routerLink]="pairLink()"
          [attr.aria-label]="pairAriaLabel()"
          class="inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-(--text-tertiary) transition-colors after:absolute after:inset-0 after:rounded-card group-hover/card:text-(--text-secondary) focus-visible:outline-0"
          data-testid="integration-card-pair-link"
        >
          <aec-icon name="chevron-right" decorative [size]="4" [mirrorRtl]="true" />
        </a>
      </div>

      @if (row().integration.partner_categories.length > 0) {
        <ul class="flex flex-wrap gap-1.5" data-testid="integration-card-categories">
          @for (category of row().integration.partner_categories; track category.slug) {
            <li>
              <aec-chip density="dense">{{ category.name }}</aec-chip>
            </li>
          }
        </ul>
      }

      <p class="flex flex-wrap items-center gap-x-1.5 text-sm text-(--text-secondary)">
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
            i18n="@@products.detail.integrations.direction.none"
            i18n-aria-label="@@products.detail.integrations.direction.none.aria"
            aria-label="Direction not listed"
            >–</span
          >
        }
      </p>

      @if (row().dataObjects.length > 0) {
        <ul class="flex flex-wrap gap-1.5" data-testid="integration-card-data-objects">
          @for (object of row().dataObjects; track object.slug) {
            <li>
              <aec-chip density="dense" tone="neutral">{{ object.name }}</aec-chip>
            </li>
          }
        </ul>
      } @else if (dataObjectLabel(); as objects) {
        <!-- Slugs with no names on the wire: the row's count label, never nothing. -->
        <p>
          <aec-chip density="dense" tone="neutral" data-testid="row-data-objects">{{
            objects
          }}</aec-chip>
        </p>
      }

      <div class="flex flex-col items-start gap-1 text-sm text-(--text-secondary)">
        @if (mechanismKindLabels().length > 0) {
          <span class="flex flex-wrap items-center gap-1">
            @for (label of mechanismKindLabels(); track label) {
              <aec-chip density="dense" tone="neutral">{{ label }}</aec-chip>
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
        @if (row().integration.mechanism_name; as name) {
          <span class="text-xs">{{ name }}</span>
        }
      </div>

      @if (row().agreement; as agreement) {
        <div>
          <aec-agreement-badge [agreement]="agreement" />
        </div>
      }

      @if (rowCaption() || rowCorrection() || rowUnderReview().length > 0) {
        <div class="relative z-10 mt-auto flex flex-col gap-1">
          @if (rowCaption() || rowCorrection()) {
            <aec-field-caption
              [caption]="rowCaption()"
              [correction]="rowCorrection()"
              [label]="rowCorrectionLabel()"
              [page]="captionPage()"
            />
          }
          @for (entry of rowUnderReview(); track entry.field) {
            <aec-under-review [label]="entry.label" />
          }
        </div>
      }
    </article>

    <ng-template #partnerLink>
      <!-- relative z-10 lifts the partner link above the stretched pair link, so it
           keeps its own destination. py-0.5 with -my-0.5 keeps a 24px target. The
           link draws its own ring, and the article's has-[.aec-partner-link] rule
           drops the card ring meanwhile: the card ring means the pair-page link, so
           showing both drew two rings around two different destinations. -->
      <a
        [routerLink]="['/products', row().other.slug]"
        class="aec-partner-link relative z-10 -my-0.5 inline-block rounded-sm py-0.5 text-t-20 leading-tight font-semibold transition-colors hover:text-(--accent-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)"
        >{{ row().other.name }}</a
      >
    </ng-template>
  `,
})
export class ProductIntegrationCard {
  /** The lane row: one edge, or a collapsed Via (connector, partner) row. */
  readonly row = input.required<IntegrationLaneRow>();
  /** This page's product slug; the pair-page context. */
  readonly contextSlug = input.required<string>();
  /** 3 on a one-lane page, 4 inside a lane card. */
  readonly headingLevel = input<3 | 4>(3);
  /** Inside a lane card: the nested card surface (tint, no shadow). */
  readonly nested = input(false);

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

  protected readonly dataObjectLabel = computed(() =>
    dataObjectCountLabel(this.row().dataObjectSlugs.length),
  );

  protected readonly direction = computed(() => contextDirectionLabel(this.row().direction));

  protected readonly isViaLane = computed(
    () => routeIntegrationLane(this.row().integration).lane === 'via',
  );

  protected readonly rowCaption = computed(() => this.row().caption);

  protected readonly rowCorrection = computed(() => newestCorrection(this.row().corrections));

  protected readonly rowCorrectionLabel = computed(() => {
    const correction = this.rowCorrection();
    return correction?.cleared ? fieldOverrideLabel(correction.field) : null;
  });

  protected readonly rowUnderReview = computed(() =>
    (this.row().integration.under_review ?? []).map((field) => ({
      field,
      label: fieldOverrideLabel(field),
    })),
  );

  protected readonly captionPage = computed<FieldCaptionPage>(() => {
    const { source, target } = this.row().integration;
    return {
      surface: 'product_detail',
      entityType: 'product',
      entityId: source.id === this.row().other.id ? target.id : source.id,
    };
  });

  // Built in TS, as on the row: an interpolated i18n attribute emits no attribute.
  // The same message id as the row, so the two links read alike.
  protected readonly pairAriaLabel = computed(
    () =>
      $localize`:@@products.detail.integrations.row.aria:View the ${this.row().other.name}:PARTNER: integration`,
  );
}
