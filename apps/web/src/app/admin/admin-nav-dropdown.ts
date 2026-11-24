import {
  Component,
  Injectable,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { filter, map } from 'rxjs';

import { NavDisclosure } from '../layout/nav-disclosure';
import { ADMIN_NAV_TRIGGER_CLASS, type AdminNavGroup } from './admin-nav';
import {
  ADMIN_TOTAL_QUEUE_KEYS,
  AdminSummaryStore,
  type AdminQueueKey,
} from './admin-summary.store';

/**
 * Which admin category menu is open (AECI-1813). One per page: opening a category
 * closes its siblings at once, so the 260ms close grace of the one the pointer
 * just left never leaves two panels up (mock-up 14 does the same). Admin only:
 * the public Browse menu has no siblings and keeps the base behaviour.
 */
@Injectable({ providedIn: 'root' })
export class AdminNavOpenMenu {
  readonly id = signal<string | null>(null);
}

/**
 * One category in the admin console's horizontal nav (AECI-694): a disclosure
 * button that reveals its group's screens.
 *
 * The trigger is the group label (plus its pending badge) and nothing else —
 * **no arrow icon**. The public nav dropped its arrow buttons first (the
 * taxonomy flyouts, now the Browse menu in `layout/browse-menu.ts`), and a triangle here with none there would
 * read as two different products; `aria-expanded` and `aria-controls` carry the
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
 * click. The Re-index queue is the one exception: it badges its own entry and
 * stays out of the sum (`ADMIN_TOTAL_QUEUE_KEYS`).
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
      [attr.aria-current]="isCurrent() ? 'true' : null"
      (click)="toggle()"
      [class]="triggerClass"
    >
      <span>{{ group().heading }}</span>

      @if (groupTotal(); as total) {
        <span [class]="countClass" aria-hidden="true">{{ total }}</span>
        <span class="sr-only" i18n="@@admin.nav.pendingTotal"
          >{{ total }} items awaiting action</span
        >
      }
    </button>

    <!-- The panel is the shared popover: white, a hairline, 12px corners and the
         menu shadow. In flow, not an overlay, because the row does not scroll. -->
    <div
      [id]="panelId()"
      [hidden]="!isOpen()"
      class="absolute top-full z-40 pt-1"
      [class]="panelEdgeClass()"
    >
      <div class="aec-popover p-2" [class]="menuWidthClass()">
        @for (column of columns(); track column.id; let first = $first) {
          <div class="min-w-0">
            @if (column.heading) {
              <p
                [id]="column.id"
                class="px-3 pb-1 pt-2 text-t-12 font-semibold uppercase leading-[1.4] tracking-[0.08em] text-(--text-secondary)"
                [class]="first ? '' : 'max-md:mt-3'"
              >
                {{ column.heading }}
              </p>
            }
            <ul
              class="m-0 flex list-none flex-col p-0"
              [attr.aria-labelledby]="column.heading ? column.id : null"
              [attr.aria-label]="column.heading ? null : group().heading"
            >
              @for (item of column.items; track item.path) {
                <li>
                  <!-- A pressed link closes the panel, as the Browse menu's do, so it never
                       stays open over the new page. Its focus is then lost to the hidden
                       panel and RouteFocus moves it to the page h1 (AECI-1855). -->
                  <a
                    [routerLink]="item.path"
                    routerLinkActive="bg-(--surface-sunken) font-semibold text-(--accent-primary)"
                    ariaCurrentWhenActive="page"
                    (click)="close()"
                    class="flex min-h-10 items-center justify-between gap-3 rounded-mark px-3 py-2 text-t-14 font-normal text-(--text-primary) no-underline transition-colors duration-fast hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-3 focus-visible:outline-offset-0"
                  >
                    <span>{{ item.label }}</span>
                    @if (queueCount(item.badge); as n) {
                      <span [class]="countClass" aria-hidden="true">{{ n }}</span>
                      <span class="sr-only" i18n="@@admin.nav.pendingItem"
                        >{{ n }} awaiting action</span
                      >
                    }
                  </a>
                </li>
              }
            </ul>
          </div>
        }
      </div>
    </div>
  `,
})
export class AdminNavDropdown extends NavDisclosure {
  readonly group = input.required<AdminNavGroup>();

  /**
   * Leaving the category closes it after 260ms, the public Browse menu's grace
   * (ruled 2026-11-24), so the pointer can cross the gap to the panel (WCAG
   * 1.4.13 "hoverable"). A pressed link still closes it at once.
   */
  protected override readonly closeGraceMs = 260;

  /**
   * The count pill: the chip's `count` tone (`shared/chip`), written out here
   * because it sits inside a link or a button and is not a chip of its own.
   * Forced colours draw its edge, since the Forest fill drops out there.
   */
  protected readonly countClass =
    'inline-flex h-6 min-w-6 shrink-0 items-center justify-center rounded-pill bg-(--accent-primary) px-2 text-t-13 font-semibold leading-none tabular-nums text-(--surface-base) forced-colors:border forced-colors:border-[CanvasText]';

  /** The panel's columns: the group's labelled ones, or one unlabelled list. */
  protected readonly columns = computed(
    () =>
      this.group().columns ?? [
        { id: `${this.group().id}-list`, heading: '', items: this.group().items },
      ],
  );

  /** One column is 16rem. Two are 26rem at md and 34rem from lg, and one stacked
   *  column below md, kept inside a phone's viewport. 26rem at md keeps the panel
   *  inside a 768px window: it hangs from the Operations trigger, about 250px in. */
  protected readonly menuWidthClass = computed(() =>
    this.columns().length > 1
      ? 'grid w-[min(18rem,calc(100vw-48px))] gap-x-4 md:w-[26rem] md:grid-cols-2 lg:w-[34rem]'
      : 'w-64',
  );

  /** `end` hangs the panel from the trigger's end edge, which the last category
   *  needs on a phone. From md a two-column panel has room to the right of its
   *  trigger, so it hangs from the start like the others. */
  protected readonly panelEdgeClass = computed(() => {
    if (this.align() === 'start') return 'start-0';
    return this.columns().length > 1 ? 'end-0 md:start-0 md:end-auto' : 'end-0';
  });

  /** Shared with the collapsed single-screen links, so the row stays one row. */
  protected readonly triggerClass = ADMIN_NAV_TRIGGER_CLASS;

  private readonly summaryStore = inject(AdminSummaryStore);

  /**
   * Which edge the panel hangs from. The last category in the row needs `end`,
   * or a 16rem or wider panel opening from a trigger two thirds of the way across a phone
   * viewport runs off the side of the screen.
   */
  readonly align = input<'start' | 'end'>('start');

  private readonly router = inject(Router);
  private readonly openMenu = inject(AdminNavOpenMenu);

  constructor() {
    super();
    // However this category opened (hover, focus, click, keyboard), it claims
    // the one open slot, and any sibling that holds it closes, grace or not.
    effect(() => {
      if (this.isOpen()) untracked(() => this.openMenu.id.set(this.group().id));
    });
    effect(() => {
      const open = this.openMenu.id();
      untracked(() => {
        if (open !== null && open !== this.group().id && this.isOpen()) this.close();
      });
    });
  }

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
   * What the CLOSED trigger shows: the sum of this group's badged entries, leaving
   * out any queue not in `ADMIN_TOTAL_QUEUE_KEYS`. Collapsing the panel would
   * otherwise hide the console's only live signal, which is the one thing the nav
   * exists to nag about. `0` for a group that owns no badged item, so those
   * triggers render no badge.
   *
   * Summed over the group's own entries rather than read off
   * `AdminSummaryStore.operationsTotal()`, so a queue that moved to another
   * category would move its count with it.
   */
  protected readonly groupTotal = computed(() =>
    this.group().items.reduce(
      (sum, { badge }) =>
        sum + (badge && ADMIN_TOTAL_QUEUE_KEYS.includes(badge) ? this.queueCount(badge) : 0),
      0,
    ),
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
