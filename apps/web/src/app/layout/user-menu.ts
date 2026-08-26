/**
 * Signed-in user menu — the desktop header's top-right account control (AECI-259).
 *
 * A dropdown with the two things that belong to the *person* rather than the
 * site: Account → Sign out.
 *
 * The admin block (Review queue / Reviewer bans) and the pending-review badge
 * used to live here. They moved to the header's "More" overflow menu
 * (`nav-more-trigger.ts`), which now carries the complete nine-screen `/admin`
 * IA from `admin/admin-nav.ts` rather than two hand-picked links — so admin
 * navigation sits with the rest of site navigation, and this menu stays about
 * the signed-in user. The badge followed the Review-queue link onto that
 * trigger.
 *
 * The component is only mounted when `SessionStatus.signedIn()` is true (the
 * parent header guards it), mirroring the former account link. Nothing here is
 * visitor-state-dependent beyond that mount, so the cached SSR HTML renders the
 * neutral "Sign in" CTA instead (§8).
 *
 * The dropdown uses `BrnPopover` (extends `BrnDialog`) — the same primitive as
 * `nav-menu.ts`: CDK overlay, focus trap, Escape / outside-click close, focus
 * return to the trigger, and automatic `aria-haspopup`/`aria-expanded`/
 * `aria-controls` on the trigger. The content (a link + a sign-out button) lives
 * in an `ng-template` that only mounts on click, so SSR renders just the static
 * trigger. We keep it a plain list of focusable controls inside the focus trap
 * (no `role="menu"`/roving tabindex) — same approach as the nav overlay.
 */
import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BrnPopover, BrnPopoverContent, BrnPopoverTrigger } from '@spartan-ng/brain/popover';

import { Analytics } from '../analytics/analytics';
import { AuthService } from '../auth/auth.service';
import { signOutAndGoHome } from '../auth/sign-out';
import { VendorStatus } from '../vendor/vendor-status';

@Component({
  selector: 'aec-user-menu',
  imports: [RouterLink, BrnPopover, BrnPopoverContent, BrnPopoverTrigger],
  template: `
    <button
      brnPopoverTrigger
      [brnPopoverTriggerFor]="menu"
      type="button"
      class="relative inline-flex h-9 w-9 cursor-pointer items-center justify-center rounded-full border border-(--border-strong) bg-(--surface-raised) text-(--text-primary) transition-colors hover:border-(--accent-primary) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
      aria-label="Account menu"
      i18n-aria-label="@@app.header.account.menu.aria"
    >
      <svg
        aria-hidden="true"
        class="h-5 w-5"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
    </button>

    <brn-popover #menu="brnPopover" class="contents" align="end" [sideOffset]="8">
      <ng-template brnPopoverContent>
        <div
          class="w-56 rounded-md border border-(--border-default) bg-(--surface-raised) p-2 text-(--text-primary) shadow-lg"
          i18n-aria-label="@@app.header.account.menu.aria"
          aria-label="Account menu"
        >
          <a
            routerLink="/account"
            (click)="menu.close()"
            class="block rounded-md px-3 py-2 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n="@@app.header.account"
          >
            Account
          </a>

          <!-- The admin block moved to the header "More" menu (AECI-572), which
               renders the full /admin IA from ADMIN_NAV_GROUPS. The vendor
               portal is not an admin screen and stays here (AECI-522). -->
          @if (vendorStatus.isVendor()) {
            <div class="mt-1 border-t border-(--border-default) pt-1">
              <a
                routerLink="/vendor"
                (click)="menu.close()"
                class="block rounded-md px-3 py-2 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                i18n="@@app.header.vendorPortal"
              >
                Vendor portal
              </a>
            </div>
          }

          <div class="mt-1 border-t border-(--border-default) pt-1">
            <button
              type="button"
              (click)="onSignOut()"
              class="block w-full cursor-pointer rounded-md px-3 py-2 text-start text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              i18n="@@app.header.signOut"
            >
              Sign out
            </button>
            @if (signOutFailed()) {
              <p
                class="px-3 py-1 text-xs text-(--color-status-error)"
                i18n="@@app.header.signOut.failed"
              >
                Couldn’t sign out. Try again.
              </p>
            }
          </div>
        </div>
      </ng-template>
    </brn-popover>
  `,
})
export class UserMenu {
  protected readonly vendorStatus = inject(VendorStatus);
  private readonly auth = inject(AuthService);
  private readonly analytics = inject(Analytics);

  protected readonly signOutFailed = signal(false);

  protected async onSignOut(): Promise<void> {
    this.signOutFailed.set(false);
    // On success the browser navigates to "/" (hard redirect); on failure keep
    // the menu open and surface a retryable notice.
    const ok = await signOutAndGoHome(this.auth, this.analytics);
    if (!ok) this.signOutFailed.set(true);
  }
}
