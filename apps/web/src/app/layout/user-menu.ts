/**
 * Signed-in user menu — the desktop header's top-right account control (AECI-259).
 *
 * A dropdown with what belongs to the *person* rather than to the public site:
 * who they are, Account, the portal doors their role opens, and Sign out.
 *
 * ── The identity block (AECI-850) ───────────────────────────────────────────
 * The panel opens with `<aec-account-identity>` — avatar, name, email, role —
 * above a hairline, then the destinations. Anchor reference: **Laravel Cloud**
 * (`https://mobbin.com/screens/a7e6e8fb-309d-4fdd-b3c3-8658be5a7f52`), with the
 * role pill from Hootsuite; both are departures from the Stripe site-chrome
 * anchor and are recorded as such in `DESIGN.md`.
 *
 * The block exists because this menu is the only place the site says *which*
 * account is signed in. Two accounts (a personal magic-link one and a Google
 * one) look identical from a generic glyph, and on a site where role decides
 * which portal doors exist, "signed in as who, with what standing" is the first
 * question the menu should answer.
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
import { NgOptimizedImage } from '@angular/common';
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BrnPopover, BrnPopoverContent, BrnPopoverTrigger } from '@spartan-ng/brain/popover';

import { AdminStatus } from '../admin/admin-status';
import { AdminSummaryStore } from '../admin/admin-summary.store';
import { Analytics } from '../analytics/analytics';
import { AuthService } from '../auth/auth.service';
import { SessionStatus } from '../auth/session-status';
import { signOutAndGoHome } from '../auth/sign-out';
import { VendorStatus } from '../vendor/vendor-status';

import { AccountIdentity } from './account-identity';

@Component({
  selector: 'aec-user-menu',
  imports: [
    NgOptimizedImage,
    RouterLink,
    BrnPopover,
    BrnPopoverContent,
    BrnPopoverTrigger,
    AccountIdentity,
  ],
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
      <!-- The photo REPLACES the glyph rather than layering over it, and the
           glyph is the base state on purpose: the photo only lands with the
           async session snapshot, and magic-link accounts never have one, so the
           glyph is the permanent trigger for most signed-in visitors. Swapping a
           letter in here instead would flicker on every page load, because the
           email is not cached the way the role is. -->
      @if (avatarUrl(); as photo) {
        <img
          [ngSrc]="photo"
          alt=""
          aria-hidden="true"
          width="36"
          height="36"
          referrerpolicy="no-referrer"
          class="h-full w-full rounded-full object-cover"
        />
      } @else {
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
      }
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
          class="w-64 rounded-md border border-(--border-default) bg-(--surface-raised) p-2 text-(--text-primary) shadow-lg"
          i18n-aria-label="@@app.header.account.menu.aria"
          aria-label="Account menu"
        >
          <!-- Identity first, then the things you can do (AECI-850). The panel grew
               to 16rem here because an email is the widest string the panel
               carries and truncating it to ~14 characters told the reader
               nothing. -->
          <aec-account-identity />

          <!-- Destinations. The portal doors joined the Account group rather
               than keeping a rule of their own: with the identity block above,
               a per-door divider made a 14-rem panel read as four stacked
               fragments. Still one link each: the portal owns its own nav once
               you are inside it, so the header never restates either IA. Only
               one door can ever show in practice (requireVendor rejects site
               admins), but both are rendered independently rather than as an
               either/or, so neither depends on the other's gate being correct. -->
          <div class="mt-1 border-t border-(--border-default) pt-1">
            <a
              routerLink="/account"
              (click)="menu.close()"
              class="block rounded-md px-3 py-2 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              i18n="@@app.header.account"
            >
              Account
            </a>
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
  private readonly session = inject(SessionStatus);
  private readonly summaryStore = inject(AdminSummaryStore);
  private readonly auth = inject(AuthService);
  private readonly analytics = inject(Analytics);

  /** The identity-provider photo for the trigger, or null — null is the normal
   *  magic-link case and keeps the neutral glyph (AECI-850). */
  protected readonly avatarUrl = this.session.avatarUrl;

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
