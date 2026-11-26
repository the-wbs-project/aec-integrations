import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * One crumb. Give it a `link` and it is an ancestor. Leave `link` out and it is
 * text: the page you are on, or a level that has no route behind it.
 */
export interface BreadcrumbItem {
  readonly label: string;
  /** A router link: a path string or a commands array. */
  readonly link?: string | unknown[] | undefined;
  readonly fragment?: string;
}

/** The "Home" crumb every public trail starts with. */
export function homeCrumb(): BreadcrumbItem {
  return { label: $localize`:@@shared.breadcrumb.home:Home`, link: '/' };
}

/**
 * AECI-1777 - the one breadcrumb (DESIGN.md §5 "The breadcrumb", clash 31).
 *
 * A `nav` named "Breadcrumb" holding an ordered list. Ancestors are links. The
 * last item is text with `aria-current="page"`, unless it carries a link: the
 * docs top bar ends an article's trail on its section link, because the `h1`
 * names the page, and then nothing is current. The separator is `›`, hidden from
 * assistive technology. It is a divider and not a direction, so it is not an
 * arrow (DESIGN.md "The Arrow Rule").
 *
 * `tone="on-brand"` is for a Forest ground (the hero band's `heroCrumbs` slot):
 * links and separator take `--text-on-brand-secondary` (7.96:1 on Forest),
 * hover underlines and goes to Bone, and the ring is Bone. `truncate` keeps the
 * trail on one line with an ellipsis, for the docs top bar. The default wraps.
 *
 * It reads no visitor state, so it is safe in cached SSR HTML. The vendor portal
 * shell (`vendor/vendor-dashboard-tabbed.ts`, AECI-1809) and the admin console
 * (`admin/admin-breadcrumb.ts`, AECI-1813) render it too.
 */
@Component({
  selector: 'aec-breadcrumb',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block min-w-0' },
  template: `
    <nav i18n-aria-label="@@shared.breadcrumb.aria" aria-label="Breadcrumb" class="min-w-0">
      <ol
        class="m-0 flex min-w-0 list-none items-center gap-2 p-0 text-t-14"
        [class.flex-wrap]="!truncate()"
        [class.flex-nowrap]="truncate()"
      >
        @for (item of items(); track $index; let first = $first; let last = $last) {
          <li class="flex min-w-0 items-center gap-2">
            @if (!first) {
              <span aria-hidden="true" [class]="separatorClass()">›</span>
            }
            @if (item.link !== undefined) {
              <a
                [routerLink]="item.link"
                [fragment]="item.fragment"
                class="rounded-mark underline-offset-3 hover:underline focus-visible:outline-3 focus-visible:outline-offset-3"
                [class]="linkClass()"
                >{{ item.label }}</a
              >
            } @else if (last) {
              <span aria-current="page" [class]="currentClass()">{{ item.label }}</span>
            } @else {
              <span [class]="textClass()">{{ item.label }}</span>
            }
          </li>
        }
      </ol>
    </nav>
  `,
})
export class AecBreadcrumb {
  readonly items = input.required<readonly BreadcrumbItem[]>();
  readonly tone = input<'default' | 'on-brand'>('default');
  readonly truncate = input(false);

  private readonly onBrand = computed(() => this.tone() === 'on-brand');
  private readonly fit = computed(() => (this.truncate() ? 'truncate' : 'min-w-0 break-words'));

  protected readonly separatorClass = computed(() =>
    this.onBrand() ? 'text-(--text-on-brand-secondary)' : 'text-(--text-tertiary)',
  );

  protected readonly linkClass = computed(() =>
    this.onBrand()
      ? `text-(--text-on-brand-secondary) hover:text-(--text-on-brand) focus-visible:outline-(--focus-ring-on-brand) ${this.fit()}`
      : `text-(--text-secondary) hover:text-(--text-primary) ${this.fit()}`,
  );

  protected readonly textClass = computed(
    () =>
      `${this.onBrand() ? 'text-(--text-on-brand-secondary)' : 'text-(--text-secondary)'} ${this.fit()}`,
  );

  protected readonly currentClass = computed(
    () => `${this.onBrand() ? 'text-(--text-on-brand)' : 'text-(--text-primary)'} ${this.fit()}`,
  );
}
