import { ChangeDetectionStrategy, Component, input } from '@angular/core';

import type { ProductDetail } from '@aeci/shared';

import { AecCard } from '../shared/card/card';
import { AecIcon } from '../shared/icon/icon';
import { TaxonomyBadge } from '../shared/taxonomy-badge/taxonomy-badge';

/** A group heading: the overline with its 16px glyph, as in the facts card. */
const GROUP_HEADING = 'aec-overline flex items-center gap-2 text-(--text-secondary)';

/**
 * Whether the "Who it is for" panel has anything to show: a term in one of the three
 * groups. A removal that emptied a group takes the group away, and "About this listing"
 * lists it (AECI-1666). The page reads the same test for the About band and its section
 * nav entry, so the nav never links to an empty band.
 */
export function hasWhoItIsFor(p: ProductDetail): boolean {
  return p.audiences.length > 0 || p.trades.length > 0 || p.phases.length > 0;
}

/**
 * AECI-1780: "Who it is for", the right column of the product page's About band
 * (`PLAN.md` §5.2 row 5, mock-up 6 `.panel.who`). Audiences, Trades and Project phases,
 * moved here from the facts card's lower row.
 *
 * - Each group renders when it has a term. No caption or correction renders here: they
 *   are in the page's "About this listing" panel (AECI-1666, §4.5.8).
 * - Terms are `aec-taxonomy-badge`, which renders `aec-chip` links. They keep the API's
 *   order: audiences by name, trades and phases by `display_order`, so phases read in
 *   lifecycle order. Nothing here sorts.
 *
 * Group order is the facet sidebar's: Audiences, Trades, Project phases. Every value is a
 * static product field, so the cached SSR HTML is the same for every visitor.
 */
@Component({
  selector: 'aec-product-who-it-is-for',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AecCard, AecIcon, TaxonomyBadge],
  host: { class: 'block' },
  template: `
    @let p = product();
    <section
      aecCard
      aria-labelledby="who-it-is-for-title"
      class="space-y-6 p-6 md:p-8"
      data-testid="product-who-it-is-for"
    >
      <div>
        <h3 id="who-it-is-for-title">
          <span
            class="font-display text-t-24 font-semibold"
            i18n="@@products.detail.about.whoItIsFor"
            >Who it is for</span
          >
        </h3>
        <!-- Mock-up 6 .who .sub (AECI-1720 restore): a neutral line on what the chips are. -->
        <p
          class="mt-1 text-t-14 text-(--text-secondary)"
          i18n="@@products.detail.about.whoItIsFor.intro"
        >
          The teams, project phases and trades it is listed for.
        </p>
      </div>

      @if (p.audiences.length > 0) {
        <section aria-labelledby="audiences-label" class="min-w-0 space-y-3">
          <h4 id="audiences-label" [class]="groupHeading">
            <aec-icon name="users" decorative [size]="4" />
            <span i18n="@@products.detail.metadata.audiences">Audiences</span>
          </h4>
          <div class="flex flex-wrap gap-2">
            @for (d of p.audiences; track d.slug) {
              <aec-taxonomy-badge kind="audience" icon="users" [slug]="d.slug" [name]="d.name" />
            }
          </div>
        </section>
      }

      <!-- Trades (AECI-544). Sparse by design: a product is tagged only when it has
           trade-specific value. Never gated on the publication floor, because the tag is
           true even when the trade page is not promoted yet (TRADES_VOCABULARY.md
           section 6). -->
      @if (p.trades.length > 0) {
        <section aria-labelledby="trades-label" class="min-w-0 space-y-3">
          <h4 id="trades-label" [class]="groupHeading">
            <aec-icon name="hard-hat" decorative [size]="4" />
            <span i18n="@@products.detail.metadata.trades">Trades</span>
          </h4>
          <div class="flex flex-wrap gap-2">
            @for (tr of p.trades; track tr.slug) {
              <aec-taxonomy-badge kind="trade" icon="hard-hat" [slug]="tr.slug" [name]="tr.name" />
            }
          </div>
        </section>
      }

      @if (p.phases.length > 0) {
        <section aria-labelledby="phases-label" class="min-w-0 space-y-3">
          <h4 id="phases-label" [class]="groupHeading">
            <aec-icon name="gantt" decorative [size]="4" />
            <span i18n="@@products.detail.metadata.phases">Project phases</span>
          </h4>
          <div class="flex flex-wrap gap-2">
            @for (ph of p.phases; track ph.slug) {
              <aec-taxonomy-badge kind="phase" icon="gantt" [slug]="ph.slug" [name]="ph.name" />
            }
          </div>
        </section>
      }
    </section>
  `,
})
export class ProductWhoItIsFor {
  readonly product = input.required<ProductDetail>();
  protected readonly groupHeading = GROUP_HEADING;
}
