import { DecimalPipe } from '@angular/common';
import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/** One ranked row. `link` makes the label a router link (top products →
 *  `/products/:slug`); omit it for a plain label (traffic sources). */
export interface RankedRow {
  key: string;
  label: string;
  value: number;
  link?: readonly string[];
}

/**
 * AECI-576 / Phase 8.3 P1.2 — a ranked list with proportional bars, used for the
 * Overview's "top traffic sources" and "top viewed products".
 *
 * The bar is `aria-hidden` decoration scaled against the largest row: the number
 * is always rendered as text beside it, so nothing is encoded in width alone (§8:
 * a chart is never the only representation of a number). Bars are plain divs
 * rather than SVG — a horizontal bar needs no geometry, and CSS percentages
 * reflow for free.
 */
@Component({
  selector: 'aec-ranked-bar-list',
  imports: [DecimalPipe, RouterLink],
  template: `
    @if (rows().length === 0) {
      <p class="text-t-16 text-(--text-secondary)">{{ emptyLabel() }}</p>
    } @else {
      <!-- AECI-1813, mock-up 14: hairline rows, the name and the figure on one
           line, an 8px bar under them. -->
      <ol role="list">
        @for (r of scaled(); track r.key) {
          <li
            class="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-4 gap-y-1 border-b border-(--border-default) py-2 text-t-14"
          >
            @if (r.link) {
              <a
                [routerLink]="r.link"
                class="min-w-0 truncate rounded-mark text-(--text-primary) no-underline underline-offset-3
                  transition-colors duration-fast hover:text-(--accent-primary) hover:underline"
                >{{ r.label }}</a
              >
            } @else {
              <span class="min-w-0 truncate text-(--text-primary)">{{ r.label }}</span>
            }
            <span class="shrink-0 tabular-nums text-(--text-primary)">{{ r.value | number }}</span>
            <div
              class="col-span-full h-2 w-full overflow-hidden rounded-pill bg-(--surface-sunken)"
              aria-hidden="true"
            >
              <div
                class="h-full rounded-pill bg-(--accent-primary)"
                [style.width.%]="r.percent"
              ></div>
            </div>
          </li>
        }
      </ol>
    }
  `,
  styles: [':host { display: block; }'],
})
export class RankedBarList {
  readonly rows = input.required<readonly RankedRow[]>();
  readonly emptyLabel = input.required<string>();

  /** Scale against the largest row, not the window total: at a 60/20/10 split a
   *  total-scaled top bar would fill 60% of the track and the rest would be
   *  slivers, which reads as "nothing else happened". A zero peak yields 0-width
   *  bars rather than a divide-by-zero. */
  protected readonly scaled = computed(() => {
    const list = this.rows();
    const peak = Math.max(0, ...list.map((r) => r.value));
    return list.map((r) => ({ ...r, percent: peak > 0 ? (r.value / peak) * 100 : 0 }));
  });
}
