import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import {
  Component,
  DestroyRef,
  PLATFORM_ID,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';

import { injectInPageHrefFor } from '../shared/in-page-href';

import { groupDomId, type IntegrationCategoryGroup } from './integration-category-groups';
import { ProductIntegrationCategoryGroup } from './product-integration-category-group';

/**
 * AECI-1783: the long integration list in its default arrangement, grouped by partner
 * category with a jump rail (ruling R3 decision 20, ruling R5 departure 2).
 *
 * **The rail.** One `<nav>` with one link per group, in group order, each with the
 * group's count. From `lg` it is a sticky panel in the left column, held below the
 * page's sticky section bar by `--aec-sticky-offset` (`styles.css`). Below `lg` the
 * same list is a row of pill links that scrolls sideways, as mock-up 7 draws it, so
 * it never pushes the groups a long way down a phone screen. Each link is a plain
 * in-page anchor, so the jump works before hydration and with no JS, and a click
 * also moves focus to the group's heading, so a keyboard or screen-reader user lands
 * where the page scrolled.
 *
 * **The current group** is marked with `aria-current="location"` and the Forest fill,
 * as the section bar marks its current item. The first group is current until the
 * reader scrolls, so the server HTML is the same for every visitor.
 *
 * **No `@defer`.** Every group renders and hydrates with the page. A deferred group
 * that was still dehydrated when the reader filtered stayed in the DOM as a stale
 * copy with duplicate ids. After a client-side navigation its rail link pointed at a
 * placeholder. And a find-in-page match in it was hidden again when it hydrated. The
 * cards are all in the server HTML either way (AECI-1783 review).
 */
@Component({
  selector: 'aec-product-integration-groups',
  imports: [ProductIntegrationCategoryGroup],
  host: { class: 'block' },
  template: `
    <div class="lg:grid lg:grid-cols-[15.75rem_minmax(0,1fr)] lg:items-start lg:gap-8">
      <nav
        aria-labelledby="integrations-rail-title"
        class="mb-6 min-w-0 lg:sticky lg:top-[calc(var(--aec-sticky-offset)+1.5rem)] lg:mb-0 lg:max-h-[calc(100dvh-var(--aec-sticky-offset)-3rem)] lg:overflow-y-auto lg:rounded-card lg:bg-(--surface-sunken) lg:p-3"
        data-testid="integrations-rail"
      >
        <p
          id="integrations-rail-title"
          class="aec-overline mb-2 text-(--text-secondary) lg:px-2 lg:pt-1"
          i18n="@@products.detail.body.integrations.rail.title"
        >
          Jump to a category
        </p>
        <ul
          role="list"
          class="-mx-1 flex gap-2 overflow-x-auto p-1 lg:mx-0 lg:flex-col lg:gap-0.5 lg:overflow-visible lg:p-0"
        >
          @for (group of groups(); track group.key) {
            <li class="shrink-0">
              <a
                [href]="hrefFor()(domId(group.key))"
                data-smooth-scroll
                [attr.aria-current]="currentKey() === group.key ? 'location' : null"
                (click)="jump(group.key)"
                class="relative flex min-h-11 items-center gap-3 rounded-pill border bg-(--surface-raised) px-4 text-t-14 font-semibold text-(--text-primary) transition-colors hover:text-(--accent-primary) focus-visible:outline-3 focus-visible:outline-offset-3 focus-visible:outline-(--accent-primary) aria-[current=location]:bg-(--accent-primary) aria-[current=location]:text-(--text-on-brand) lg:rounded-control lg:border-0 lg:bg-transparent lg:px-3 lg:hover:bg-(--surface-raised) lg:aria-[current=location]:bg-(--accent-primary)"
                data-testid="integrations-rail-link"
              >
                <span class="whitespace-nowrap lg:flex-1 lg:whitespace-normal">{{
                  groupName(group)
                }}</span>
                <span class="font-normal tabular-nums" aria-hidden="true">{{
                  group.rows.length
                }}</span>
                <span class="sr-only">{{ countLabel(group.rows.length) }}</span>
              </a>
            </li>
          }
        </ul>
      </nav>

      <div class="min-w-0 space-y-12">
        @for (group of groups(); track group.key) {
          <section
            aec-product-integration-category-group
            [group]="group"
            [contextSlug]="contextSlug()"
            [forceOpen]="forceOpen()"
          ></section>
        }
      </div>
    </div>
  `,
})
export class ProductIntegrationGroups {
  private readonly document = inject(DOCUMENT);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly destroyRef = inject(DestroyRef);

  /** The category groups, already in group order. */
  readonly groups = input.required<readonly IntegrationCategoryGroup[]>();
  /** This page's product slug; the pair-page context on every card. */
  readonly contextSlug = input.required<string>();
  /** Open every group and drop the buttons (a short filtered list). */
  readonly forceOpen = input(false);

  protected readonly hrefFor = injectInPageHrefFor();

  /** The group the reader is in. `null` means the first, which is the server's answer. */
  private readonly spied = signal<string | null>(null);

  protected readonly currentKey = computed(() => {
    const groups = this.groups();
    const spied = this.spied();
    if (spied !== null && groups.some((group) => group.key === spied)) return spied;
    return groups[0]?.key ?? null;
  });

  protected readonly domId = groupDomId;

  constructor() {
    if (!this.isBrowser) return;
    const view = this.document.defaultView;
    if (!view) return;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = view.requestAnimationFrame(() => {
        frame = 0;
        this.spy();
      });
    };
    afterNextRender(() => {
      view.addEventListener('scroll', onScroll, { passive: true });
      this.spy();
    });
    this.destroyRef.onDestroy(() => {
      view.removeEventListener('scroll', onScroll);
      if (frame) view.cancelAnimationFrame(frame);
    });
  }

  protected groupName(group: IntegrationCategoryGroup): string {
    return (
      group.category?.name ??
      $localize`:@@products.detail.body.integrations.group.uncategorised:No category on record`
    );
  }

  protected countLabel(total: number): string {
    return total === 1
      ? $localize`:@@products.detail.body.integrations.group.count.one:1 integration`
      : $localize`:@@products.detail.body.integrations.group.count:${total}:count: integrations`;
  }

  /**
   * The anchor does the jump. Focus follows once the browser has started it, with
   * `preventScroll` so the focus call does not fight the scroll.
   */
  protected jump(key: string): void {
    this.spied.set(key);
    const heading = this.document.getElementById(`${groupDomId(key)}-title`);
    setTimeout(() => heading?.focus({ preventScroll: true }));
  }

  /** The last group whose top has passed under the sticky bar, or the first. */
  private spy(): void {
    const line = this.stickyOffset() + 48;
    let current: string | null = null;
    for (const group of this.groups()) {
      const element = this.document.getElementById(groupDomId(group.key));
      if (element && element.getBoundingClientRect().top <= line) current = group.key;
    }
    this.spied.set(current);
  }

  /** The section bar's height, which `--aec-sticky-offset` also holds. */
  private stickyOffset(): number {
    const nav = this.document.querySelector('aec-section-nav');
    return nav instanceof HTMLElement ? nav.getBoundingClientRect().height : 0;
  }
}
