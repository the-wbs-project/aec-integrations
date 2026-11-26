import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import type { ProductListItem } from '@aeci/shared';

import { RatingSummary } from '../reviews/rating-summary';
import { AecCard, CARD_GRID_CLASS } from '../shared/card/card';
import { Chip } from '../shared/chip/chip';
import { AecIcon } from '../shared/icon/icon';
import { LogoOrInitial } from '../shared/logo-or-initial/logo-or-initial';

/**
 * AECI-710 / `STAGE_1_5_SPEC.md` §13.3b — the `product_extensions` relation on
 * the product detail page, both directions.
 *
 * An extension is a product built INSIDE a host (a Revit add-in, a Dynamics 365
 * vertical). It runs in the host, so there is no boundary for data to cross and
 * it is not an integration. Both components below are therefore deliberately
 * NOT integration vocabulary: no table, no lane, no `IntegrationGroupCard`, no
 * direction, no count. The Integrations section and `integration_count` never
 * see these rows (§13.5's lockstep is unchanged).
 *
 * Anchor site: Faire (the catalog's anchor, `DESIGN.md`). Its "Shop more from
 * {brand}" parent strip is the pattern for the sidebar card, and its brand tile
 * row for the body grid. One verb, "built within", names the relation in both
 * directions so the two read as mirror images. Since ruling 35 (2026-11-16,
 * AECI-1784) the body tiles are the shared card (`aecCard`): white, the card
 * shadow, and the card lift on hover. Since the AECI-1720 restore (owner, 2026-11-17)
 * they follow mock-up 6 `.xt`: "by {vendor}", the shared rating line,
 * a "Runs inside {product}" chip and a round arrow. What keeps them from reading as
 * integration rows is the chip's words and the separate section, not the arrow. The
 * mark stays 32px, the tile-mark size of the logo rule, not the mock-up's 56px.
 */

/** The "Built within" link card: the vendor card's shape, plus a visible focus ring. */
const CARD_CLASS =
  'flex h-full items-center gap-3 rounded-panel border border-(--border-default) ' +
  'p-3 no-underline transition-colors ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-primary) ' +
  'focus-visible:ring-offset-2 focus-visible:ring-offset-(--surface-base)';

/**
 * "Built within": the hosts this product is built within, in the metadata
 * sidebar directly under Vendor. Same card as the vendor card, because it is the
 * same kind of fact: what this product is, not what it connects to.
 *
 * Attribute selector on the page's own `<section>`, the same escape hatch as
 * `ProductIntegrationsSection`, so the sidebar's grid and `space-y` rhythm land
 * on the section itself. The parent mounts it only when `hosts` is non-empty.
 */
@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'section[aec-product-built-within]',
  imports: [RouterLink, LogoOrInitial],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2
      id="built-within-title"
      class="aec-overline text-(--text-secondary)"
      i18n="@@products.detail.metadata.builtWithin"
    >
      Built within
    </h2>
    <ul class="space-y-2">
      @for (host of hosts(); track host.id) {
        <li>
          <a
            [routerLink]="['/products', host.slug]"
            [class]="cardClass"
            class="bg-(--surface-base) lg:bg-(--surface-raised) lg:p-4"
          >
            <aec-logo-or-initial
              [claimStatus]="'server-filtered'"
              [src]="host.logo_url"
              [name]="host.name"
              alt=""
              size="sm"
            />
            <span class="min-w-0">
              <span class="block break-words font-semibold text-(--text-primary)">{{
                host.name
              }}</span>
              @if (host.vendor; as v) {
                <span class="block break-words text-sm text-(--text-secondary)">{{ v.name }}</span>
              }
            </span>
          </a>
        </li>
      }
    </ul>
  `,
})
export class ProductBuiltWithin {
  readonly hosts = input.required<readonly ProductListItem[]>();
  protected readonly cardClass = CARD_CLASS;
}

/**
 * "Extensions built within {product}": the products built within this one, as a
 * body section after Integrations. A grid of linked tiles, never table rows, so
 * it cannot read as a third integrations lane. Each tile is one `aecCard` that is
 * itself the link, so it keeps the link name it had: the name, then the vendor.
 * The tiles keep the API's order, A to Z by name then id
 * (`apps/api/src/lib/product-extensions.ts`). This component adds no sort. The
 * heading carries no `(N)`, so the page never shows two counts that look like the
 * same kind.
 *
 * Attribute selector on the page's `<section id="extensions">`, like the
 * Integrations section, so the anchor and the labelled region stay on the
 * element the section nav links to. The parent mounts it only when
 * `extensions` is non-empty.
 */
@Component({
  // eslint-disable-next-line @angular-eslint/component-selector
  selector: 'section[aec-product-extensions-section]',
  imports: [RouterLink, AecCard, AecIcon, Chip, LogoOrInitial, RatingSummary],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- Mock-up 6 band head (AECI-1720 restore): the small label above the heading, hidden
         from assistive technology because the heading says it again. -->
    <div>
      <p
        aria-hidden="true"
        class="aec-overline mb-3 text-(--text-secondary)"
        i18n="@@products.detail.extensions.kicker"
      >
        Extensions
      </p>
      <h2 id="extensions-title">
        <span
          class="font-display text-t-36 leading-[1.1] font-semibold tracking-[-0.02em] text-(--text-primary)"
          >{{ heading() }}</span
        >
      </h2>
      <p
        class="mt-4 max-w-[38em] text-t-16 leading-relaxed text-(--text-secondary)"
        data-testid="extensions-lead"
      >
        {{ lead() }}
      </p>
    </div>
    <ul role="list" [class]="gridClass" [attr.data-columns]="columns()">
      @for (extension of extensions(); track extension.id) {
        <li class="group/card">
          <a
            aecCard
            interactive
            [routerLink]="['/products', extension.slug]"
            class="grid h-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-4 p-6 no-underline"
          >
            <aec-logo-or-initial
              [claimStatus]="'server-filtered'"
              [src]="extension.logo_url"
              [name]="extension.name"
              alt=""
              size="sm"
            />
            <span class="min-w-0">
              <span
                class="block font-display text-t-20 leading-tight font-semibold break-words text-(--text-primary) transition-colors group-hover/card:text-(--accent-primary)"
                >{{ extension.name }}</span
              >
              @if (extension.vendor; as v) {
                <span
                  class="mt-1 block text-t-13 break-words text-(--text-secondary)"
                  i18n="@@products.detail.extensions.byline"
                  >by {{ v.name }}</span
                >
              }
              <!-- The shared card's rating rule: shown only at five reviews or more. -->
              <aec-rating-summary
                class="mt-2 flex"
                variant="inline"
                [ratingOverall]="extension.rating_overall_avg"
                [reviewCount]="extension.review_count"
              />
              <!-- Mock-up 6 .xt chip: the relation in words, the same fact the intro states. -->
              <span class="mt-2 flex">
                <aec-chip
                  density="dense"
                  icon="puzzle"
                  i18n="@@products.detail.extensions.runsInside"
                  >Runs inside {{ productName() }}</aec-chip
                >
              </span>
            </span>
            <span
              class="grid size-8 place-items-center rounded-full bg-(--surface-sunken) text-(--text-secondary) transition-colors group-hover/card:text-(--text-primary)"
              aria-hidden="true"
            >
              <aec-icon name="arrow-right" decorative [size]="4" />
            </span>
          </a>
        </li>
      }
    </ul>
  `,
})
export class ProductExtensionsSection {
  /** The page product's name: the host every listed extension is built within. */
  readonly productName = input.required<string>();
  readonly extensions = input.required<readonly ProductListItem[]>();
  protected readonly gridClass = CARD_GRID_CLASS;

  /**
   * Ruling 35 (2026-11-16): one or two tiles share the row equally, three or more
   * take the shared grid's three columns. A set `data-columns` also makes every row
   * as tall as the tallest tile, so no tile is larger than its siblings.
   */
  protected readonly columns = computed<1 | 2 | 3>(() => {
    const n = this.extensions().length;
    return n <= 2 ? (Math.max(n, 1) as 1 | 2) : 3;
  });

  protected readonly heading = computed(() => {
    const name = this.productName();
    return $localize`:@@products.detail.body.extensions.heading:Extensions built within ${name}:name:`;
  });

  protected readonly lead = computed(() => {
    const name = this.productName();
    return $localize`:@@products.detail.body.extensions.lead:Add-ins and apps that run inside ${name}:name: rather than connecting to it.`;
  });
}
