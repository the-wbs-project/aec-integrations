import { Component, computed, inject, input } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { filter, map } from 'rxjs';

import { NavDisclosure } from '../layout/nav-disclosure';
import { ADMIN_NAV_TRIGGER_CLASS, type AdminNavGroup } from './admin-nav';

/**
 * One category in the admin console's horizontal nav (AECI-694): a disclosure
 * button that reveals its group's screens.
 *
 * The trigger is the group label (plus its pending badge) and nothing else —
 * **no arrow icon**. The public nav dropped its arrow buttons first
 * (`layout/nav-flyout-trigger.ts`), and a triangle here with none there would
 * read as two different products; `aria-haspopup` / `aria-expanded` carry the
 * disclosure to assistive tech, which is what the icon was never doing.
 *
 * ── WHY NOT `@angular/aria/menu` ─────────────────────────────────────────────
 * ADR 0010 routes new menu / menubar patterns to Angular Aria, and that rule
 * stands for APPLICATION menus (commands that act on the page). This is a
 * navigation row of router links, where `role="menu"` is the wrong semantic and
 * the WAI-ARIA practices advise against it. The codebase has made that call
 * twice already, in `layout/user-menu.ts` and `vendor/vendor-products-menu.ts`.
 * Extending `NavDisclosure` also puts this on the same open/close contract as
 * the four public-nav flyouts, which DESIGN.md requires: a row where one
 * dropdown opens on hover and another only on click reads as a bug.
 *
 * Behaviour therefore comes free from the base: hovering the host opens, leaving
 * closes, the button toggles for keyboard, Escape closes and returns focus to
 * it, and focus leaving the host closes. The panel is `[hidden]` when closed so
 * its links are never silently tabbable, and it is in flow rather than in an
 * overlay because the nav row deliberately does not scroll (see `admin-shell`).
 *
 * ── THE TRIGGER CARRIES THE GROUP'S CURRENT STATE ────────────────────────────
 * A category is current when any of its screens is. `routerLinkActive` only
 * tracks an element that has a `routerLink`, and this trigger is a button, so
 * the state is derived from the router URL instead. The treatment is the same
 * `.aec-nav-tab[aria-current]` underline the links use, keyed off `aria-current`
 * in both spellings, exactly as the vendor portal's Products menu does.
 */
@Component({
  selector: 'aec-admin-nav-dropdown',
  imports: [RouterLink, RouterLinkActive],
  host: { class: 'relative inline-flex' },
  template: `
    <button
      type="button"
      [attr.aria-expanded]="isOpen()"
      [attr.aria-controls]="panelId()"
      aria-haspopup="true"
      [attr.aria-current]="isCurrent() ? 'true' : null"
      (click)="toggle()"
      [class]="triggerClass"
    >
      <span>{{ group().heading }}</span>

      @if (badgeCount() !== null) {
        <span
          class="inline-flex min-w-5 items-center justify-center rounded-full bg-(--accent-primary) px-1.5 py-0.5 text-xs font-bold text-(--surface-base)"
          aria-hidden="true"
          >{{ badgeCount() }}</span
        >
        <span class="sr-only" i18n="@@admin.shell.nav.pendingCount"
          >{{ badgeCount() }} reviews pending moderation</span
        >
      }
    </button>

    <div
      [id]="panelId()"
      [hidden]="!isOpen()"
      class="absolute top-full z-50 pt-1"
      [class.start-0]="align() === 'start'"
      [class.end-0]="align() === 'end'"
    >
      <ul
        [attr.aria-label]="group().heading"
        class="m-0 flex w-56 list-none flex-col gap-0.5 rounded-md border border-(--border-default) bg-(--surface-raised) p-2 shadow-lg"
      >
        @for (item of group().items; track item.path) {
          <li>
            <a
              [routerLink]="item.path"
              routerLinkActive="bg-(--surface-sunken) text-(--accent-primary)"
              ariaCurrentWhenActive="page"
              class="flex items-center justify-between gap-3 rounded-(--radius-sm) px-3 py-1.5 text-sm font-normal text-(--text-primary) no-underline transition-colors hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            >
              <span>{{ item.label }}</span>
              @if (item.badge) {
                <span
                  class="inline-flex min-w-5 items-center justify-center rounded-full bg-(--accent-primary) px-1.5 py-0.5 text-xs font-bold text-(--surface-base)"
                  aria-hidden="true"
                  >{{ pendingCount() }}</span
                >
              }
            </a>
          </li>
        }
      </ul>
    </div>
  `,
})
export class AdminNavDropdown extends NavDisclosure {
  readonly group = input.required<AdminNavGroup>();

  /** Shared with the collapsed single-screen links, so the row stays one row. */
  protected readonly triggerClass = ADMIN_NAV_TRIGGER_CLASS;

  /** Live pending-review count, seeded by the shell from `AdminSummaryStore`. */
  readonly pendingCount = input.required<number>();

  /**
   * Which edge the panel hangs from. The last category in the row needs `end`,
   * or a 14rem panel opening from a trigger two thirds of the way across a phone
   * viewport runs off the side of the screen.
   */
  readonly align = input<'start' | 'end'>('start');

  private readonly router = inject(Router);

  protected readonly panelId = computed(() => `${this.group().id}-panel`);

  /**
   * Mirrored onto the closed trigger, because the pending-review count is the
   * console's only live signal and burying it inside a collapsed panel would
   * hide the one thing the nav is meant to nag about. `null` when this group
   * owns no badged item.
   */
  protected readonly badgeCount = computed(() =>
    this.group().items.some((item) => item.badge) ? this.pendingCount() : null,
  );

  /** Router URL without query or fragment, refreshed on every completed
   *  navigation. `router.url` alone is a plain property and would go stale. */
  private readonly path = toSignal(
    this.router.events.pipe(
      filter((event): event is NavigationEnd => event instanceof NavigationEnd),
      map(() => stripUrl(this.router.url)),
    ),
    { initialValue: stripUrl(this.router.url) },
  );

  protected readonly isCurrent = computed(() => {
    const current = this.path();
    return this.group().items.some(
      (item) => current === item.path || current.startsWith(`${item.path}/`),
    );
  });
}

/** Path only. `/admin/users?banned=true` (where `/admin/reviewers` redirects)
 *  must still light up the Operations category. */
function stripUrl(url: string): string {
  return url.split(/[?#]/)[0] ?? url;
}
