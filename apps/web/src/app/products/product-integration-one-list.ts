import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
} from '@angular/core';

import { AecButton } from '../shared/button/button';
import { AecMeter } from '../shared/meter/meter';

import type { IntegrationLaneRow } from './connector-lane-grouping';
import { ONE_LIST_PAGE_SIZE, sharedRowColumns } from './integration-category-groups';
import { ProductIntegrationCard } from './product-integration-card';

/**
 * AECI-1783: the long integration list as one list, 12 at a time (PLAN.md §5.2, the
 * load bar kept by ruling R5 departure 3).
 *
 * Only a reader reaches it, through the "By category" and "One list" toggle, so the
 * server never renders it. Every row is still in the DOM: rows past the shown count
 * carry `hidden="until-found"`, so find-in-page reaches them, and "Load more" reveals
 * the next {@link ONE_LIST_PAGE_SIZE}. It never fetches. The rows are the direct lane in
 * its own order, so which rows show first is the order and nothing else.
 *
 * The load bar is the shared meter in its stacked layout. The meter is decorative and
 * a polite live region beside it says "Showing n of N", as DESIGN.md §5 Meter asks of
 * the caller. After "Load more", focus moves to the first card it revealed, so it is
 * never lost when the button goes away on the last page.
 */
@Component({
  selector: 'aec-product-integration-one-list',
  imports: [AecButton, AecMeter, ProductIntegrationCard],
  host: { class: 'block' },
  template: `
    <ul
      class="aec-integration-grid aec-one-list"
      role="list"
      [attr.aria-label]="ariaLabel()"
      [attr.data-columns]="columns()"
      data-testid="integration-cards"
    >
      @for (row of rows(); track row.key; let i = $index) {
        <li
          aec-product-integration-card
          [row]="row"
          [contextSlug]="contextSlug()"
          [attr.hidden]="i >= shown() ? 'until-found' : null"
          (beforematch)="reveal(i)"
        ></li>
      }
    </ul>

    <p class="sr-only" aria-live="polite" aria-atomic="true">{{ showingLabel() }}</p>
    @if (shown() < rows().length) {
      <div class="mt-8 flex flex-col items-center gap-3" data-testid="integrations-load-bar">
        <aec-meter
          decorative
          layout="stacked"
          [value]="shown()"
          [max]="rows().length"
          [text]="showingLabel()"
        />
        <button
          aecButton
          variant="secondary"
          type="button"
          (click)="loadMore()"
          data-testid="integrations-load-more"
        >
          <span i18n="@@pagination.loadMore">Load more</span>
        </button>
      </div>
    }
  `,
  styles: `
    .aec-one-list {
      position: relative;
    }
    /* See the same rule in product-integration-category-group.ts: out of the grid
       flow, skipped by rendering and by the tab order, still found by find-in-page. */
    .aec-one-list > li[hidden] {
      content-visibility: hidden;
      position: absolute;
      inset-block-start: 0;
      inset-inline-start: 0;
      inline-size: 1px;
      block-size: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
  `,
})
export class ProductIntegrationOneList {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** The rows, already in the lane's order. */
  readonly rows = input.required<readonly IntegrationLaneRow[]>();
  /** This page's product slug; the pair-page context on every card. */
  readonly contextSlug = input.required<string>();
  /** The list's accessible name. */
  readonly ariaLabel = input.required<string>();

  /** One or two cards share the row equally (ruled 2026-11-16). */
  protected readonly columns = computed(() => sharedRowColumns(this.rows().length));

  /** How many rows show. A new row set (a filter changed) starts again at one page. */
  protected readonly shown = linkedSignal({
    source: this.rows,
    computation: (rows) => Math.min(ONE_LIST_PAGE_SIZE, rows.length),
  });

  protected readonly showingLabel = computed(
    () =>
      $localize`:@@products.detail.body.integrations.oneList.showing:Showing ${this.shown()}:SHOWN: of ${this.rows().length}:TOTAL:`,
  );

  protected loadMore(): void {
    const first = this.shown();
    this.shown.set(Math.min(first + ONE_LIST_PAGE_SIZE, this.rows().length));
    afterNextRender(
      () => {
        const cards = this.host.nativeElement.querySelectorAll<HTMLElement>(
          '.aec-one-list > li .aec-partner-link',
        );
        cards.item(first)?.focus();
      },
      { injector: this.injector },
    );
  }

  /** Find-in-page opened a hidden row: show every page up to and including it. */
  protected reveal(index: number): void {
    const pages = Math.floor(index / ONE_LIST_PAGE_SIZE) + 1;
    this.shown.set(Math.min(pages * ONE_LIST_PAGE_SIZE, this.rows().length));
  }
}
