import { isPlatformBrowser, NgOptimizedImage } from '@angular/common';
import {
  afterNextRender,
  afterRenderEffect,
  computed,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  input,
  PLATFORM_ID,
  signal,
  untracked,
  viewChild,
} from '@angular/core';

import { RouterLink } from '@angular/router';

import { BrandLogo } from '../../layout/brand-logo';
import { injectInPageHrefFor } from '../in-page-href';

/**
 * A jumpable section: `id` is the DOM id of the scroll target, `label` is the (already-localized)
 * link text. `count`, when set, is drawn after the label as a quiet tabular number. It is a fact
 * about the section (how many reviews), never an order or a paid-plan input.
 */
export interface SectionNavItem {
  readonly id: string;
  readonly label: string;
  readonly count?: number;
}

/** The end fade's width, and how far an item is kept clear of it when scrolled into view. */
const FADE_PX = 40;

/**
 * The sticky in-page section bar (AECI-1768, DESIGN.md §5 "The section nav and the sticky bar",
 * PLAN.md §4.9). A row of plain text links that sticks to the top of the viewport and jumps to
 * each section. Nothing is hidden: every target stays in the DOM (crawlable; the `@defer`
 * lazy-load triggers unaffected). Used by the product detail page (`/products/:slug`).
 *
 * **It leads with our wordmark, never a vendor's.** Once the bar sticks, our header has
 * scrolled away (the header is not sticky), and the bar reads "AEC Integrations › {pageName}":
 * `aec-brand-logo` linked home, then the page name as plain text. Below `md` it shows our
 * monogram in a home link of its own, and no name. Never a vendor logo, a product mark or a vendor colour, on any listing:
 * a vendor logo there would read as the vendor's own site, which on an unclaimed listing
 * contradicts "not affiliated with or endorsed by this vendor" (PLAN.md §8.5, counsel's ruling
 * 9, ADR 0056). There is no input that could put one there. The brand link renders only while
 * the bar is stuck, so it never sits beside the header's own home link, and the server HTML
 * (never stuck) carries neither it nor the name.
 *
 * **Links keep the query (AECI-1843).** The app ships `<base href="/">`, so a bare `href="#id"`
 * resolves to `/#id`. The hrefs come from `injectInPageHrefFor()` (`shared/in-page-href.ts`):
 * the current path and query plus `#id`. In the browser it keeps the whole query, so a click on
 * `/products/revit?utm_source=x` is a same-document jump and not a page load. On the server it
 * keeps only the params the route's edge cache key keeps (none on a product page), so every
 * request that shares a cache entry renders byte-identical hrefs.
 *
 * **Scrolling is native, but the router still runs.** A plain anchor to the same URL plus a new
 * fragment is a same-document scroll the browser does itself, honouring each target's
 * `scroll-margin-top` (`scroll-mt-20` clears the 72px bar). Each link carries
 * `data-smooth-scroll`, so `InPageSmoothScroll` (`core/in-page-smooth-scroll.ts`, AECI-1752)
 * animates the jump, except under reduced motion. The jump works under SSR, for crawlers,
 * no-JS, before hydration, and for "copy link" alike. A same-document fragment navigation also
 * fires `popstate`, which Angular reads as a browser-driven navigation, so `RouterScroller`
 * asks to re-scroll while the browser's smooth scroll runs. `ScrollMarginViewportScroller`
 * (`core/scroll-margin-viewport-scroller.ts`) skips that second scroll. Do not assume these
 * anchors are invisible to the router, and never route them through it.
 *
 * **Focus never hides under the bar (WCAG 2.4.11).** `styles.css` gives every focusable element
 * after this host a `scroll-margin-top` that clears it, and sets `--aec-sticky-offset` for
 * anything else that sticks below it. See the comment there for why it is not root
 * `scroll-padding-top`.
 *
 * **The current item** is weight 600 in primary ink with a 3px Clay bar on the bar's bottom
 * edge (ruling R3). Clay is 2.33:1 on white, so the weight, the ink and `aria-current="location"`
 * carry the state too. Each label reserves its 600 width, so the current item never shifts its
 * neighbours. Until a click or the scroll-spy names one, the FIRST link is current, so a screen
 * reader always hears where it is (AECI-831). SSR renders that same default for every visitor.
 *
 * **Overflow scrolls sideways inside the row** with a 40px fade at each edge that has more
 * links past it. The current link is scrolled into view in the row (the row only, never the
 * page). The page itself still reflows at 320px.
 *
 * **The browser-only parts** are the scroll-spy (an `IntersectionObserver` on the sections), the
 * stuck test (an `IntersectionObserver` on the host) and the row's fade state (a passive scroll
 * listener and a `ResizeObserver`). All are wired after render, never on the server, and torn
 * down on destroy. No `NgZone`, no scroll handler on the window.
 *
 * **The click listener is on the host, never on the `<a>` (AECI-1655).** The host's one
 * delegated `(click)` finds the clicked anchor with `closest('a')` and reads its
 * `data-section-id`. It only sets the highlight and never calls `preventDefault`. Do not move
 * it onto the anchors. Angular's event-replay dispatcher caches each element's `jsaction`. Once
 * an anchor that owned a click action took a click before the app was stable, the dispatcher
 * called `preventDefault` on every later click on that anchor, so the link went dead.
 * `core/event-replay.component.spec.ts` pins that behaviour.
 */
@Component({
  selector: 'aec-section-nav',
  imports: [BrandLogo, NgOptimizedImage, RouterLink],
  // Sticky lives on the HOST, not an inner element: position:sticky only travels within its
  // containing block. The host itself must be projected into DetailLayout's `nav` slot, which
  // renders it bare into the page container, so it stays pinned for the whole page.
  //
  // The surface is solid `--surface-base`, at rest and stuck (clash 13). No blur, no shadow and
  // no `--surface-sticky`: a translucent bar let a section heading scrolling past read through
  // the labels. The bottom hairline is the global `--border-default` edge.
  host: {
    class: 'block sticky top-0 z-20 border-b bg-(--surface-base)',
    '[attr.data-stuck]': 'stuck() ? "" : null',
    // Delegated, highlight-only. Kept off the <a> on purpose; see the docblock.
    '(click)': 'onClick($event)',
  },
  styles: `
    .aec-section-nav-row {
      scrollbar-width: none;
      /* Tab or the current-item scroll keeps a link clear of the fade. */
      scroll-padding-inline: ${FADE_PX}px;
    }
    .aec-section-nav-row::-webkit-scrollbar {
      display: none;
    }
    /* Mask colours only set alpha; any opaque token works. */
    .aec-section-nav-row.aec-fade-end {
      mask-image: linear-gradient(
        to right,
        var(--text-primary) calc(100% - ${FADE_PX}px),
        transparent
      );
    }
    .aec-section-nav-row.aec-fade-start {
      mask-image: linear-gradient(to right, transparent, var(--text-primary) ${FADE_PX}px);
    }
    .aec-section-nav-row.aec-fade-start.aec-fade-end {
      mask-image: linear-gradient(
        to right,
        transparent,
        var(--text-primary) ${FADE_PX}px,
        var(--text-primary) calc(100% - ${FADE_PX}px),
        transparent
      );
    }
    /* Forced colours drop backgrounds; keep the bar as a system colour. */
    @media (forced-colors: active) {
      .aec-section-nav-link::after {
        background: CanvasText;
      }
    }
  `,
  template: `
    <div class="flex min-h-16 items-stretch gap-3 md:min-h-18 md:gap-4">
      @if (stuck()) {
        <div
          class="flex min-w-0 shrink items-center gap-3 md:max-w-[min(24rem,40%)]"
          data-testid="section-nav-brand"
        >
          <!-- From md, the shared wordmark. Below md, our monogram in a link of its own,
               so the header's BrandLogo (initial bundle) carries no phone-only branch. Only
               one of the two is displayed, so a screen reader meets one home link. -->
          <span class="hidden shrink-0 md:flex">
            <aec-brand-logo [height]="24" [priority]="false" />
          </span>
          <a
            routerLink="/"
            class="flex shrink-0 rounded-mark md:hidden focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--accent-primary)"
            i18n-aria-label="@@app.brand.aria"
            aria-label="AEC Integrations home"
            ><img ngSrc="/branding/monogram-light.svg" width="32" height="32" alt=""
          /></a>
          @if (pageName(); as name) {
            <span
              class="hidden min-w-12 max-w-[200px] items-center gap-3 text-t-16 text-(--text-secondary) md:inline-flex"
            >
              <span aria-hidden="true" class="shrink-0">›</span>
              <span class="truncate">{{ name }}</span>
            </span>
          }
        </div>
      }
      <nav
        class="flex min-w-0 flex-1"
        aria-label="On this page"
        i18n-aria-label="@@products.detail.nav.aria"
      >
        <ul
          #row
          class="aec-section-nav-row relative flex min-w-0 flex-1 items-stretch overflow-x-auto overflow-y-hidden whitespace-nowrap"
          [class.-ms-3]="!stuck()"
          [class.aec-fade-start]="fadeStart()"
          [class.aec-fade-end]="fadeEnd()"
        >
          @for (s of sections(); track s.id) {
            <li class="flex">
              <a
                [href]="hrefFor()(s.id)"
                [attr.data-section-id]="s.id"
                data-smooth-scroll
                [attr.aria-current]="activeId() === s.id ? 'location' : null"
                class="aec-section-nav-link relative inline-flex min-h-11 items-center gap-1.5 rounded-mark px-3
                  text-t-16 font-normal text-(--text-secondary) no-underline
                  transition-colors duration-base ease-standard hover:text-(--text-primary)
                  aria-[current=location]:font-semibold aria-[current=location]:text-(--text-primary)
                  after:pointer-events-none after:absolute after:inset-x-3 after:bottom-0 after:h-[3px]
                  after:origin-center after:scale-x-0 after:rounded-t-[3px] after:bg-(--accent-secondary)
                  after:transition-transform after:duration-slow after:ease-standard
                  aria-[current=location]:after:scale-x-100
                  focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
              >
                <!-- The hidden bold copy reserves the 600 width, so marking a link current never
                     moves the links beside it. -->
                <span class="grid">
                  <span class="col-start-1 row-start-1">{{ s.label }}</span>
                  <span
                    aria-hidden="true"
                    class="invisible col-start-1 row-start-1 h-0 overflow-hidden font-semibold"
                    >{{ s.label }}</span
                  >
                </span>
                @if (s.count !== undefined) {
                  <span
                    class="text-t-13 font-normal text-(--text-secondary) tabular-nums"
                    data-testid="section-nav-count"
                    >{{ s.count }}</span
                  >
                }
              </a>
            </li>
          }
        </ul>
      </nav>
    </div>
  `,
})
export class SectionNav {
  readonly sections = input.required<readonly SectionNavItem[]>();
  /**
   * The page's name, shown as plain text after our wordmark once the bar sticks ("AEC
   * Integrations › Bluebeam Revu"). Text only: the bar never draws the entity's logo.
   */
  readonly pageName = input<string | null>(null);

  protected readonly hrefFor = injectInPageHrefFor();

  /** DOM id of the section the scrollspy or a click last named. */
  protected readonly observedId = signal<string | null>(null);

  /** The current section; drives `aria-current` + emphasis. Defaults to the first. */
  protected readonly activeId = computed(() => this.observedId() ?? this.sections()[0]?.id ?? null);

  /** True once the bar has stuck to the viewport top. Browser-only; always false on the server. */
  protected readonly stuck = signal(false);

  /** More links lie past the row's start or end edge. Browser-only. */
  protected readonly fadeStart = signal(false);
  protected readonly fadeEnd = signal(false);

  private readonly row = viewChild.required<ElementRef<HTMLUListElement>>('row');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /**
   * Marks the clicked link current. Highlight only: the anchor's native same-document scroll
   * does the jump, so this never calls `preventDefault`. A replayed early click lands here too,
   * which is right, because the browser already scrolled.
   */
  protected onClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const id = target.closest('a[data-section-id]')?.getAttribute('data-section-id');
    if (id) this.observedId.set(id);
  }

  /** Sets the fades. `scrollLeft` is negative in a right-to-left row, so use its size. */
  private measureRow(): void {
    const row = this.row().nativeElement;
    const max = row.scrollWidth - row.clientWidth;
    const at = Math.abs(row.scrollLeft);
    this.fadeStart.set(max > 1 && at > 1);
    this.fadeEnd.set(max > 1 && at < max - 1);
  }

  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    // The scroll-spy. Reading `sections()` makes this re-run whenever the section set changes;
    // `onCleanup` disconnects the previous observer first. The page component is reused across
    // product-to-product client navigations, so a one-shot setup would keep observing the prior
    // product's nodes. `afterRenderEffect` runs browser-only and after the sections are in the DOM.
    afterRenderEffect((onCleanup) => {
      // A new section set starts again from its first link.
      const sections = this.sections();
      untracked(() => this.observedId.set(null));
      if (typeof IntersectionObserver === 'undefined') return;

      // Bias the trigger band to the upper viewport so the active link reflects the section just
      // under the sticky bar, not whatever is centred.
      const observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting && entry.target.id) {
              this.observedId.set(entry.target.id);
            }
          }
        },
        { rootMargin: '-10% 0px -70% 0px', threshold: 0 },
      );

      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (el) observer.observe(el);
      }

      onCleanup(() => observer.disconnect());
    });

    // Keep the current link visible in the row. Scrolls the row only, never the page, and only
    // when the row overflows. One layout read per change of the current link.
    afterRenderEffect(() => {
      const id = this.activeId();
      this.stuck(); // the brand cluster changes the row's width
      const row = this.row().nativeElement;
      if (!id || row.scrollWidth <= row.clientWidth) return;
      const link = row.querySelector<HTMLElement>(`a[data-section-id="${CSS.escape(id)}"]`);
      if (!link) return;
      const start = link.offsetLeft - FADE_PX;
      const end = link.offsetLeft + link.offsetWidth + FADE_PX;
      if (start < row.scrollLeft) {
        row.scrollTo({ left: Math.max(0, start), behavior: 'instant' });
      } else if (end > row.scrollLeft + row.clientWidth) {
        row.scrollTo({ left: end - row.clientWidth, behavior: 'instant' });
      }
    });

    // The fades follow the row's content as well as its scroll and size.
    afterRenderEffect(() => {
      this.sections();
      this.stuck();
      this.measureRow();
    });

    if (!this.browser) return;
    afterNextRender(() => {
      const host = this.host.nativeElement;
      const row = this.row().nativeElement;

      // Stuck: the host's top edge has reached the viewport top. The root is grown far below
      // the viewport, so the ratio drops under 1 only when the top edge is cut, never when the
      // bar is cut by the viewport bottom. Every crossing of that edge then fires a callback.
      let stuckObserver: IntersectionObserver | null = null;
      if (typeof IntersectionObserver !== 'undefined') {
        stuckObserver = new IntersectionObserver(
          ([entry]) => {
            if (!entry) return;
            const stuck = entry.intersectionRatio < 1 && entry.boundingClientRect.top < 1;
            // Back at rest means the reader is above every section again (they all follow
            // the bar), so the first link is current, as in the server render.
            if (!stuck && this.stuck()) this.observedId.set(null);
            this.stuck.set(stuck);
          },
          { rootMargin: '-1px 0px 100000px 0px', threshold: [1] },
        );
        stuckObserver.observe(host);
      }

      const measure = () => this.measureRow();
      row.addEventListener('scroll', measure, { passive: true });
      const resizeObserver =
        typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
      resizeObserver?.observe(row);

      this.destroyRef.onDestroy(() => {
        stuckObserver?.disconnect();
        resizeObserver?.disconnect();
        row.removeEventListener('scroll', measure);
      });
    });
  }
}
