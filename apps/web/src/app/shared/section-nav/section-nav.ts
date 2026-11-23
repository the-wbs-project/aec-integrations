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

import { Router, RouterLink } from '@angular/router';
import type { ClaimStatus } from '@aeci/shared';

import { SMOOTH_SCROLL_CLASS } from '../../core/in-page-smooth-scroll';
import { BrandLogo } from '../../layout/brand-logo';
import { Chip } from '../chip/chip';
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
 * 9, ADR 0059). There is no input that could put one there. The brand link renders only while
 * the bar is stuck, so it never sits beside the header's own home link, and the server HTML
 * (never stuck) carries neither it nor the name.
 *
 * **An unclaimed listing adds an "Unclaimed" tag** beside the name (ruling 41, Q61 in
 * `docs/LEGAL_COUNSEL_RECORD.md`), from `claimStatus`. It is the stuck cluster's last item, so
 * it too renders only while stuck. It lives inside the name element, so it is hidden wherever
 * the name is (below `md`, or a page with no name). A static chip, no link.
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
 * **The stuck brand cluster moves nothing in layout.** It overlays the start of the row
 * (absolutely placed), and the list slides clear of it with a `transform`, so sticking and
 * unsticking cause no layout shift (CLS 0, pinned in `e2e/section-nav.spec.ts`).
 *
 * **Overflow scrolls sideways inside the row** with a 40px fade at each edge that has more
 * links past it. The current link, and any link reached by Tab, is scrolled fully into the row
 * (the row only, never the page). The page itself still reflows at 320px.
 *
 * **A click pins its section (AECI-1856).** The jump can leave the next section in the spy's
 * band as well, when the clicked one is shorter than the band (a short About), and the spy used
 * to name that next section. So the spy is ignored from the click until the reader next scrolls
 * or types (`wheel`, `touchstart`, `pointerdown` or `keydown`), never on a timer: the jump's own
 * smooth scroll fires none of those.
 *
 * **Print (AECI-1856).** The host drops `sticky` for `static` in print, or the bar prints at its
 * scrolled position, over the page.
 *
 * **The browser-only parts** are the scroll-spy (an `IntersectionObserver` on the sections), the
 * stuck test (an `IntersectionObserver` on the host) and the row geometry (`ResizeObserver`
 * entries and the row's own passive scroll events). Only `reveal` reads layout, and never while
 * a smooth jump or a navigation is in flight. All are wired after render, never on the server,
 * and torn down on destroy. No `NgZone`.
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
  imports: [BrandLogo, Chip, NgOptimizedImage, RouterLink],
  // Sticky lives on the HOST, not an inner element: position:sticky only travels within its
  // containing block. The host itself must be projected into DetailLayout's `nav` slot, which
  // renders it bare into the page container, so it stays pinned for the whole page.
  //
  // The surface is solid `--surface-base`, at rest and stuck (clash 13). No blur, no shadow and
  // no `--surface-sticky`: a translucent bar let a section heading scrolling past read through
  // the labels. The bottom hairline is the global `--border-default` edge.
  host: {
    class: 'block sticky top-0 z-20 border-b bg-(--surface-base) print:static',
    '[attr.data-stuck]': 'stuck() ? "" : null',
    '[attr.data-rest]': 'rest()',
    // Delegated, highlight-only. Kept off the <a> on purpose; see the docblock.
    '(click)': 'onClick($event)',
    // Delegated too: a link reached by Tab is scrolled fully into the row (see `reveal`).
    '(focusin)': 'onFocusIn($event)',
    '(focusout)': 'onFocusOut()',
  },
  styles: `
    /* rest="clear" (AECI-1778): at rest the bar shows the band behind it, with no fill and
       no hairline. Stuck, it is the solid white bar with its hairline. Only colours change, the
       1px border stays, so the swap moves nothing (CLS 0). Unlayered here, so it beats the
       layered fill utility and the unlayered star rule for border colour, which has no specificity. */
    :host([data-rest='clear']:not([data-stuck])) {
      background-color: transparent;
      border-bottom-color: transparent;
    }
    .aec-section-nav-row {
      scrollbar-width: none;
    }
    .aec-section-nav-row::-webkit-scrollbar {
      display: none;
    }
    /* The fades. Mask colours only set alpha; any opaque token works. The start fade begins
       where the stuck brand cluster ends (--aec-row-inset), since the cluster covers the
       row's start. */
    .aec-section-nav-row.aec-fade-end {
      mask-image: linear-gradient(
        to right,
        var(--text-primary) calc(100% - ${FADE_PX}px),
        transparent
      );
    }
    .aec-section-nav-row.aec-fade-start {
      mask-image: linear-gradient(
        to right,
        transparent var(--aec-row-inset, 0px),
        var(--text-primary) calc(var(--aec-row-inset, 0px) + ${FADE_PX}px)
      );
    }
    .aec-section-nav-row.aec-fade-start.aec-fade-end {
      mask-image: linear-gradient(
        to right,
        transparent var(--aec-row-inset, 0px),
        var(--text-primary) calc(var(--aec-row-inset, 0px) + ${FADE_PX}px),
        var(--text-primary) calc(100% - ${FADE_PX}px),
        transparent
      );
    }
    /* A focused link is never under a fade. On a narrow stuck bar a long label ("Integrations
       it powers") can be wider than the space between the two fades. While such a link has
       focus the fades step aside, and the focus ring marks the place. */
    /* Three classes, so it outranks the two-fade rule above. */
    .aec-section-nav-row.aec-fade-off:is(.aec-fade-start, .aec-fade-end) {
      mask-image: none;
    }
    /* Forced colours drop backgrounds; keep the bar as a system colour. */
    @media (forced-colors: active) {
      .aec-section-nav-link::after {
        background: CanvasText;
      }
    }
  `,
  template: `
    <div class="relative flex min-h-16 items-stretch md:min-h-18">
      <!--
        The stuck brand cluster OVERLAYS the start of the row. It is absolutely placed, so its
        arrival moves nothing in layout, and the list slides clear of it by a transform
        (shift()), which is not a layout shift either (CLS stays 0).
      -->
      @if (stuck()) {
        <div
          #brand
          class="absolute inset-y-0 start-0 z-10 flex min-w-0 items-center gap-3 bg-(--surface-base) pe-3 md:max-w-[min(26rem,45%)]"
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
          <!-- The name and, on an unclaimed listing, the "Unclaimed" tag share one wrapper
               (ruling 41, Q61 in LEGAL_COUNSEL_RECORD.md: "beside the product name"). The tag
               exists only inside the name element, so wherever the name is hidden (below md,
               or no name at all) the tag is hidden with it. The hero's status chip recipe.
               Information, not a link. It never shrinks; the name truncates first. -->
          @if (pageName(); as name) {
            <span
              class="hidden min-w-0 items-center gap-3 md:inline-flex"
              data-testid="section-nav-name"
            >
              <span
                class="inline-flex min-w-12 max-w-[200px] items-center gap-3 text-t-16 text-(--text-secondary)"
              >
                <span aria-hidden="true" class="shrink-0">›</span>
                <span class="truncate">{{ name }}</span>
              </span>
              @if (claimStatus() === 'unclaimed') {
                <aec-chip
                  class="shrink-0"
                  tone="quiet"
                  data-testid="section-nav-unclaimed"
                  i18n="@@products.detail.nav.unclaimed"
                  >Unclaimed</aec-chip
                >
              }
            </span>
          }
        </div>
      }
      <nav
        class="flex min-w-0 flex-1"
        aria-label="On this page"
        i18n-aria-label="@@products.detail.nav.aria"
      >
        <!-- The scroller. -ms-3 lines the first label up with the page column at rest. -->
        <div
          #row
          class="aec-section-nav-row -ms-3 flex min-w-0 flex-1 overflow-x-auto overflow-y-hidden"
          [class.aec-fade-start]="fadeStart()"
          [class.aec-fade-end]="fadeEnd()"
          [class.aec-fade-off]="fadesOff()"
          [style.--aec-row-inset.px]="shift() || null"
        >
          <ul
            #track
            class="relative flex shrink-0 items-stretch whitespace-nowrap"
            [style.transform]="shift() ? 'translateX(' + shift() + 'px)' : null"
          >
            @for (s of sections(); track s.id) {
              <li class="flex">
                <a
                  [href]="hrefFor()(s.id)"
                  [attr.data-section-id]="s.id"
                  data-smooth-scroll
                  [attr.aria-current]="activeId() === s.id ? 'location' : null"
                  class="aec-section-nav-link relative inline-flex min-h-11 items-center gap-2 rounded-mark px-3
                    text-t-16 font-normal text-(--text-secondary) no-underline
                    transition-colors duration-base ease-standard hover:text-(--text-primary)
                    aria-[current=location]:font-semibold aria-[current=location]:text-(--text-primary)
                    after:pointer-events-none after:absolute after:inset-x-3 after:bottom-0 after:h-[3px]
                    after:origin-center after:scale-x-0 after:rounded-t-[3px] after:bg-(--accent-secondary)
                    after:transition-transform after:duration-slow after:ease-standard
                    aria-[current=location]:after:scale-x-100
                    focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-(--accent-primary)"
                >
                  <!-- The hidden bold copy reserves the 600 width, so marking a link current
                       never moves the links beside it. -->
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
        </div>
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
  /**
   * The page subject's claim status, from its payload (`claim_status`). `'unclaimed'` adds the
   * "Unclaimed" tag beside the name once the bar sticks (ruling 41, Q61). Listing data, never
   * visitor state, and the tag renders only while stuck, so the server HTML is unchanged.
   * Null (the default) or `'claimed'` adds nothing.
   */
  readonly claimStatus = input<ClaimStatus | null>(null);
  /**
   * The bar at rest. `solid` (default) is white with its hairline at rest and stuck. `clear` is
   * for a bar that sits on a band at rest (the product band shell, where it crosses the Bone
   * band): no fill and no hairline until it sticks. The caller says so; the bar never assumes
   * its ground. The server always renders the bar at rest.
   */
  readonly rest = input<'solid' | 'clear'>('solid');

  protected readonly hrefFor = injectInPageHrefFor();

  /** DOM id of the section the scrollspy or a click last named. */
  protected readonly observedId = signal<string | null>(null);

  /** True from a link click until the reader next scrolls or types. The spy is ignored meanwhile. */
  private pinned = false;

  /** The current section; drives `aria-current` + emphasis. Defaults to the first. */
  protected readonly activeId = computed(() => this.observedId() ?? this.sections()[0]?.id ?? null);

  /** True once the bar has stuck to the viewport top. Browser-only; always false on the server. */
  protected readonly stuck = signal(false);

  // Row geometry, all from ResizeObserver entries and the row's scroll events, so nothing here
  // forces a layout read. `brandWidth` is the stuck cluster's width (0 when absent).
  private readonly brandWidth = signal(0);
  private readonly rowWidth = signal(0);
  private readonly trackWidth = signal(0);
  private readonly rowScroll = signal(0);

  /**
   * How far the list slides to clear the stuck brand cluster: its width plus the 12px the
   * scroller starts before it (`-ms-3`). 0 at rest.
   */
  protected readonly shift = computed(() =>
    this.stuck() && this.brandWidth() > 0 ? this.brandWidth() + 12 : 0,
  );
  private readonly maxScroll = computed(() =>
    Math.max(0, this.trackWidth() + this.shift() - this.rowWidth()),
  );
  private readonly overflows = computed(() => this.maxScroll() > 1);

  /** More links lie past the row's start or end edge. Browser-only. */
  protected readonly fadeStart = computed(() => this.overflows() && this.rowScroll() > 1);
  protected readonly fadeEnd = computed(
    () => this.overflows() && this.rowScroll() < this.maxScroll() - 1,
  );

  /** True while a focused link is too wide to sit clear of both fades. */
  protected readonly fadesOff = signal(false);

  /**
   * The section whose link holds keyboard focus, or null. While set, it wins over the current
   * section in the row: the scroll-spy and the stuck cluster both re-run the "keep the current
   * link visible" effect after focus has moved, and that effect used to scroll the row back to
   * the current link, leaving the focused one off-screen (WCAG 2.4.11, AECI-1778).
   */
  private readonly focusedId = signal<string | null>(null);

  private readonly row = viewChild.required<ElementRef<HTMLElement>>('row');
  private readonly track = viewChild.required<ElementRef<HTMLElement>>('track');
  private readonly brand = viewChild<ElementRef<HTMLElement>>('brand');
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly router = inject(Router);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly destroyRef = inject(DestroyRef);

  /** A link to reveal once the page stops moving (see `reveal`). */
  private pendingReveal: string | null = null;

  /**
   * Marks the clicked link current. Highlight only: the anchor's native same-document scroll
   * does the jump, so this never calls `preventDefault`. A replayed early click lands here too,
   * which is right, because the browser already scrolled.
   */
  protected onClick(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const id = target.closest('a[data-section-id]')?.getAttribute('data-section-id');
    if (!id) return;
    this.observedId.set(id);
    this.pinned = true;
  }

  /**
   * A link reached by Tab can sit partly under the row's edge or a fade, and Chrome does not
   * scroll a partly visible focus target. Scroll the row so the whole link is clear.
   */
  protected onFocusIn(event: Event): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const id = target.closest('a[data-section-id]')?.getAttribute('data-section-id') ?? null;
    this.focusedId.set(id);
    if (id) this.fadesOff.set(this.reveal(id));
  }

  /** Focus left a link. Tab between links fires focusin straight after, in the same task. */
  protected onFocusOut(): void {
    this.focusedId.set(null);
    this.fadesOff.set(false);
  }

  /**
   * Scrolls the ROW (never the page) so the link for `id` sits fully inside it, clear of the
   * brand cluster and both fades. Does nothing when the row does not overflow.
   *
   * It reads two layout values (the link's offset and width), so it never runs while a smooth
   * in-page jump or a router navigation is in flight: a layout read there broke the router's
   * scroll to the top of the next page (AECI-1768 review, `scroll-restoration.spec.ts`). It
   * waits for the window's next `scrollend` instead.
   *
   * Returns true when the link is wider than the room between the two fades, so it is only
   * kept inside the row's edges.
   */
  private reveal(id: string): boolean {
    if (!this.overflows()) return false;
    const smoothJump =
      this.host.nativeElement.ownerDocument.documentElement.classList.contains(SMOOTH_SCROLL_CLASS);
    if (smoothJump || this.router.currentNavigation() !== null) {
      this.pendingReveal = id;
      return false;
    }
    this.pendingReveal = null;
    const link = this.track().nativeElement.querySelector<HTMLElement>(
      `a[data-section-id="${CSS.escape(id)}"]`,
    );
    if (!link) return false;
    const inset = this.shift();
    const start = inset + link.offsetLeft;
    const end = start + link.offsetWidth;
    // The live offset, not the signal: the scroll event for a previous reveal may not have
    // fired yet (Tab from link to link). This path reads layout anyway.
    const row = this.row().nativeElement;
    const scroll = Math.abs(row.scrollLeft);
    // Keep the link a fade's width clear of each edge when it fits; a link wider than that
    // space only needs the row's edges (the fades step aside under focus, see the styles).
    const room = this.rowWidth() - inset;
    const margin = end - start + 2 * FADE_PX <= room ? FADE_PX : 0;
    let target = scroll;
    if (start - margin < scroll + inset) {
      target = start - margin - inset;
    } else if (end + margin > scroll + this.rowWidth()) {
      target = end + margin - this.rowWidth();
    }
    target = Math.min(Math.max(0, target), this.maxScroll());
    if (Math.abs(target - scroll) > 0.5) {
      row.scrollTo({ left: target, behavior: 'instant' });
    }
    return margin === 0;
  }

  constructor() {
    // The scroll-spy. Reading `sections()` makes this re-run whenever the section set changes;
    // `onCleanup` disconnects the previous observer first. The page component is reused across
    // product-to-product client navigations, so a one-shot setup would keep observing the prior
    // product's nodes. `afterRenderEffect` runs browser-only and after the sections are in the DOM.
    afterRenderEffect((onCleanup) => {
      // A new section set starts again from its first link.
      const sections = this.sections();
      untracked(() => this.observedId.set(null));
      this.pinned = false;
      if (typeof IntersectionObserver === 'undefined') return;

      // The reader's own scroll or key releases a click's pin (AECI-1856). A keydown that
      // activates the next link releases first, then its click pins again.
      const release = () => (this.pinned = false);
      const releaseOn = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
      for (const type of releaseOn) {
        window.addEventListener(type, release, { capture: true, passive: true });
      }

      // Bias the trigger band to the upper viewport so the active link reflects the section just
      // under the sticky bar, not whatever is centred.
      const observer = new IntersectionObserver(
        (entries) => {
          if (this.pinned) return;
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

      onCleanup(() => {
        observer.disconnect();
        for (const type of releaseOn) window.removeEventListener(type, release, { capture: true });
      });
    });

    // Keep the current link visible in the row, or the focused one while a link has keyboard
    // focus: focus always wins, so a later scroll-spy update or the stuck cluster arriving never
    // scrolls the focused link out of the row. Runs only when the row overflows (from the
    // ResizeObserver figures), and `reveal` defers while the page is moving.
    afterRenderEffect(() => {
      const focused = this.focusedId();
      const id = focused ?? this.activeId();
      const overflows = this.overflows();
      this.shift(); // the brand cluster changes what is visible
      if (!id || !overflows) return;
      untracked(() => {
        const tooWide = this.reveal(id);
        if (focused) this.fadesOff.set(tooWide);
      });
    });

    // The stuck brand cluster's width, from its own ResizeObserver while it exists.
    afterRenderEffect((onCleanup) => {
      const brand = this.brand()?.nativeElement;
      if (!brand || typeof ResizeObserver === 'undefined') {
        untracked(() => this.brandWidth.set(0));
        return;
      }
      const observer = new ResizeObserver(([entry]) => {
        if (entry) this.brandWidth.set(borderInlineSize(entry));
      });
      observer.observe(brand);
      onCleanup(() => observer.disconnect());
    });

    if (!this.browser) return;
    afterNextRender(() => {
      const host = this.host.nativeElement;
      const row = this.row().nativeElement;
      const track = this.track().nativeElement;
      const view = host.ownerDocument.defaultView;

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

      // Row and list sizes come from ResizeObserver entries, the offset from the row's own
      // scroll events. `scrollLeft` is negative in a right-to-left row, so use its size.
      const onRowScroll = () => this.rowScroll.set(Math.abs(row.scrollLeft));
      row.addEventListener('scroll', onRowScroll, { passive: true });
      const sizes =
        typeof ResizeObserver === 'undefined'
          ? null
          : new ResizeObserver((entries) => {
              for (const entry of entries) {
                if (entry.target === row) this.rowWidth.set(contentInlineSize(entry));
                else this.trackWidth.set(borderInlineSize(entry));
              }
            });
      sizes?.observe(row);
      sizes?.observe(track);

      // A reveal deferred during a smooth jump runs once the page has stopped.
      const onScrollEnd = () => {
        const id = this.pendingReveal;
        if (id) this.reveal(id);
      };
      view?.addEventListener('scrollend', onScrollEnd, { passive: true });

      this.destroyRef.onDestroy(() => {
        stuckObserver?.disconnect();
        sizes?.disconnect();
        row.removeEventListener('scroll', onRowScroll);
        view?.removeEventListener('scrollend', onScrollEnd);
      });
    });
  }
}

function borderInlineSize(entry: ResizeObserverEntry): number {
  return entry.borderBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
}

function contentInlineSize(entry: ResizeObserverEntry): number {
  return entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
}
