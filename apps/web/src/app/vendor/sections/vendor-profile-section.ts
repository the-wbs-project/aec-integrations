import { Component, inject } from '@angular/core';

import { VendorProfileForm } from '../components/vendor-profile-form';
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
  imports: [VendorProfileForm],
  template: `
    @if (me(); as m) {
      <div>
        <h2
          class="font-display text-xl font-semibold text-(--text-primary)"
          i18n="@@vendor.section.profile"
        >
          Vendor profile
        </h2>
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
}
