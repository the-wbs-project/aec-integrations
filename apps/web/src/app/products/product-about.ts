import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import type { ProductDetail } from '@aeci/shared';

import { FieldCaptionLine, type FieldCaptionPage } from '../shared/field-caption/field-caption';
import { isUnderReview } from '../shared/field-caption/field-caption-facts';
import { UnderReviewMarker } from '../shared/field-caption/under-review';

/**
 * Split a stored description into paragraphs, each a list of lines. A blank line (two line
 * breaks, with any spaces between them) ends a paragraph. A single line break stays inside
 * its paragraph and renders as a `<br>`. Nothing is parsed as markup: each line is
 * interpolated text, so no stored character can become HTML.
 */
export function descriptionParagraphs(
  description: string | null | undefined,
): readonly (readonly string[])[] {
  if (!description) return [];
  return description
    .replace(/\r\n?/g, '\n')
    .split(/\n[^\S\n]*\n/)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    )
    .filter((lines) => lines.length > 0);
}

/**
 * AECI-1720 restore: the left column of the product page's About band (mock-up 6
 * `.about-copy`). The small "About" label, the heading "About {product}", then the
 * description with its paragraph breaks kept: the first paragraph as the serif lead at
 * `--t-24`, the rest at `--t-16` in secondary ink. The description caption follows, 24px
 * below. With no description the column shows AECi's under-review line when AECi hid it.
 *
 * The label repeats the heading's first word, so it is hidden from assistive technology:
 * a screen reader hears the heading once. The heading keeps its id, `description-title`,
 * which the page's `#about` section is labelled by.
 *
 * Every value is a static product field, so the cached SSR HTML is the same for every
 * visitor. The caption keeps its words and conditions (`STAGE_2_VENDOR_PORTAL_SPEC.md`
 * §4.5.8).
 */
@Component({
  selector: 'aec-product-about',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [FieldCaptionLine, UnderReviewMarker],
  host: { class: 'block min-w-0' },
  template: `
    @let p = product();
    <p
      aria-hidden="true"
      class="aec-overline mb-3 text-(--text-secondary)"
      i18n="@@products.detail.about.kicker"
    >
      About
    </p>
    <h2 id="description-title">
      <span
        class="font-display text-t-36 leading-[1.1] font-semibold tracking-[-0.02em] text-(--text-primary)"
        i18n="@@products.detail.about.heading"
        >About {{ p.name }}</span
      >
    </h2>
    @if (paragraphs().length > 0) {
      <div class="mt-6 max-w-prose space-y-4" data-testid="product-description">
        @for (paragraph of paragraphs(); track $index) {
          <p
            [class]="$first ? leadClass : restClass"
            [attr.data-testid]="$first ? 'product-description-lead' : null"
          >
            @for (line of paragraph; track $index) {
              @if (!$first) {
                <br />
              }
              {{ line }}
            }
          </p>
        }
      </div>
      @if (p.captions?.description; as c) {
        <aec-field-caption class="mt-6" [caption]="c" [page]="page()" />
      }
    } @else if (underReview()) {
      <!-- AECI-1238 (§11d.7): AECi hid the description while it checks it. -->
      <div class="mt-6">
        <aec-under-review data-testid="description-under-review" />
      </div>
    }
  `,
})
export class ProductAbout {
  readonly product = input.required<ProductDetail>();
  /** The product page, for the caption's source link click. */
  readonly page = input.required<FieldCaptionPage>();

  /** The first paragraph: the serif lead (mock-up 6 `.about-copy .first`). */
  protected readonly leadClass =
    'font-display text-t-24 leading-[1.4] font-normal tracking-[-0.01em] break-words text-(--text-primary)';
  /** Every later paragraph (mock-up 6 `.about-copy p + p`). */
  protected readonly restClass = 'text-t-16 leading-relaxed break-words text-(--text-secondary)';

  protected readonly paragraphs = computed(() => descriptionParagraphs(this.product().description));

  /** AECI-1238 (§11d.7): whether AECi hid the description while it checks it. */
  protected readonly underReview = computed(() =>
    isUnderReview(this.product().under_review, 'description'),
  );
}
