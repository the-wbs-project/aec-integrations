import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AdminStatus } from '../admin/admin-status';
import { Analytics } from '../analytics/analytics';
import { AuthService } from '../auth/auth.service';
import { signOutAndGoHome } from '../auth/sign-out';
import { AecButton } from '../shared/button/button';
import { AecIcon } from '../shared/icon/icon';
import { VendorStatus } from '../vendor/vendor-status';

import { AccountIdentity } from './account-identity';

/** A destination in the white panel: 16px at 400, 44px high, a Forest ring. */
const DOOR =
  'flex min-h-11 w-full cursor-pointer items-center rounded-mark text-start text-t-16 font-normal text-(--text-primary) hover:text-(--accent-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary)';

/**
 * The signed-in account block at the foot of the mobile menu (AECI-1775):
 * the identity block, then Account, the role-gated portal doors and Sign out.
 * The desktop twin is `user-menu.ts`, which carries the rationale for the doors.
 *
 * It only ever renders in the browser, after the session probe says signed in
 * (`nav-menu.ts` gates it on `SessionStatus`), so no server HTML depends on it.
 * That makes it safe to load lazily (`@defer (on immediate)`), which keeps the
 * identity block and the sign-out path out of the initial bundle. The portal
 * doors read the browser-only role probe, so neither reaches cached HTML.
 *
 * Every link is a `RouterLink`: this block never exists before hydration, so it
 * needs no pre-hydration fallback. `nav-menu.ts` closes the menu on any
 * navigation.
 */
@Component({
  selector: 'aec-nav-menu-account',
  imports: [RouterLink, AecButton, AecIcon, AccountIdentity],
  host: { class: 'flex flex-col gap-3' },
  template: `
    <!-- The same identity block as the desktop dropdown, from the same component,
         so the two headers cannot disagree about who is signed in (AECI-850). -->
    <aec-account-identity />

    <a
      aecButton
      variant="secondary"
      routerLink="/account"
      class="w-full"
      i18n="@@app.header.account"
    >
      <aec-icon name="user" decorative [size]="4" />
      Account
    </a>

    @if (adminStatus.isAdmin()) {
      <a routerLink="/admin" [class]="doorClass" i18n="@@app.header.adminPortal">Admin portal</a>
    }
    @if (vendorStatus.isVendor()) {
      <a routerLink="/vendor" [class]="doorClass" i18n="@@app.header.vendorPortal">Vendor portal</a>
    }

    <button type="button" (click)="onSignOut()" [class]="doorClass" i18n="@@app.header.signOut">
      Sign out
    </button>
    @if (signOutFailed()) {
      <p class="text-t-13 text-(--color-status-error)" i18n="@@app.header.signOut.failed">
        Couldn’t sign out. Try again.
      </p>
    }
  `,
})
export class NavMenuAccount {
  protected readonly adminStatus = inject(AdminStatus);
  protected readonly vendorStatus = inject(VendorStatus);
  private readonly auth = inject(AuthService);
  private readonly analytics = inject(Analytics);

  protected readonly doorClass = DOOR;
  protected readonly signOutFailed = signal(false);

  protected async onSignOut(): Promise<void> {
    this.signOutFailed.set(false);
    const ok = await signOutAndGoHome(this.auth, this.analytics);
    if (!ok) this.signOutFailed.set(true);
  }
}
