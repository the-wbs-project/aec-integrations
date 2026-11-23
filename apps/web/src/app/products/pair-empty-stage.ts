import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ProductPairSubject } from '@aeci/shared';

import { Chip } from '../shared/chip/chip';
import { AecIcon } from '../shared/icon/icon';
import { LogoOrInitial, logoAlt } from '../shared/logo-or-initial/logo-or-initial';
import { UnclaimedNote } from '../shared/unclaimed-note/unclaimed-note';

/** How many category chips a card shows before "+N more" (the card has a fixed width). */
const CARD_CATEGORIES = 2;

/**
 * AECI-1835: the empty pair hero's diagram (mock-up 5, `.stage`). It is projected into
 * the shared hero band's `heroPanel` slot from `products-pair.ts`.
 *
 * - Two white product cards, tilted and offset, context first. Each has its Clay tag
 *   ("Product one", "Product two"), its mark, its name as a link, "by {vendor}" and its
 *   first categories in the product page's order.
 * - Between them, two Forest ribbons that stop at the broken-link medallion, with the
 *   §11.4 medallion label under it, and the mock-up's rings behind. The ribbons carry no
 *   arrowhead and no data-type beads: the mock-up's beads name data types (Drawings,
 *   Markups, Cost codes, Commitments), which would read as a flow this pair does not have.
 * - Below `md` the cards stack with the label between them, as the mock-up does at 390.
 *
 * The SVG is `aria-hidden`: everything it shows is text elsewhere (the h1 and the label).
 * The cards are real content. The one entrance animation draws the Clay line along each
 * ribbon. It runs once on first paint of the server HTML (hydration keeps the element),
 * and reduced motion shows the drawn state at once. The animation changes no layout.
 *
 * Logo rule (AECI-1769): the 64px mark is the logo only for a claimed product. An
 * unclaimed product shows its initial tile there, and its note under the byline, with the
 * small 32px sourced logo beside it only when one is on record.
 */
@Component({
  selector: 'aec-pair-empty-stage',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AecIcon, Chip, LogoOrInitial, RouterLink, UnclaimedNote],
  // Beside the statement from 1040px, as mock-up 5 has it; under it, at the start, below.
  host: {
    class: 'block min-[1040px]:pt-6',
    'data-testid': 'pair-empty-stage',
  },
  styles: `
    .aec-ribbon-draw {
      stroke-dasharray: 400;
      stroke-dashoffset: 400;
      animation: aec-ribbon-draw calc(var(--duration-slow) * 4) var(--ease-standard)
        var(--duration-slow) forwards;
    }
    @keyframes aec-ribbon-draw {
      to {
        stroke-dashoffset: 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .aec-ribbon-draw {
        animation: none;
        stroke-dashoffset: 0;
      }
    }
  `,
  template: `
    <div class="flex flex-col md:w-[540px]">
      @for (card of cards(); track card.key) {
        @if (card.key === 'other') {
          <!-- The join: the ribbons and the medallion from md, a Clay tick above and below
               the label below md. -->
          <div
            class="relative flex flex-col items-center py-6 md:z-0 md:-my-12 md:h-[270px] md:py-0"
            data-testid="pair-empty-join"
          >
            <span
              class="h-4.5 w-1 rounded-pill bg-(--accent-secondary) md:hidden"
              aria-hidden="true"
            ></span>
            <svg
              class="absolute inset-0 hidden size-full overflow-visible md:block"
              viewBox="0 0 540 270"
              aria-hidden="true"
              focusable="false"
            >
              <circle
                cx="270"
                cy="130"
                r="226"
                class="fill-(--accent-primary-hover)"
                opacity=".36"
              />
              <circle
                cx="270"
                cy="130"
                r="158"
                fill="none"
                class="stroke-(--text-on-brand)"
                stroke-opacity=".1"
                stroke-width="1.5"
              />
              <circle
                cx="270"
                cy="130"
                r="104"
                class="fill-(--accent-primary-hover)"
                opacity=".6"
              />
              <path
                [attr.d]="ribbonA"
                fill="none"
                class="stroke-(--surface-hero-ribbon)"
                stroke-width="26"
                stroke-linecap="round"
              />
              <path
                [attr.d]="ribbonB"
                fill="none"
                class="stroke-(--surface-hero-ribbon)"
                stroke-width="26"
                stroke-linecap="round"
              />
              <path
                [attr.d]="ribbonA"
                fill="none"
                class="aec-ribbon-draw stroke-(--accent-secondary)"
                stroke-width="3.5"
                stroke-linecap="round"
              />
              <path
                [attr.d]="ribbonB"
                fill="none"
                class="aec-ribbon-draw stroke-(--accent-secondary)"
                stroke-width="3.5"
                stroke-linecap="round"
              />
              <circle cx="224" cy="130" r="9" class="fill-(--accent-secondary)" />
              <circle cx="316" cy="130" r="9" class="fill-(--accent-secondary)" />
              <circle
                cx="270"
                cy="130"
                r="40"
                fill="none"
                class="stroke-(--accent-secondary)"
                stroke-width="2"
                stroke-dasharray="2 7"
                stroke-linecap="round"
              />
              <circle cx="270" cy="130" r="30" class="fill-(--accent-warm)" />
            </svg>
            <span
              class="absolute top-[130px] left-1/2 hidden -translate-x-1/2 -translate-y-1/2 text-(--accent-primary) md:block"
              aria-hidden="true"
              ><aec-icon name="unlink" decorative [size]="6"
            /></span>
            <p
              class="relative m-0 rounded-pill bg-(--accent-primary) px-3 py-2 text-t-13 font-semibold whitespace-nowrap text-(--text-on-brand) ring-1 ring-(--border-on-brand-subtle) md:absolute md:top-[172px] md:left-1/2 md:-translate-x-1/2"
              data-testid="pair-empty-medallion"
              i18n="@@pair.empty.medallion"
            >
              No integration on record
            </p>
            <span
              class="h-4.5 w-1 rounded-pill bg-(--accent-secondary) md:hidden"
              aria-hidden="true"
            ></span>
          </div>
        }
        <div
          [class]="card.placeClass"
          class="relative z-10 rounded-panel bg-(--surface-base) p-4 text-(--text-primary) shadow-card transition-transform duration-slow ease-standard md:w-[338px] md:rounded-card md:px-6 md:pt-6 md:pb-4"
          [attr.data-testid]="'pair-side-' + card.key"
        >
          <span
            class="absolute -top-3.5 start-5 rounded-pill bg-(--accent-secondary) px-3 py-1 text-t-12 font-semibold text-(--text-primary)"
            >{{ card.tag }}</span
          >
          <div class="flex min-w-0 items-center gap-4">
            <aec-logo-or-initial
              class="max-md:[&>*]:size-11.5"
              [name]="card.product.name"
              [src]="card.product.logo_url"
              [alt]="logoAlt(card.product.name)"
              [claimStatus]="card.product.claim_status"
              size="lg"
            />
            <div class="min-w-0">
              <h2 class="m-0 break-words">
                <a
                  [routerLink]="['/products', card.product.slug]"
                  class="font-display text-t-20 leading-[1.1] font-semibold text-(--text-primary) no-underline underline-offset-3 hover:text-(--accent-primary) hover:underline focus-visible:outline-(--accent-primary) md:text-t-24"
                  >{{ card.product.name }}</a
                >
              </h2>
              @if (card.product.vendor; as v) {
                <p class="m-0 text-t-14 text-(--text-secondary)" i18n="@@pair.empty.card.by">
                  by
                  <a
                    [routerLink]="['/vendors', v.slug]"
                    class="font-semibold text-(--text-primary) underline decoration-(--border-strong) underline-offset-3 hover:text-(--accent-primary) focus-visible:outline-(--accent-primary)"
                    >{{ v.name }}</a
                  >
                </p>
              }
            </div>
          </div>
          @if (card.product.claim_status === 'unclaimed') {
            <div class="mt-3 flex items-center gap-2">
              @if (card.product.logo_url) {
                <aec-logo-or-initial
                  [name]="card.product.name"
                  [src]="card.product.logo_url"
                  [alt]="logoAlt(card.product.name)"
                  [claimStatus]="card.product.claim_status"
                  [ownPage]="true"
                  size="sm"
                />
                <aec-unclaimed-note />
              } @else {
                <!-- No logo on record: the note alone, no second initial tile. -->
                <aec-unclaimed-note />
              }
            </div>
          }
          @if (card.categories.length > 0) {
            <div class="mt-3 flex flex-wrap gap-2 md:mt-4">
              @for (c of card.categories; track c.slug) {
                <aec-chip icon="tag" [link]="['/categories', c.slug]">{{ c.name }}</aec-chip>
              }
              @if (card.moreCategories > 0) {
                <aec-chip tone="quiet" [link]="['/products', card.product.slug]"
                  ><ng-container i18n="@@pair.empty.card.moreCategories"
                    >+{{ card.moreCategories }} more</ng-container
                  ></aec-chip
                >
              }
            </div>
          }
        </div>
      }
    </div>
  `,
})
export class PairEmptyStage {
  /** The URL's first product. */
  readonly context = input.required<ProductPairSubject>();
  /** The URL's second product. */
  readonly other = input.required<ProductPairSubject>();

  protected readonly logoAlt = logoAlt;

  /** From under the first card (its lower left) to the medallion's left dot. */
  protected readonly ribbonA = 'M110 0 C110 130, 160 130, 224 130';
  /** From the medallion's right dot to under the second card (its upper right). */
  protected readonly ribbonB = 'M430 270 C430 130, 380 130, 316 130';

  protected readonly cards = computed(() => [
    this.card('context', this.context(), $localize`:@@pair.empty.card.one:Product one`),
    this.card('other', this.other(), $localize`:@@pair.empty.card.two:Product two`),
  ]);

  private card(key: 'context' | 'other', product: ProductPairSubject, tag: string) {
    return {
      key,
      product,
      tag,
      categories: product.categories.slice(0, CARD_CATEGORIES),
      moreCategories: Math.max(0, product.categories.length - CARD_CATEGORIES),
      // The mock-up's tilt and offset from md; a smaller tilt and inset below it.
      placeClass:
        key === 'context'
          ? 'me-6 -rotate-1 md:me-0 md:-rotate-[2.2deg] md:self-start'
          : 'ms-6 rotate-1 md:ms-0 md:rotate-[1.8deg] md:self-end',
    };
  }
}
