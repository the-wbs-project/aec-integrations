/**
 * Signed-in user menu — the desktop header's top-right account control (AECI-259).
 *
 * Replaces the former plain "→ /account" icon link with a dropdown:
 *   Account  →  (admin only) Admin: Review queue (N) · Reviewer bans  →  Sign out
 *
 * The trigger also carries a red pending-review badge for admins: a count pill
 * (capped at "9+") shown only when `AdminStatus.isAdmin()` and there are pending
 * reviews. The count comes from the shared root `AdminSummaryStore`, so it ticks
 * down live as `ReviewQueue` moderates (and re-seeds on a fresh `/admin` visit).
 *
 * Admin affordances are gated on `AdminStatus.isAdmin()`, which is `false` during
 * SSR / pre-hydration (cache-neutral, §8) and only flips after the browser-only
 * probe — so this component renders the same visitor-state-neutral icon for the
 * cached HTML and reveals the badge/admin section client-side. The component is
 * only mounted when `SessionStatus.signedIn()` is true (the parent header guards
 * it), mirroring the former account link.
 *
 * The dropdown uses `BrnPopover` (extends `BrnDialog`) — the same primitive as
 * `nav-menu.ts`: CDK overlay, focus trap, Escape / outside-click close, focus
 * return to the trigger, and automatic `aria-haspopup`/`aria-expanded`/
 * `aria-controls` on the trigger. The content (links + a sign-out button) lives
 * in an `ng-template` that only mounts on click, so SSR renders just the static
 * trigger. We keep it a plain list of focusable controls inside the focus trap
 * (no `role="menu"`/roving tabindex) — same approach as the nav overlay.
 */
import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { BrnPopover, BrnPopoverContent, BrnPopoverTrigger } from '@spartan-ng/brain/popover';

import { AdminStatus } from '../admin/admin-status';
import { AdminSummaryStore } from '../admin/admin-summary.store';
import { AuthService } from '../auth/auth.service';
import { signOutAndGoHome } from '../auth/sign-out';

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
          class="absolute -end-1 -top-1 inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-full px-1 text-[0.625rem] font-bold leading-none text-(--surface-base) ring-2 ring-(--surface-base) bg-(--color-status-error)"
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

          @if (adminStatus.isAdmin()) {
            <div class="mt-1 border-t border-(--border-default) pt-1">
              <p
                class="aec-overline px-3 py-1 text-(--text-secondary)"
                i18n="@@admin.shell.eyebrow"
              >
                Admin
              </p>
              <a
                routerLink="/admin/reviews"
                (click)="menu.close()"
                class="flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              >
                <span i18n="@@admin.shell.nav.reviews">Review queue</span>
                @if (pending() > 0) {
                  <span class="text-(--text-secondary)" aria-hidden="true">({{ pending() }})</span>
                }
              </a>
              <a
                routerLink="/admin/reviewers"
                (click)="menu.close()"
                class="block rounded-md px-3 py-2 text-sm font-medium text-(--text-primary) hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
                i18n="@@admin.shell.nav.reviewers"
              >
                Reviewer bans
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
  protected readonly adminStatus = inject(AdminStatus);
  private readonly summaryStore = inject(AdminSummaryStore);
  private readonly auth = inject(AuthService);

  /** Live pending-review count (0 until the admin probe seeds the store). */
  protected readonly pending = computed(() => this.summaryStore.pendingReviews() ?? 0);

  /** The red icon badge shows only for an admin with pending reviews. */
  protected readonly showBadge = computed(() => this.adminStatus.isAdmin() && this.pending() > 0);

  /** Capped so the badge can't grow unbounded; the in-menu "(N)" stays exact. */
  protected readonly badgeText = computed(() =>
    this.pending() > 9 ? '9+' : String(this.pending()),
  );

  protected readonly signOutFailed = signal(false);

  protected async onSignOut(): Promise<void> {
    this.signOutFailed.set(false);
    // On success the browser navigates to "/" (hard redirect); on failure keep
    // the menu open and surface a retryable notice.
    const ok = await signOutAndGoHome(this.auth);
    if (!ok) this.signOutFailed.set(true);
  }
}
