import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { ProductDetail } from '@aeci/shared';

import { AecCard } from '../shared/card/card';
import { FieldCaptionLine, type FieldCaptionPage } from '../shared/field-caption/field-caption';
import { correctionInSlot } from '../shared/field-caption/field-caption-facts';
import { AecIcon } from '../shared/icon/icon';
import { TaxonomyBadge } from '../shared/taxonomy-badge/taxonomy-badge';

/** A group heading: the overline with its 16px glyph, as in the facts card. */
const GROUP_HEADING = 'aec-overline flex items-center gap-2 text-(--text-secondary)';

/**
 * Whether the "Who it is for" panel has anything to show: a term in one of the three
 * groups, or AECi's removal in an emptied group's slot. The page reads the same test for
 * the About band and its section nav entry, so the nav never links to an empty band.
 */
export function hasWhoItIsFor(p: ProductDetail): boolean {
  const corrections = p.captions?.corrections;
  return (
    p.audiences.length > 0 ||
    !!correctionInSlot(corrections, 'audience_slugs', false) ||
    p.trades.length > 0 ||
    !!correctionInSlot(corrections, 'trade_slugs', false) ||
    p.phases.length > 0 ||
    !!correctionInSlot(corrections, 'phase_slugs', false)
  );
}

/**
 * AECI-1780: "Who it is for", the right column of the product page's About band
 * (`PLAN.md` §5.2 row 5, mock-up 6 `.panel.who`). Audiences, Trades and Project phases,
 * moved here from the facts card's lower row with every caption that describes them.
 *
 * - Each group renders when it has a term or AECi's removal in its slot (AECI-1628).
 *   A correction sits under its group's chips (`STAGE_2_VENDOR_PORTAL_SPEC.md` §4.5.8).
 * - Terms are `aec-taxonomy-badge`, which renders `aec-chip` links. They keep the API's
 *   order: audiences by name, trades and phases by `display_order`, so phases read in
 *   lifecycle order. Nothing here sorts.
 * - The Managed caption closes the panel while one of the three groups has a value. The
 *   same group also covers the two Resources links, so the facts card keeps its own copy
 *   of the line under Resources while a link shows. Each copy sits with the fields it
 *   marks, and neither shows over nothing.
 *
 * Group order is the facet sidebar's: Audiences, Trades, Project phases. Every value is a
 * static product field, so the cached SSR HTML is the same for every visitor.
 */
@Component({
  selector: 'aec-product-who-it-is-for',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AecCard, AecIcon, FieldCaptionLine, TaxonomyBadge],
  host: { class: 'block' },
  template: `
    @let p = product();
    <section
      aecCard
      aria-labelledby="who-it-is-for-title"
      class="space-y-6 p-6 md:p-8"
      data-testid="product-who-it-is-for"
    >
      <h3 id="who-it-is-for-title">
        <span class="font-display text-t-24 font-semibold" i18n="@@products.detail.about.whoItIsFor"
          >Who it is for</span
        >
      </h3>

      @if (p.audiences.length > 0 || slotCorrection('audience_slugs', false)) {
        <section aria-labelledby="audiences-label" class="min-w-0 space-y-3">
          <h4 id="audiences-label" [class]="groupHeading">
            <aec-icon name="users" decorative [size]="4" />
            <span i18n="@@products.detail.metadata.audiences">Audiences</span>
          </h4>
          @if (p.audiences.length > 0) {
            <div class="flex flex-wrap gap-2">
              @for (d of p.audiences; track d.slug) {
                <aec-taxonomy-badge kind="audience" [slug]="d.slug" [name]="d.name" />
              }
            </div>
          }
          <aec-field-caption
            [correction]="slotCorrection('audience_slugs', p.audiences.length > 0)"
            [page]="page()"
          />
        </section>
      }

      <!-- Trades (AECI-544). Sparse by design: a product is tagged only when it has
           trade-specific value. Never gated on the publication floor, because the tag is
           true even when the trade page is not promoted yet (TRADES_VOCABULARY.md
           section 6). -->
      @if (p.trades.length > 0 || slotCorrection('trade_slugs', false)) {
        <section aria-labelledby="trades-label" class="min-w-0 space-y-3">
          <h4 id="trades-label" [class]="groupHeading">
            <aec-icon name="hard-hat" decorative [size]="4" />
            <span i18n="@@products.detail.metadata.trades">Trades</span>
          </h4>
          @if (p.trades.length > 0) {
            <div class="flex flex-wrap gap-2">
              @for (tr of p.trades; track tr.slug) {
                <aec-taxonomy-badge kind="trade" [slug]="tr.slug" [name]="tr.name" />
              }
            </div>
          }
          @if (slotCorrection('trade_slugs', p.trades.length > 0); as c) {
            <aec-field-caption [correction]="c" [page]="page()" />
          }
        </section>
      }

      @if (p.phases.length > 0 || slotCorrection('phase_slugs', false)) {
        <section aria-labelledby="phases-label" class="min-w-0 space-y-3">
          <h4 id="phases-label" [class]="groupHeading">
            <aec-icon name="gantt" decorative [size]="4" />
            <span i18n="@@products.detail.metadata.phases">Project phases</span>
          </h4>
          @if (p.phases.length > 0) {
            <div class="flex flex-wrap gap-2">
              @for (ph of p.phases; track ph.slug) {
                <aec-taxonomy-badge kind="phase" [slug]="ph.slug" [name]="ph.name" />
              }
            </div>
          }
          @if (slotCorrection('phase_slugs', p.phases.length > 0); as c) {
            <aec-field-caption [correction]="c" [page]="page()" />
          }
        </section>
      }

      <!-- AECI-1614: the Managed group's one line for these three groups, after the last
           of them. Not one per group: the same sentence three times reads as a badge. -->
      @if (managedCaption(); as c) {
        <aec-field-caption data-testid="managed-caption" [caption]="c" [page]="page()" />
      }
    </section>
  `,
})
export class ProductWhoItIsFor {
  readonly product = input.required<ProductDetail>();
  /** The product page, for each caption's source link click. */
  readonly page = input.required<FieldCaptionPage>();

  protected readonly groupHeading = GROUP_HEADING;

  /**
   * The Managed caption, while one of the three groups has a term. A vendor can clear
   * every term, and a caption under nothing says nothing.
   */
  protected readonly managedCaption = computed(() => {
    const p = this.product();
    const hasValues = p.audiences.length > 0 || p.trades.length > 0 || p.phases.length > 0;
    return hasValues ? (p.captions?.managed ?? null) : null;
  });

  /**
   * AECi's correction in one value's slot (AECI-1628): a value-setting one while the
   * value shows, a removal while it does not.
   */
  protected slotCorrection(field: string, present: boolean) {
    return correctionInSlot(this.product().captions?.corrections, field, present);
  }
}
