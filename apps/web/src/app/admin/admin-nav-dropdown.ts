import { Component, computed, inject, input } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { filter, map } from 'rxjs';

import { NavDisclosure } from '../layout/nav-disclosure';
import { ADMIN_NAV_TRIGGER_CLASS, type AdminNavGroup } from './admin-nav';
import { AdminSummaryStore, type AdminQueueKey } from './admin-summary.store';

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
 * before, in `layout/user-menu.ts` (and in the vendor portal's former Products
 * menu, retired in §6.11 of `STAGE_2_VENDOR_PORTAL_SPEC.md`).
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
 * ── THE BADGES (AECI-922) ────────────────────────────────────────────────────
 * Every entry that names a queue (`AdminNavItem.badge`) renders its OWN count,
 * and the closed trigger renders the group's SUM. Before AECI-922 there was one
 * badged entry and the trigger simply mirrored its number; with three, mirroring
 * would have to pick one queue to nag about and hide the other two behind a
 * click.
 *
 * A zero renders NOTHING, on the entry and on the trigger alike. That matches the
 * header account menu, which has always hidden its badge at zero, and it is what
 * the badge is for: an empty queue is not news, and four zeros in an open panel
 * train an operator to stop reading the numbers.
 *
 * Counts come straight from the root `AdminSummaryStore` rather than through an
 * input. The store is the seam the shell seeds and the three queue screens
 * decrement; threading three numbers through the shell would add a second place
 * for them to be wrong.
 *
 * ── THE TRIGGER CARRIES THE GROUP'S CURRENT STATE ────────────────────────────
 * A category is current when any of its screens is. `routerLinkActive` only
 * tracks an element that has a `routerLink`, and this trigger is a button, so
 * the state is derived from the router URL instead. The treatment is the same
 * `.aec-nav-tab[aria-current]` underline the links use, keyed off `aria-current`
 * in both spellings.
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

      @if (groupTotal(); as total) {
        <span
          class="inline-flex min-w-5 items-center justify-center rounded-full bg-(--accent-primary) px-1.5 py-0.5 text-xs font-bold text-(--surface-base)"
          aria-hidden="true"
          >{{ total }}</span
        >
        <span class="sr-only" i18n="@@admin.nav.pendingTotal"
          >{{ total }} items awaiting action</span
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
              @if (queueCount(item.badge); as n) {
                <span
                  class="inline-flex min-w-5 items-center justify-center rounded-full bg-(--accent-primary) px-1.5 py-0.5 text-xs font-bold text-(--surface-base)"
                  aria-hidden="true"
                  >{{ n }}</span
                >
                <span class="sr-only" i18n="@@admin.nav.pendingItem">{{ n }} awaiting action</span>
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

  private readonly summaryStore = inject(AdminSummaryStore);

  /**
   * Which edge the panel hangs from. The last category in the row needs `end`,
   * or a 14rem panel opening from a trigger two thirds of the way across a phone
   * viewport runs off the side of the screen.
   */
  readonly align = input<'start' | 'end'>('start');

  private readonly router = inject(Router);

  protected readonly panelId = computed(() => `${this.group().id}-panel`);

  /**
   * One entry's own count, or `0` when it names no queue / has nothing waiting.
   *
   * Returns a number rather than `number | null` so the template's `@if (…; as n)`
   * does the hiding: `0` is falsy, so an empty queue renders no badge at all, and
   * `n` inside the block is always a real count. An unseeded (`null`) store reads
   * as `0` for the same reason — a badge we cannot fill is a badge we should not
   * draw.
   */
  protected queueCount(key: AdminQueueKey | undefined): number {
    return key ? (this.summaryStore.count(key)() ?? 0) : 0;
  }

  /**
   * What the CLOSED trigger shows: the sum of every badged entry in this group.
   * Collapsing the panel would otherwise hide the console's only live signal,
   * which is the one thing the nav exists to nag about. `0` for a group that owns
   * no badged item, so those triggers render no badge.
   *
   * Summed over the group's own entries rather than read off
   * `AdminSummaryStore.operationsTotal()`, so the number on the trigger is by
   * construction the numbers inside the panel added up. A queue that moved to
   * another category would move its count with it.
   */
  protected readonly groupTotal = computed(() =>
    this.group().items.reduce((sum, item) => sum + this.queueCount(item.badge), 0),
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
