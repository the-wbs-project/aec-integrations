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
 * order for no navigational gain (same reasoning as `admin-shell.ts`). A group
 * with `heading: null` renders as a bare list.
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
      <div class="mt-1 first:mt-0">
        @if (group.heading) {
          <p [id]="group.id" class="aec-overline px-3 pt-2 pb-1 text-(--text-secondary)">
            {{ group.heading }}
          </p>
        }
        <ul class="flex flex-col gap-0.5" [attr.aria-labelledby]="group.heading ? group.id : null">
          @for (item of group.items; track item.path) {
            <li>
              <a
                [routerLink]="item.path"
                routerLinkActive="text-(--accent-primary)"
                ariaCurrentWhenActive="page"
                (click)="navigate.emit()"
                class="flex items-center justify-between gap-3 rounded-(--radius-sm) px-3 py-1.5 text-sm text-(--text-primary) no-underline transition-colors hover:bg-(--surface-sunken) hover:text-(--accent-primary) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
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
