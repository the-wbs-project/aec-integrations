import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import type { MoreMenuGroup } from './more-menu-links';

/**
 * Presentational renderer for one or more labelled link groups in the header's
 * "More" overflow menu. Shared by the desktop flyout (`nav-more-trigger.ts`) and
 * the mobile overlay disclosure (`nav-menu.ts`), so the two surfaces can never
 * drift — the same role `NavFlyoutList` plays for the taxonomy facets.
 *
 * Renders both halves of the menu: the public groups (`moreSiteGroups()`) and,
 * for an admin, the `/admin` IA (`ADMIN_NAV_GROUPS`) — the shapes are
 * structurally identical, so one template covers both. A group heading is a
 * `<p>` wired to its `<ul>` via `aria-labelledby`, never a real heading: the
 * page already owns its heading outline and a nav-group label would break the
 * order for no navigational gain (same reasoning as `admin-shell.ts`).
 *
 * Grouping is carried by **vertical rhythm, not indentation**. Items sit on the
 * same left rail as their overline (`px-3` on both) and are separated by ~12px,
 * while a group boundary opens to ~26px — a >2:1 ratio, so proximity alone says
 * where one group ends. The admin sidebar (`admin/admin-shell.ts`) renders this
 * same data on the same principle (`space-y-6` between groups vs `space-y-1`
 * within), and the two must not drift. Indenting the links instead was
 * considered and rejected: the admin column stacks a section title over an
 * overline over its items, so an item indent would give that column three left
 * rails against the public column's two and the halves would stop aligning
 * row-for-row across the divider — and an indent reads as tree depth, which
 * these non-clickable eyebrow labels do not have.
 *
 * Items pin `font-normal` rather than inheriting. The desktop primary `<nav>`
 * sets `font-medium` on the whole row (`site-header.ts`), so an unpinned item
 * renders at 500 there and 400 in the mobile overlay — the exact drift this
 * component exists to prevent — and at 500 it sits too close to the 600 overline
 * above it for the two to read as different levels.
 *
 * Pure inputs only — no data fetching, no i18n ids (the caller supplies
 * localized labels), and no admin gating (the caller decides whether to pass the
 * admin groups at all, so nothing admin-shaped reaches cached SSR HTML).
 */
@Component({
  selector: 'aec-nav-more-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive],
  template: `
    @for (group of groups(); track group.id) {
      <div class="mt-5 first:mt-0">
        <p [id]="group.id" class="aec-overline px-3 pb-1.5 text-(--text-secondary)">
          {{ group.heading }}
        </p>
        <ul class="flex flex-col" [attr.aria-labelledby]="group.id">
          @for (item of group.items; track item.path) {
            <li>
              <a
                [routerLink]="item.path"
                routerLinkActive="text-(--accent-primary)"
                ariaCurrentWhenActive="page"
                (click)="navigate.emit()"
                class="flex items-center justify-between gap-3 rounded-(--radius-sm) px-3 py-1.5 text-sm font-normal text-(--text-primary) no-underline transition-colors hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
              >
                <span>{{ item.label }}</span>
                @if (item.badge && pendingCount() > 0) {
                  <span class="text-(--text-secondary)" aria-hidden="true"
                    >({{ pendingCount() }})</span
                  >
                  <span class="sr-only" i18n="@@admin.shell.nav.pendingCount"
                    >{{ pendingCount() }} reviews pending moderation</span
                  >
                }
              </a>
            </li>
          }
        </ul>
      </div>
    }
  `,
})
export class NavMoreList {
  readonly groups = input.required<readonly MoreMenuGroup[]>();

  /** Live pending-review count for the single `badge: true` entry. */
  readonly pendingCount = input(0);

  /**
   * Emits when any link is activated. The mobile overlay wires this to close the
   * popover after navigation; the desktop flyout ignores it (its disclosure
   * closes on the post-navigation focusout).
   */
  readonly navigate = output<void>();
}
