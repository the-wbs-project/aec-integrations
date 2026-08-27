/**
 * Signed-in user menu — the desktop header's top-right account control (AECI-259).
 *
 * A dropdown with what belongs to the *person* rather than to the public site:
 * Account, the portal doors their role opens, and Sign out.
 *
 * ── Why the portal doors live here ───────────────────────────────────────────
 * The primary row is the *public directory's* navigation: it renders on cached,
 * indexable pages and its width is budgeted and closed (`DESIGN.md` §Navigation).
 * `/admin` and `/vendor` are private, `noindex`, role-gated surfaces, so a door
 * to either in that row would make the row's width depend on who is looking.
 * This menu is already the viewer-dependent region of the header — it only mounts
 * when signed in — which makes the header parse cleanly: **the row is the site;
 * the avatar is you and what you can operate.**
 *
 * Each door is ONE link. Both portals own their own navigation once you are
 * inside them (`admin/admin-shell.ts` renders `ADMIN_NAV_GROUPS`;
 * `vendor/vendor-portal-nav.ts` renders `VENDOR_NAV_ITEMS`), so the header does
 * not restate either IA. An earlier iteration duplicated the whole eleven-screen
 * `/admin` list into the header's "More" overflow menu; that menu is gone and its
 * public destinations now live in the footer.
 *
 * The pending-review badge sits on this menu's trigger, following the Admin door.
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
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BrnPopover, BrnPopoverContent, BrnPopoverTrigger } from '@spartan-ng/brain/popover';

import { AdminStatus } from '../admin/admin-status';
import { AdminSummaryStore } from '../admin/admin-summary.store';
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
      [attr.aria-describedby]="showBadge() ? 'aec-user-menu-pending' : null"
      (click)="adminStatus.ensureProbed()"
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
      @if (showBadge()) {
        <span
          class="absolute -end-2 -top-2 inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full px-1 text-[0.625rem] font-bold leading-none text-(--surface-base) ring-2 ring-(--surface-base) bg-(--color-status-error)"
          aria-hidden="true"
          >{{ badgeText() }}</span
        >
        <span id="aec-user-menu-pending" class="sr-only" i18n="@@admin.shell.nav.pendingCount"
          >{{ pending() }} reviews pending moderation</span
        >
      }
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

          <!-- The portal doors. One link each: the portal owns its own nav once
               you are inside it, so the header never restates either IA. Only
               one can ever show in practice (requireVendor rejects site admins),
               but both are rendered independently rather than as an either/or,
               so neither depends on the other's gate being correct. -->
          @if (adminStatus.isAdmin() || vendorStatus.isVendor()) {
            <div class="mt-1 border-t border-(--border-default) pt-1">
              @if (adminStatus.isAdmin()) {
                <a
                  routerLink="/admin"
                  (click)="menu.close()"
                  class="block rounded-md px-3 py-2 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  i18n="@@app.header.adminPortal"
                >
                  Admin portal
                </a>
              }
              @if (vendorStatus.isVendor()) {
                <a
                  routerLink="/vendor"
                  (click)="menu.close()"
                  class="block rounded-md px-3 py-2 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                  i18n="@@app.header.vendorPortal"
                >
                  Vendor portal
                </a>
              }
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
  protected readonly adminStatus = inject(AdminStatus);
  protected readonly vendorStatus = inject(VendorStatus);
  private readonly summaryStore = inject(AdminSummaryStore);
  private readonly auth = inject(AuthService);
  private readonly analytics = inject(Analytics);

  protected readonly signOutFailed = signal(false);

  /** Live pending-review count (0 until the shared role probe seeds the store). */
  protected readonly pending = computed(() => this.summaryStore.pendingReviews() ?? 0);

  /** The badge shows only for an admin with pending reviews. */
  protected readonly showBadge = computed(() => this.adminStatus.isAdmin() && this.pending() > 0);

  /** Capped so the badge can't grow unbounded. */
  protected readonly badgeText = computed(() =>
    this.pending() > 9 ? '9+' : String(this.pending()),
  );

  protected async onSignOut(): Promise<void> {
    this.signOutFailed.set(false);
    // On success the browser navigates to "/" (hard redirect); on failure keep
    // the menu open and surface a retryable notice.
    const ok = await signOutAndGoHome(this.auth, this.analytics);
    if (!ok) this.signOutFailed.set(true);
  }
}
