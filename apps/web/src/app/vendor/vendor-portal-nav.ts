import { DOCUMENT } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  afterRenderEffect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

import {
  VENDOR_NAV_ITEM_ACTIVE_CLASS,
  VENDOR_NAV_ITEM_CLASS,
  type VendorNavItem,
} from './vendor-nav';

/** The width of the fade at a scrolled edge, in px. */
const FADE_PX = 40;

/**
 * The vendor portal's section nav: a horizontal row of tabs under the page
 * title, above the content.
 *
 * ── WHY IT IS HORIZONTAL ────────────────────────────────────────────────────
 * It was a 14rem side rail in a two-column grid. Five short links do not earn a
 * seventh of a wide page, and the content they front (a profile form, a product
 * form, an integration list) is the thing that wants the width. Horizontal also
 * puts the section row directly above the panel it switches, which is what makes
 * it read as a tab row rather than as a second site nav.
 *
 * ── WHY IT IS NOT STICKY ────────────────────────────────────────────────────
 * `shared/section-nav/section-nav.ts` is sticky because it is an in-page jump nav
 * on a long editorial scroll, where the target moves under the reader. A router
 * nav has no such coupling: the sections are short, and each one is its own
 * document. Sticky would also have to live on the host (a sticky `<nav>` is
 * trapped inside its parent's box) for no gain.
 *
 * ── ONE ROW AT EVERY WIDTH ──────────────────────────────────────────────────
 * Narrow viewports scroll the row sideways rather than wrapping it: a wrapped tab
 * row breaks its own underline across two lines. There is deliberately NO
 * `md:hidden` mobile duplicate, which would put every nav item in the DOM twice
 * and hand the specs (and a screen reader's link list) two of everything.
 *
 * ── THE ROW SCROLLS, WITH EDGE FADES AND NO SCROLLBAR (AECI-1809) ──────────
 * `overflow-x-auto` scrolls the row. `overflow-y-hidden` beside it keeps the other
 * axis from computing to `auto` and painting a second scrollbar (AECI-958). The
 * scrollbar itself is hidden: a 40px fade at an edge with more tabs past it says the
 * row scrolls instead. The fades are a mask, set from scroll and resize events in the
 * browser only, so SSR paints the row with none. A tab reached by Tab is scrolled
 * clear of both fades, so the focused tab is never under one (WCAG 2.4.11).
 *
 * The current tab's underline is the link's own `::after` bar (`vendor-nav.ts`), not
 * a bottom border pulled over the hairline with `-mb-px`. Nothing pokes out of the
 * row, so the AECI-958 vertical scrollbar cannot come back.
 *
 * ── ONE ROW, TWO CONTEXTS (§6.11) ───────────────────────────────────────────
 * The shell renders exactly one of these: the vendor sections, or — once a
 * product is open — that product's sections. The items and the landmark name
 * are inputs, so the same component draws both and the two rows cannot drift
 * apart visually. It used to take the catalog and swap Products for a filterable
 * dropdown; Products is a plain link to the product list now, and the product
 * row used to be a second, segmented control stacked under this one.
 *
 * Presentational: nothing here injects `VendorPortalStore` — the store is not
 * root-provided (the preview shadows it), and inputs keep this component
 * testable with no DI at all.
 *
 * Light theme only (Stage 1 / AECI-226).
 */
@Component({
  selector: 'aec-vendor-portal-nav',
  imports: [RouterLink, RouterLinkActive],
  host: { class: 'block' },
  styles: `
    .aec-portal-tabs {
      scrollbar-width: none;
    }
    .aec-portal-tabs::-webkit-scrollbar {
      display: none;
    }
    /* Mask colours only set alpha; any opaque token works. */
    .aec-portal-tabs.aec-fade-end {
      mask-image: linear-gradient(
        to right,
        var(--text-primary) calc(100% - ${FADE_PX}px),
        transparent
      );
    }
    .aec-portal-tabs.aec-fade-start {
      mask-image: linear-gradient(to right, transparent, var(--text-primary) ${FADE_PX}px);
    }
    .aec-portal-tabs.aec-fade-start.aec-fade-end {
      mask-image: linear-gradient(
        to right,
        transparent,
        var(--text-primary) ${FADE_PX}px,
        var(--text-primary) calc(100% - ${FADE_PX}px),
        transparent
      );
    }
    /* Forced colours drop backgrounds; keep the underline as a system colour. */
    @media (forced-colors: active) {
      a::after {
        background: CanvasText;
      }
    }
  `,
  template: `
    <!-- AECI-1855: a persistent section row. A pressed link keeps focus after it
         navigates (core/route-focus.ts, data-route-focus-keep). -->
    <nav data-route-focus-keep [attr.aria-label]="ariaLabel()" class="mb-8 border-b">
      <!-- -ms-3 lines the first label up with the page column. relative makes the row
           each tab's offsetParent, which reveal() measures against. -->
      <ul
        #row
        class="aec-portal-tabs relative m-0 -ms-3 flex list-none overflow-x-auto overflow-y-hidden p-0 whitespace-nowrap"
        [class.aec-fade-start]="fadeStart()"
        [class.aec-fade-end]="fadeEnd()"
        (scroll)="measure()"
        (focusin)="reveal($event)"
      >
        @for (item of items(); track item.path) {
          <li class="flex shrink-0">
            <a
              [routerLink]="item.path"
              [routerLinkActive]="activeClass"
              ariaCurrentWhenActive="page"
              [class]="itemClass"
            >
              <!-- The hidden weight-600 copy reserves the current width, so marking a
                   tab current never moves the tabs beside it. -->
              <span class="grid">
                <span class="col-start-1 row-start-1" data-tab-label>{{ item.label }}</span>
                <span
                  aria-hidden="true"
                  class="invisible col-start-1 row-start-1 h-0 overflow-hidden font-semibold"
                  >{{ item.label }}</span
                >
              </span>
            </a>
          </li>
        }
      </ul>
    </nav>
  `,
})
export class VendorPortalNav {
  /** The row's tabs. Relative paths, deliberately: one template serves
   *  `/vendor/:vendorSlug` and `/preview/vendor-dashboard`. */
  readonly items = input.required<readonly VendorNavItem[]>();

  /** The landmark name. Built by the caller with `$localize`, because an
   *  interpolated `i18n-aria-label` emits no attribute in this toolchain. */
  readonly ariaLabel = input.required<string>();
  protected readonly itemClass = VENDOR_NAV_ITEM_CLASS;
  protected readonly activeClass = VENDOR_NAV_ITEM_ACTIVE_CLASS;

  /** More tabs lie past the row's start or end edge. Browser-only. */
  protected readonly fadeStart = signal(false);
  protected readonly fadeEnd = signal(false);

  private readonly row = viewChild.required<ElementRef<HTMLElement>>('row');
  private readonly destroyRef = inject(DestroyRef);
  private readonly doc = inject(DOCUMENT);

  constructor() {
    const destroyRef = this.destroyRef;
    // After every render that read `items()`: the shell swaps the vendor row for a
    // product row in this same component, and the row keeps its own width while its
    // tabs change, so neither scroll nor the ResizeObserver would fire. Browser-only.
    afterRenderEffect(() => {
      this.items();
      this.measure();
    });
    afterNextRender(() => {
      // Web fonts change every tab's width after first paint.
      let gone = false;
      destroyRef.onDestroy(() => (gone = true));
      void this.doc.fonts?.ready.then(() => {
        if (!gone) this.measure();
      });
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(() => this.measure());
      observer.observe(this.row().nativeElement);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  /** Sets the fades from the row's scroll position. Runs on scroll and resize only. */
  protected measure(): void {
    const row = this.row().nativeElement;
    const max = row.scrollWidth - row.clientWidth;
    const at = Math.abs(row.scrollLeft);
    this.fadeStart.set(max > 1 && at > 1);
    this.fadeEnd.set(max > 1 && at < max - 1);
  }

  /**
   * Scrolls the ROW, never the page, so a tab reached by Tab sits clear of both fades.
   *
   * Keyboard focus only (`:focus-visible`). Chrome focuses a link on mousedown, so
   * scrolling on a pointer focus would move the row before mouseup: the release would
   * land on a different tab, or on the row itself, and the click would do nothing
   * (review of PR #1483).
   */
  protected reveal(event: FocusEvent): void {
    const link = (event.target as Element | null)?.closest('a');
    if (!(link instanceof HTMLElement)) return;
    if (!link.matches(':focus-visible')) return;
    const row = this.row().nativeElement;
    if (row.scrollWidth - row.clientWidth <= 1) return;
    const start = link.offsetLeft;
    const end = start + link.offsetWidth;
    if (start - FADE_PX < row.scrollLeft) {
      row.scrollLeft = Math.max(0, start - FADE_PX);
    } else if (end + FADE_PX > row.scrollLeft + row.clientWidth) {
      row.scrollLeft = end + FADE_PX - row.clientWidth;
    }
  }
}
