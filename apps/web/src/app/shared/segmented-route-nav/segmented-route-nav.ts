import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

export interface SegmentedRouteNavItem {
  readonly path: string;
  readonly label: string;
}

/**
 * A compact secondary route control. It uses ordinary links inside a named nav
 * landmark: changing segments is navigation, not an in-page tab or a pressed
 * button state.
 */
@Component({
  selector: 'aec-segmented-route-nav',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterLink, RouterLinkActive],
  template: `
    <nav [attr.aria-label]="ariaLabel()">
      <ul
        class="m-0 flex w-fit max-w-full list-none gap-1 overflow-x-auto overflow-y-hidden rounded-(--radius-md) border border-(--border-default) bg-(--surface-sunken) p-1 whitespace-nowrap"
      >
        @for (item of items(); track item.path) {
          <li class="shrink-0">
            <a
              [routerLink]="item.path"
              [routerLinkActive]="activeClass"
              ariaCurrentWhenActive="page"
              [class]="itemClass"
            >
              {{ item.label }}
            </a>
          </li>
        }
      </ul>
    </nav>
  `,
  host: { class: 'block' },
})
export class SegmentedRouteNav {
  readonly items = input.required<readonly SegmentedRouteNavItem[]>();
  readonly ariaLabel = input.required<string>();

  protected readonly itemClass =
    'aec-segmented-route-item inline-flex min-h-9 items-center rounded-(--radius-sm) px-3 py-2 ' +
    'text-sm font-medium text-(--text-secondary) no-underline transition-colors ' +
    'hover:bg-(--surface-base) hover:text-(--text-primary) focus-visible:outline-2 ' +
    'focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)';

  protected readonly activeClass =
    'bg-(--accent-primary) font-bold text-(--surface-base) ' +
    'hover:bg-(--accent-primary) hover:text-(--surface-base)';
}
