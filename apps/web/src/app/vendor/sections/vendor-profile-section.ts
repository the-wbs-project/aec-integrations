import { Component, afterNextRender, computed, inject } from '@angular/core';

import { VendorProfileForm } from '../components/vendor-profile-form';
import { VendorReviewStrip } from '../components/vendor-review-strip';
import { vendorCan } from '../vendor-capabilities';
import { VendorPortalStore } from '../vendor-portal-store';

/**
 * `…/profile` — the vendor's own `vendors` row, edited within the §4 allow-list.
 *
 * A routed section since the portal moved off in-page tab state; the form itself
 * is unchanged. The edit gate is the resolved `profile.edit` capability, read
 * through {@link vendorCan} so a live entitlement change unlocks (or closes) the
 * form in place.
 */
@Component({
  selector: 'aec-vendor-profile-section',
  imports: [VendorProfileForm, VendorReviewStrip],
  template: `
    @if (me(); as m) {
      <div>
        <h2
          class="font-display text-xl font-semibold text-(--text-primary)"
          i18n="@@vendor.section.profile"
        >
          Vendor profile
        </h2>
        <!-- AECI-1218: "Looks right" on the company details (section 13.8). -->
        <aec-vendor-review-strip class="mt-4" target="profile" [done]="checked()" />
        <div class="mt-4">
          <aec-vendor-profile-form [vendor]="m.vendor" [canEdit]="canEdit()" />
        </div>
      </div>
    }
  `,
  styles: [':host { display: block; }'],
})
export class VendorProfileSection {
  private readonly store = inject(VendorPortalStore);

  protected readonly me = this.store.me;
  protected readonly canEdit = vendorCan(this.store, 'profile.edit');

  /** The "Check company details" step, once the vendor checklist has loaded. */
  protected readonly checked = computed(
    () =>
      this.store
        .checklist()
        ?.steps.some((s) => s.key === 'company_details' && s.status === 'done') ?? false,
  );

  constructor() {
    afterNextRender(() => void this.store.ensureChecklist());
  }
}
