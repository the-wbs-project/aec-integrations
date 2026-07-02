import { Component, computed, input } from '@angular/core';

import type { AgreementState } from '@aeci/shared';

/**
 * The agreement pill for a `data_object` claim on the pair page (Stage 1.5 §8 —
 * AECI-300). Ported from the AECI-289 prototype badge, now i18n'd and
 * state-driven.
 *
 * In Stage 1.5 every claim is AECi-only, so the only reachable state is
 * `unverified` and this renders the neutral **"Unverified · AECi"** pill — read
 * as *"not yet vendor-confirmed"*, never a warning/defect (the AECi-never-red
 * rule, §3.4). It uses the standard chip tokens (`--border-default` /
 * `--surface-raised` / `--text-secondary`) — no red/status hue. The dot is
 * decorative; the meaning rides on the `aria-label`. The `confirmed`/`conflict`
 * copy is defined so the Stage 2 portal (AECI-302) has a seam, but those states
 * are unreachable — and still neutral — until Stage 2 designs their tone.
 */
@Component({
  selector: 'aec-agreement-badge',
  template: `
    <span
      class="inline-flex items-center gap-1.5 rounded-(--radius-sm) border border-(--border-default)
        bg-(--surface-raised) px-2.5 py-1 text-[0.75rem] font-medium tracking-[0.01em]
        text-(--text-secondary)"
      [attr.aria-label]="ariaLabel()"
    >
      <span aria-hidden="true" class="h-1.5 w-1.5 rounded-full bg-(--text-tertiary)"></span>
      {{ label() }}
    </span>
  `,
})
export class AgreementBadge {
  readonly agreement = input.required<AgreementState>();

  protected readonly label = computed<string>(() => {
    switch (this.agreement()) {
      case 'confirmed':
        return $localize`:@@pair.claim.badge.confirmed:Vendor-confirmed`;
      case 'conflict':
        return $localize`:@@pair.claim.badge.conflict:Needs review`;
      default:
        return $localize`:@@pair.claim.badge.unverified:Unverified · AECi`;
    }
  });

  protected readonly ariaLabel = computed<string>(() => {
    switch (this.agreement()) {
      case 'confirmed':
        return $localize`:@@pair.claim.badge.confirmed.aria:Vendor-confirmed.`;
      case 'conflict':
        return $localize`:@@pair.claim.badge.conflict.aria:Vendors disagree about this data flow.`;
      default:
        return $localize`:@@pair.claim.badge.unverified.aria:Unverified. Asserted by AECi, not yet vendor-confirmed.`;
    }
  });
}
