import { Component, input } from '@angular/core';

import type { LockedField } from '@aeci/shared';

/**
 * The line under a field AEC Integrations corrected and locked (AECI-1237,
 * `STAGE_2_VENDOR_PORTAL_SPEC.md` §11d.5): who set it and AECi's vendor-visible
 * reason. The field itself renders read-only; the host points its
 * `aria-describedby` at `noteId`, so a screen reader hears why it cannot be edited.
 *
 * The dispute route is §11d.4's: email AEC Integrations. A lock is lifted only by
 * AECi, so the line says so rather than offering an action the vendor cannot take.
 */
@Component({
  selector: 'aec-vendor-locked-note',
  template: `
    <p
      [id]="noteId()"
      class="max-w-prose text-xs text-(--text-secondary)"
      data-testid="locked-note"
    >
      <span class="font-semibold text-(--text-primary)" i18n="@@vendor.locked.setBy"
        >Set by AEC Integrations.</span
      >
      <span i18n="@@vendor.locked.reason">Reason: {{ lock().reason }}</span>
      <span i18n="@@vendor.locked.dispute"
        >To dispute it, email AEC Integrations and quote this reason.</span
      >
    </p>
  `,
  styles: [':host { display: block; }'],
})
export class VendorLockedNote {
  readonly lock = input.required<LockedField>();
  readonly noteId = input.required<string>();
}
