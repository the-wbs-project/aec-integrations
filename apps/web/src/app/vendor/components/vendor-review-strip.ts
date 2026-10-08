import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  type Signal,
} from '@angular/core';

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
 *
 * AECI-1241: the strip is for a step that is not done yet. Each page renders it
 * only through {@link reviewStripShown}. A step already done when the page
 * loads gets no strip. A step the vendor checks in this view keeps its strip,
 * now reading "Checked", until the vendor leaves the page.
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

/** A checklist step as one page sees it. `unknown` until its checklist loads. */
export type ReviewStepState = 'unknown' | 'done' | 'todo';

/** The state of step `key` in a checklist, or `unknown` while it is not loaded. */
export function reviewStepState(
  checklist: { readonly steps: ReadonlyArray<{ key: string; status: string }> } | null | undefined,
  key: string,
): ReviewStepState {
  if (!checklist) return 'unknown';
  return checklist.steps.some((s) => s.key === key && s.status === 'done') ? 'done' : 'todo';
}

/** One "Looks right" control's record and the state of its step. */
export interface ReviewLatchEntry {
  /** What the control checks: `'company'`, or a product id. `null` while unresolved. */
  readonly record: string | null;
  readonly state: ReviewStepState;
}

/**
 * The AECI-1241 rule over a set of controls: record -> shown. A record already
 * decided keeps its decision. A new record is decided once its step is known:
 * shown only when the step is not done. Records no longer present are dropped,
 * so coming back to one decides again.
 */
export function latchReviewDecisions(
  prev: ReadonlyMap<string, boolean> | undefined,
  entries: readonly ReviewLatchEntry[],
): ReadonlyMap<string, boolean> {
  const next = new Map<string, boolean>();
  for (const { record, state } of entries) {
    if (record === null) continue;
    const held = prev?.get(record);
    if (held !== undefined) next.set(record, held);
    else if (state !== 'unknown') next.set(record, state === 'todo');
  }
  return next;
}

/**
 * Whether a page renders its review strip (AECI-1241). The decision is taken
 * once per record, the first time the step's state is known in this component
 * instance, and then held. So a strip shown at load stays after the refetch
 * flips the step to done, and a step done at load never shows one.
 *
 * `record` names what the strip checks: `'company'`, or a product id. A new
 * record re-decides, which covers a routed page reused for another product.
 * Nothing renders while the record is `null` or the step is `unknown`.
 */
export function reviewStripShown(source: () => ReviewLatchEntry): Signal<boolean> {
  const latch = linkedSignal<ReviewLatchEntry, ReadonlyMap<string, boolean>>({
    source,
    computation: (next, prev) => latchReviewDecisions(prev?.value, [next]),
  });
  return computed(() => {
    const record = source().record;
    return record !== null && latch().get(record) === true;
  });
}
