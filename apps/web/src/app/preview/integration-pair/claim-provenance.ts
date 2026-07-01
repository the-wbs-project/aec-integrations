import { Component, input } from '@angular/core';
import { BrnPopover, BrnPopoverContent, BrnPopoverTrigger } from '@spartan-ng/brain/popover';

import { COPY, type ClaimView } from './integration-pair.fixtures';

/**
 * The **AECi-annotated provenance affordance** (spec §8): a small info trigger
 * per claim that opens a popover attributing the claim to AECi and surfacing its
 * curation note, plus the honest "not yet vendor-confirmed" closing line. Sole
 * owner of the provenance copy so it can't drift.
 *
 * Structure copied from the working `preview/vendor-detail/vendor-detail.html`
 * `BrnPopover` (trigger button + `brn-popover class="contents"` + a
 * `brnPopoverContent` template). The popover surface is the ONE place a shadow
 * is allowed under DESIGN.md's borders-not-shadows rule. Keyboard-reachable and
 * Escape-dismissable via Spartan's overlay behaviour.
 *
 * Prototype-only (AECI-289).
 */
@Component({
  selector: 'app-ip-claim-provenance',
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
      [attr.aria-label]="copy.provenanceAria(claim().dataObjectName)"
    >
      <span aria-hidden="true" class="text-xs font-semibold">i</span>
    </button>

    <brn-popover #provPop="brnPopover" class="contents" align="end" [sideOffset]="6">
      <ng-template brnPopoverContent>
        <div
          class="w-[min(90vw,20rem)] space-y-2 rounded-(--radius-md) border border-(--border-default)
            bg-(--surface-raised) p-4 text-(--text-primary) shadow-lg"
        >
          <h3 class="aec-overline text-(--text-tertiary)">{{ copy.provenanceTitle }}</h3>
          <p class="text-sm font-medium text-(--text-primary)">{{ copy.provenancePrimary }}</p>
          @if (claim().attestation?.note; as note) {
            <p class="text-sm leading-relaxed text-(--text-secondary)">{{ note }}</p>
          }
          <p class="text-xs leading-relaxed text-(--text-tertiary)">{{ copy.provenanceClosing }}</p>
        </div>
      </ng-template>
    </brn-popover>
  `,
})
export class ClaimProvenance {
  readonly claim = input.required<ClaimView>();
  protected readonly copy = COPY;
}
