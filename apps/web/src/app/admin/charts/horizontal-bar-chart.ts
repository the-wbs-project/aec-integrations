import { Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';

import { formatPercent, formatThousands } from './format';
import { slotClass, type ChartCategory } from './chart-types';

/**
 * Horizontal bar chart — AECI-578 / Phase 8.3 P1.4.
 * `docs/ADMIN_PANEL_SPEC.md` §8; the workhorse of §5.3's five breakdowns (top
 * sources, top pages, top products, countries, crawlers).
 *
 * Horizontal because the categories have long names — a source is `google.com`,
 * a page is `/products/procore-integrations`. Rotated column labels are the
 * alternative and they are unreadable.
 *
 * ─── Why this one is a real `<table>`, not `<svg role="img">` + a hidden table ─
 *
 * The other four primitives draw geometry SVG is needed for — a polyline, an
 * area, a stacked column, an arc — and their numbers are unreachable to a screen
 * reader, which is exactly why §8 requires each of them to carry a
 * visually-hidden `<table>` alongside.
 *
 * A ranked category-to-count list is not that. It is **already tabular data**,
 * and rendering it as a real table gets three things a hidden duplicate cannot:
 *
 *   1. **Links keep working.** `dimension=product` rows carry a hydrated
 *      `LinkRef` and link to `/products/:slug`. `role="img"` makes its whole
 *      subtree presentational, so those links would vanish from the accessibility
 *      tree — a hidden table beside them cannot link anywhere either. This alone
 *      settles it.
 *   2. **No double-announce.** Visible rows plus an `sr-only` copy of the same
 *      rows means a screen-reader user hears every source twice. Adding a hidden
 *      table here would be an accessibility *regression* dressed as compliance.
 *   3. **Real headers.** `<th scope="row">` / `<th scope="col">` give row-and-
 *      column context on every cell, which §9.9 asks for by name.
 *
 * §8's actual requirement — *"charts are never the only representation of a
 * number"* — is satisfied maximally: here the numbers are the primary
 * representation and the bar is the decoration. The bar is therefore
 * `aria-hidden`. Recorded in `ADMIN_PANEL_SPEC.md` §8 rather than left for a
 * reviewer to find.
 *
 * ─── Scale: share of the largest row, and the text says which ────────────────
 *
 * Bars are scaled against the **largest row**, not against `window_total`.
 * Against the window total a realistic breakdown renders five near-invisible
 * slivers — the top source is a few percent of all views. The number beside each
 * bar is the actual count and the percent is of the window, so the bar is the
 * comparison and the text is the fact.
 */
@Component({
  selector: 'aec-horizontal-bar-chart',
  imports: [RouterLink],
  template: `
    @if (rows().length === 0) {
      <p class="py-8 text-center text-sm text-(--text-secondary)">{{ emptyLabel() }}</p>
    } @else {
      <table class="w-full border-collapse">
        <caption class="sr-only">
          {{
            ariaLabel()
          }}
        </caption>
        <thead class="sr-only">
          <tr>
            <th scope="col">{{ categoryHeader() }}</th>
            <th scope="col">{{ valueHeader() }}</th>
          </tr>
        </thead>
        <tbody>
          @for (row of rows(); track row.key) {
            <tr>
              <th
                scope="row"
                class="relative w-full py-1.5 pe-3 text-start align-middle text-sm font-normal
                  text-(--text-primary)"
              >
                <!-- The mark. A wash rather than a solid fill so the label sits
                     on it at full contrast; aria-hidden because the row's own
                     cells already carry the number. -->
                <span
                  class="absolute inset-y-0.5 left-0 rounded-r-[4px] {{ row.swatch }}"
                  [style.width.%]="row.width"
                  [style.opacity]="0.18"
                  aria-hidden="true"
                ></span>
                <span class="relative block truncate px-2" [title]="row.label">
                  @if (row.link) {
                    <a
                      [routerLink]="row.link"
                      class="text-(--accent-primary) underline-offset-2 hover:underline"
                      >{{ row.label }}</a
                    >
                  } @else {
                    {{ row.label }}
                  }
                </span>
              </th>
              <td
                class="py-1.5 text-end align-middle text-sm font-semibold whitespace-nowrap
                  tabular-nums text-(--text-primary)"
              >
                {{ row.value }}
                @if (row.percent) {
                  <span class="ms-1.5 font-normal text-(--text-secondary)">{{ row.percent }}</span>
                }
              </td>
            </tr>
          }
        </tbody>
      </table>
    }
  `,
  styles: [':host { display: block; }'],
})
export class HorizontalBarChart {
  readonly data = input.required<readonly ChartCategory[]>();
  readonly categoryHeader = input.required<string>();
  /** The value column's header ("Views"). */
  readonly valueHeader = input.required<string>();
  readonly ariaLabel = input.required<string>();
  readonly emptyLabel = input.required<string>();
  /** Window total, when a share is meaningful. Null hides the percent — a share
   *  of an unknown denominator is worse than no share at all. */
  readonly total = input<number | null>(null);
  /** Palette slot for the bars. A single-hue magnitude comparison by default:
   *  these rows are one measure ranked, not distinct entities, so categorical
   *  colour would encode an identity the chart is not claiming. */
  readonly slot = input<ChartCategory['slot']>(1);

  private readonly max = computed(() =>
    this.data().reduce((m, d) => Math.max(m, d.value > 0 ? d.value : 0), 0),
  );

  protected readonly rows = computed(() => {
    const max = this.max();
    const total = this.total();
    return this.data().map((d) => ({
      // The API's unattributed bucket arrives with `key: null` → `''` here, and
      // several rows can share it across dimensions, so fall back to the label
      // to keep `track` unique.
      key: d.key || `__unattributed__${d.label}`,
      label: d.label,
      link: d.link ?? null,
      value: formatThousands(d.value),
      percent: total && total > 0 ? formatPercent(d.value, total) : '',
      // An all-zero breakdown (an empty window) renders zero-width bars rather
      // than dividing by zero — the labels and the zeros still tell the story.
      width: max > 0 ? Math.max(0, (d.value / max) * 100) : 0,
      swatch: slotClass(d.slot ?? this.slot() ?? 1, 'swatch'),
    }));
  });
}
