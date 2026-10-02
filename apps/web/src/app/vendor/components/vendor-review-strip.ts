import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';

import { VendorLooksRight, type LooksRightTarget } from './vendor-looks-right';

/**
 * The "Looks right" strip at the head of a reviewable page (AECI-1218,
 * `STAGE_2_PAID_TIERS_SPEC.md` §13.8): the company profile, a product's profile,
 * and a product's integration list. One sentence saying what the button records,
 * then the button.
 *
 * Saving an edit counts as checking too (§13.10 reads `maintained_by` and
 * `last_reviewed_at`, which an edit stamps), so the copy says so: "Looks right"
 * is for the case where nothing needs to change.
 */
@Component({
  selector: 'aec-vendor-review-strip',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [VendorLooksRight],
  template: `
    <div
      class="flex flex-col gap-3 rounded-(--radius-md) border border-(--border-default) bg-(--surface-raised) p-4 sm:flex-row sm:items-center sm:justify-between"
      [attr.data-review-target]="target()"
    >
      <p class="max-w-prose text-sm leading-relaxed text-(--text-secondary)">{{ text() }}</p>
      <aec-vendor-looks-right
        class="shrink-0"
        [target]="target()"
        [productId]="productId()"
        [productName]="productName()"
        [done]="done()"
      />
    </div>
  `,
  styles: [':host { display: block; }'],
})
export class VendorReviewStrip {
  readonly target = input.required<LooksRightTarget>();
  readonly productId = input<string | null>(null);
  readonly productName = input<string | null>(null);
  readonly done = input(false);

  protected readonly text = computed(() => {
    switch (this.target()) {
      case 'profile':
        return $localize`:@@vendor.reviewStrip.profile:Checked your company details and nothing needs to change? Press Looks right. Saving an edit counts too.`;
      case 'product':
        return $localize`:@@vendor.reviewStrip.product:Checked this product's details and nothing needs to change? Press Looks right. Saving an edit counts too.`;
      default:
        return $localize`:@@vendor.reviewStrip.integrations:Is every integration listed for this product, and nothing extra? Press Looks right to record that you checked.`;
    }
  });
}
