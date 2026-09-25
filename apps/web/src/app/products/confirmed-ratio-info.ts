import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { BrnPopover, BrnPopoverContent, BrnPopoverTrigger } from '@spartan-ng/brain/popover';

/**
 * The `i` beside the data-flow band's verification ratio ("0 of 12 confirmed by
 * both vendors", `STAGE_1_5_SPEC.md` §3.5). The ratio counts **data objects**, and
 * a reader who sees two vendors on the page cannot tell that from the number
 * alone. This popover says what the numerator means and who has to act for it
 * to move.
 *
 * Same trigger and surface as `ClaimProvenance`, so the page has one `i`
 * vocabulary. `BrnPopover` opens on click or keyboard, never from an `effect()`
 * (Spartan's `open()` calls `effect()` internally). Cache-neutral: derives only
 * from the pair payload's vendor names and counts.
 */
@Component({
  selector: 'aec-confirmed-ratio-info',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [BrnPopover, BrnPopoverContent, BrnPopoverTrigger],
  template: `
    <button
      brnPopoverTrigger
      [brnPopoverTriggerFor]="ratioPop"
      type="button"
      class="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full
        align-middle text-(--text-tertiary) transition-colors hover:bg-(--surface-sunken)
        hover:text-(--text-secondary) focus-visible:outline-2 focus-visible:outline-offset-2
        focus-visible:outline-(--accent-primary)"
      aria-label="What confirmed by both vendors means"
      i18n-aria-label="@@pair.dataflow.ratio.info.aria"
    >
      <span aria-hidden="true" class="text-xs font-semibold">i</span>
    </button>

    <brn-popover #ratioPop="brnPopover" class="contents" align="center" [sideOffset]="6">
      <ng-template brnPopoverContent>
        <div
          class="w-[min(90vw,20rem)] space-y-2 rounded-(--radius-md) border border-(--border-default)
            bg-(--surface-raised) p-4 text-start text-(--text-primary) shadow-lg"
        >
          <h3
            class="text-xs font-semibold uppercase tracking-[0.14em] text-(--text-tertiary)"
            i18n="@@pair.dataflow.ratio.info.title"
          >
            What confirmed means
          </h3>
          <p class="text-sm leading-relaxed text-(--text-secondary)">{{ confirmedLine() }}</p>
          @if (aeciOnly()) {
            <p
              class="text-sm leading-relaxed text-(--text-secondary)"
              i18n="@@pair.dataflow.ratio.info.aeci"
            >
              Until then, a flow comes from AECi’s own research.
            </p>
          }
          @if (showSingleSource()) {
            <p
              class="text-sm leading-relaxed text-(--text-secondary)"
              i18n="@@pair.dataflow.ratio.info.singleSource"
            >
              Confirmed by one vendor only means one vendor has signed off and the other has not
              responded yet.
            </p>
          }
        </div>
      </ng-template>
    </brn-popover>
  `,
})
export class ConfirmedRatioInfo {
  /** The context product's vendor name, or `null` when it has none. */
  readonly contextVendorName = input<string | null>(null);
  /** The other product's vendor name, or `null` when it has none. */
  readonly otherVendorName = input<string | null>(null);
  /** True when the ratio line carries the "confirmed by one vendor only" clause. */
  readonly showSingleSource = input(false);
  /** True while every attestation on the pair is AECi's (the band's
   *  `awaitingVendors`). Once a vendor has spoken, "comes from AECi's own
   *  research" is no longer the whole provenance, so the line is dropped. */
  readonly aeciOnly = input(false);

  protected readonly confirmedLine = computed<string>(() => {
    const a = this.contextVendorName();
    const b = this.otherVendorName();
    // Two distinct names read naturally. One company owning both endpoints, or a
    // missing vendor row, falls back to the generic phrasing rather than "Autodesk
    // and Autodesk" or an empty name.
    return a && b && a !== b
      ? $localize`:@@pair.dataflow.ratio.info.confirmed:A data object counts as confirmed once both ${a}:contextVendor: and ${b}:otherVendor: have signed off on it.`
      : $localize`:@@pair.dataflow.ratio.info.confirmed.generic:A data object counts as confirmed once both vendors have signed off on it.`;
  });
}
