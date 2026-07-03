import { Component, computed, input } from '@angular/core';
import { BrnPopover, BrnPopoverContent, BrnPopoverTrigger } from '@spartan-ng/brain/popover';

import type { ProductPairClaim } from '@aeci/shared';

/**
 * The **AECi-annotated provenance affordance** for a claim (Stage 1.5 §8 —
 * AECI-300). A small `i` trigger per `data_object` row opens a popover
 * attributing the claim to AECi, surfacing its curation note, and closing with
 * the honest "not yet vendor-confirmed" line. Ported from the AECI-289
 * prototype, now i18n'd and reading the real `ProductPairClaim` attestations.
 *
 * `BrnPopover` (Spartan) — the popover surface is the one place a shadow is
 * allowed under DESIGN.md's borders-not-shadows rule. Opened by user click
 * (never from an `effect()` — Spartan's `open()` calls `effect()` internally),
 * keyboard-reachable and Escape-dismissable. Cache-neutral: derives only from
 * the claim payload.
 */
@Component({
  selector: 'aec-claim-provenance',
  imports: [BrnPopover, BrnPopoverContent, BrnPopoverTrigger],
  template: `
    <button
      brnPopoverTrigger
      [brnPopoverTriggerFor]="provPop"
      type="button"
      class="inline-flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-full
        text-(--text-tertiary) transition-colors hover:bg-(--surface-sunken)
        hover:text-(--text-secondary) focus-visible:outline-2 focus-visible:outline-offset-2
        focus-visible:outline-(--accent-primary)"
      [attr.aria-label]="ariaLabel()"
    >
      <span aria-hidden="true" class="text-xs font-semibold">i</span>
    </button>

    <brn-popover #provPop="brnPopover" class="contents" align="end" [sideOffset]="6">
      <ng-template brnPopoverContent>
        <div
          class="w-[min(90vw,20rem)] space-y-2 rounded-(--radius-md) border border-(--border-default)
            bg-(--surface-raised) p-4 text-(--text-primary) shadow-lg"
        >
          <h3
            class="text-xs font-semibold uppercase tracking-[0.14em] text-(--text-tertiary)"
            i18n="@@pair.claim.provenance.title"
          >
            Provenance
          </h3>
          <p
            class="text-sm font-medium text-(--text-primary)"
            i18n="@@pair.claim.provenance.primary"
          >
            Asserted by AECi
          </p>
          @if (note(); as n) {
            <p class="text-sm leading-relaxed text-(--text-secondary)">{{ n }}</p>
          }
          <p
            class="text-xs leading-relaxed text-(--text-tertiary)"
            i18n="@@pair.claim.provenance.closing"
          >
            Vendor confirmation is not available yet. It arrives with the vendor portal.
          </p>
        </div>
      </ng-template>
    </brn-popover>
  `,
})
export class ClaimProvenance {
  readonly claim = input.required<ProductPairClaim>();

  /** The AECi attestation's curation note — the only source written in 1.5. */
  protected readonly note = computed<string | null>(
    () => this.claim().attestations.find((a) => a.source === 'aeci')?.note ?? null,
  );

  protected readonly ariaLabel = computed<string>(
    () =>
      $localize`:@@pair.claim.provenance.aria:Provenance for ${this.claim().data_object_name}:name:: asserted by AECi`,
  );
}
