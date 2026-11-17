import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';

import { AecButton } from '../shared/button/button';

import { hubCut, type CategoryHubEntry } from './category-hub';

/**
 * AECI-1787 - the product hero's category hub (ruling R3 decision 1, AECI-1734: "The hero
 * ring becomes a category hub with a pair finder under it"). It replaces the mock-ups'
 * ring of partner logos. It shows the partner categories of the product's integrations,
 * each with how many integrations reach a partner in it (`categoryHub`). It features no
 * product, so it needs no logo and no ranking.
 *
 * DESIGN.md §5 "The hero diagram (clash 35)":
 *  - real records only: every entry comes from the resolved payload;
 *  - static in the server HTML, and it reads as a plain list with no script;
 *  - a text equivalent: the list IS the text. A screen reader hears a list named by the
 *    heading, then each category with its count;
 *  - position implies no ranking: A to Z by name (ruling R1), never by count;
 *  - one entrance, once: the list fades and rises over `--duration-slow` with
 *    `--ease-standard` (`.aec-category-hub` in `styles.css`). It runs only under
 *    `prefers-reduced-motion: no-preference`, it moves nothing in layout (opacity and
 *    transform only), and hydration reuses the server's nodes, so it does not replay.
 *
 * From `lg` the entries wrap in the hero's right column. Below `lg` the panel stacks
 * under the hero text, so the entries stay on one row that scrolls sideways, the
 * mock-up's own pattern for its category jump chips at narrow widths (mock-up 7,
 * `.jump`). That keeps the hero one row taller whatever the count. While the row
 * overflows it takes a tab stop, so a keyboard can scroll it (axe
 * `scrollable-region-focusable`). It drops the stop when everything fits. The list is
 * `relative` so it contains the `sr-only` counts, which are absolutely positioned.
 * Without that, under reduced motion (no entrance transform) they escaped the row and
 * the whole page scrolled sideways.
 *
 * Many categories (ruling 59, option A, 2026-11-16). From `lg` the list shows the first
 * eight entries of the A to Z order (`hubCut`) and a "Show all {n} categories" button
 * reveals the rest in place, then "Show fewer" collapses them again. Every entry is in
 * the server HTML, which always renders the collapsed state. A collapsed entry is
 * `lg:hidden` (display none), so it is neither focusable nor announced until revealed.
 * The button is a real `button` with `aria-expanded` and `aria-controls`. Only its label
 * changes, so focus stays on it. Below `lg` the one sideways row keeps every entry and
 * there is no button. With eight or fewer entries there is no button anywhere.
 *
 * The caller renders it only with at least one entry. The zero state is the facts
 * card's ("We have no integrations for {product} on record"), right below the hero.
 */
@Component({
  selector: 'aec-product-category-hub',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [AecButton],
  host: { class: 'block' },
  template: `
    <h2 id="product-category-hub-title" class="m-0" data-testid="product-category-hub-title">
      <span
        class="text-t-16 font-semibold text-(--text-on-brand)"
        i18n="@@products.detail.hero.hub.heading"
        >Integrations by partner category</span
      >
    </h2>
    <ul
      #list
      id="product-category-hub-list"
      class="aec-category-hub relative mt-4 flex gap-2 max-lg:overflow-x-auto max-lg:pb-1 lg:flex-wrap"
      role="list"
      aria-labelledby="product-category-hub-title"
      [attr.tabindex]="overflowing() ? 0 : null"
      data-testid="product-category-hub"
    >
      @for (entry of entries(); track entry.slug) {
        <li
          class="inline-flex shrink-0 items-center gap-3 rounded-pill border aec-on-brand-rule bg-(--surface-on-brand-wash) py-1 ps-1 pe-4 whitespace-nowrap lg:max-w-full lg:shrink lg:whitespace-normal"
          [class.lg:hidden]="$index >= cut().shown.length && !expanded()"
          data-testid="product-category-hub-entry"
        >
          <!-- The bead: the count, Forest on Bone. The visible numeral is hidden from
               assistive tech, which reads the worded count after the name. -->
          <span
            class="inline-grid h-8 min-w-8 shrink-0 place-items-center rounded-pill bg-(--accent-warm) px-2 text-t-14 font-semibold tabular-nums text-(--accent-primary)"
            aria-hidden="true"
            >{{ entry.count }}</span
          >
          <span class="min-w-0 text-t-14 text-(--text-on-brand)"
            >{{ entry.name }}<span class="sr-only">, {{ countLabel(entry.count) }}</span></span
          >
        </li>
      }
    </ul>
    @if (cut().rest.length > 0) {
      <button
        aecButton
        variant="on-brand-secondary"
        compact
        type="button"
        class="mt-4 max-lg:hidden"
        aria-controls="product-category-hub-list"
        [attr.aria-expanded]="expanded()"
        data-testid="product-category-hub-toggle"
        (click)="toggle()"
      >
        @if (expanded()) {
          <span i18n="@@facets.showFewer">Show fewer</span>
        } @else {
          {{ showAllLabel() }}
        }
      </button>
    }
  `,
})
export class ProductCategoryHub {
  readonly entries = input.required<readonly CategoryHubEntry[]>();

  private readonly list = viewChild.required<ElementRef<HTMLUListElement>>('list');
  /** The row is wider than its box (below `lg`), so it needs a tab stop to scroll. */
  protected readonly overflowing = signal(false);
  private readonly destroyRef = inject(DestroyRef);

  /** The first eight A to Z, then the rest (ruling 59). */
  protected readonly cut = computed(() => hubCut(this.entries()));
  /** Whether the entries past the cut show from `lg`. The server always renders false. */
  protected readonly expanded = signal(false);
  protected readonly showAllLabel = computed(() => {
    const n = this.entries().length;
    return $localize`:@@products.detail.hero.hub.showAll:Show all ${n}:count: categories`;
  });

  /**
   * The state the hub is about to take, emitted BEFORE it changes, so the host can
   * measure the layout as it still is (the product hero holds its columns, owner
   * ruling 2026-11-17, item 82).
   */
  readonly expandedChange = output<boolean>();

  protected toggle(): void {
    this.expandedChange.emit(!this.expanded());
    this.expanded.update((open) => !open);
  }

  constructor() {
    // Browser only. The server renders no tab stop, which is right at `lg`.
    afterNextRender(() => {
      const el = this.list().nativeElement;
      const measure = () => this.overflowing.set(el.scrollWidth > el.clientWidth + 1);
      measure();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(measure);
      observer.observe(el);
      this.destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  /** The Integrations section's own group count, reused with its message id. */
  protected countLabel(total: number): string {
    if (total === 1) {
      return $localize`:@@products.detail.body.integrations.group.count.one:1 integration`;
    }
    return $localize`:@@products.detail.body.integrations.group.count:${total}:count: integrations`;
  }
}
