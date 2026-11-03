/**
 * A `ViewportScroller` whose anchor scrolling honors the target's CSS
 * `scroll-margin-top` — the one thing Angular's built-in scroller does not do.
 *
 * **The defect this fixes.** Every detail-page section carries `scroll-mt-20`
 * (80px) so its heading clears the sticky `aec-section-nav`. Angular's
 * `BrowserViewportScroller.scrollToAnchor()` scrolls with
 * `window.scrollTo({ top: rect.top + scrollY - offset })`, which reads only the
 * scroller's own configured offset (default `[0, 0]`) and ignores
 * `scroll-margin-*` entirely. So the router parked each section flush with the
 * viewport top and the sticky nav covered its `<h2>`.
 *
 * **Why the router runs at all on a section-nav click.** `SectionNav` renders
 * plain `<a href="{path}#id">` anchors precisely so the browser does the scroll
 * natively, and native fragment scrolling *does* honor `scroll-margin-top`. But
 * a same-document fragment navigation fires **`popstate`** as well as
 * `hashchange` (HTML spec: "update document for history step application"), and
 * `popstate` is exactly what Angular's `HistoryStateManager` treats as a
 * browser-driven navigation. So every in-page anchor click also runs a router
 * navigation, and `RouterScroller` — armed by `anchorScrolling: 'enabled'` —
 * re-scrolls to the same fragment a moment later. The browser landed correctly,
 * then Angular pulled the page 80px further down. Measured on
 * `/products/procore`: `hashchange` at `scrollY = 1301`, then
 * `scrollTo({ top: 1381 })`.
 *
 * Do not "fix" this with `setOffset([0, 80])`. That offset is global, so it
 * would open an 80px gap on every anchor that has no sticky nav above it — the
 * `#main` skip-link target first of all — and it would hard-code in TypeScript a
 * number that CSS already states. Reading `scroll-margin-top` off the target
 * keeps the two scroll paths (native and router) landing on the same pixel.
 *
 * **The router's scroll stands down after a native fragment jump.** The duplicate
 * scroll was not invisible in Safari. It arrives while the browser's smooth scroll
 * is running, and interrupting that animation leaves Safari painting the target
 * while its own `scrollY` stays near the old position (measured 2026-11-02 on
 * Safari 26.6.2: painted at the `#integrations` position, `scrollY` about 820
 * against the correct 548). Hover and clicks then hit whatever sits at the stale
 * position, until the next scroll re-syncs the two. So when `popstate` says the
 * browser already took this fragment, `scrollToAnchor` leaves the scroll to it.
 * It has to be `popstate`, the same event the router reacts to: re-clicking the
 * link for the fragment already in the URL fires no `hashchange`, yet the browser
 * scrolls and the router still follows up. Router-driven fragment navigations
 * (`routerLink [fragment]`) use `pushState`, which fires no `popstate`, so they
 * still scroll here. `scrollToPosition` is unaffected, so Back/Forward still
 * restores the saved position. A traversal whose saved position is gone (Back
 * after a reload) also reaches `scrollToAnchor` with a fresh `popstate`, and stays
 * where it is.
 *
 * Everything except `scrollToAnchor` mirrors `BrowserViewportScroller` exactly,
 * including the post-scroll `focus({ preventScroll: true })`. Two deliberate
 * omissions from the upstream implementation: it also walks shadow roots looking
 * for the anchor (this app has no shadow DOM — Angular's default emulated
 * encapsulation uses no shadow root), and it warns on a failed
 * `history.scrollRestoration` write (we swallow it the same way, without the
 * dev-mode message plumbing).
 *
 * Registered from `app.config.ts`. On the server it resolves to a no-op, the
 * same as Angular's own `NullViewportScroller`.
 */
import { DOCUMENT, ViewportScroller, isPlatformBrowser } from '@angular/common';
import { PLATFORM_ID, type Provider, inject } from '@angular/core';

/** Parse a computed length (`"80px"`), treating `auto`/empty/invalid as zero. */
function toPx(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** A `location.hash` without its `#`, decoded the way the router reports it. */
function fragmentOf(hash: string): string {
  const raw = hash.slice(1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** How long after `popstate` the router's follow-up scroll counts as a duplicate. */
const NATIVE_FRAGMENT_WINDOW_MS = 1000;

export class ScrollMarginViewportScroller extends ViewportScroller {
  private offset: () => [number, number] = () => [0, 0];
  /** The fragment the browser last scrolled to on its own, until the router's follow-up. */
  private nativeFragment: { target: string; at: number } | null = null;

  constructor(
    private readonly document: Document,
    private readonly window: Window,
  ) {
    super();
    this.window.addEventListener('popstate', () => {
      this.nativeFragment = { target: fragmentOf(this.window.location.hash), at: Date.now() };
    });
  }

  setOffset(offset: [number, number] | (() => [number, number])): void {
    this.offset = Array.isArray(offset) ? () => offset : offset;
  }

  getScrollPosition(): [number, number] {
    return [this.window.scrollX, this.window.scrollY];
  }

  scrollToPosition(position: [number, number], options?: ScrollOptions): void {
    this.window.scrollTo({ ...options, left: position[0], top: position[1] });
  }

  /**
   * Scroll the fragment target into view, subtracting BOTH its own
   * `scroll-margin-*` and any offset configured via `setOffset()`. The two are
   * additive on purpose: the CSS states the per-section clearance, the offset
   * stays available as an app-wide adjustment. Skips the scroll, but not the
   * focus, when the browser is already scrolling to this fragment (see the class
   * doc).
   */
  scrollToAnchor(target: string, options?: ScrollOptions): void {
    const el = this.findAnchor(target);
    if (!el) return;

    if (!this.consumeNativeFragment(target)) {
      const rect = el.getBoundingClientRect();
      const style = this.window.getComputedStyle(el);
      const [offsetX, offsetY] = this.offset();

      this.window.scrollTo({
        ...options,
        left: rect.left + this.window.scrollX - toPx(style.scrollMarginLeft) - offsetX,
        top: rect.top + this.window.scrollY - toPx(style.scrollMarginTop) - offsetY,
      });
    }

    el.focus({ preventScroll: true });
  }

  /** True once per `popstate`, and only for its own fragment within the window. */
  private consumeNativeFragment(target: string): boolean {
    const native = this.nativeFragment;
    this.nativeFragment = null;
    return (
      native !== null &&
      native.target === target &&
      Date.now() - native.at < NATIVE_FRAGMENT_WINDOW_MS
    );
  }

  setHistoryScrollRestoration(scrollRestoration: 'auto' | 'manual'): void {
    try {
      this.window.history.scrollRestoration = scrollRestoration;
    } catch {
      // Sandboxed iframes and some test runners reject the write. Scroll
      // restoration degrades to the browser default; nothing else breaks.
    }
  }

  /** `#id` first, then a legacy `<a name>`, matching the HTML fragment rules. */
  private findAnchor(target: string): HTMLElement | null {
    return (
      this.document.getElementById(target) ??
      (this.document.getElementsByName(target).item(0) as HTMLElement | null) ??
      null
    );
  }
}

/** No-op counterpart for SSR, mirroring Angular's `NullViewportScroller`. */
export class NoopViewportScroller extends ViewportScroller {
  setOffset(): void {}
  getScrollPosition(): [number, number] {
    return [0, 0];
  }
  scrollToPosition(): void {}
  scrollToAnchor(): void {}
  setHistoryScrollRestoration(): void {}
}

/**
 * Replace Angular's `ViewportScroller` with the `scroll-margin`-aware one.
 * Add to `appConfig.providers`. An explicit provider always beats the
 * `providedIn: 'root'` factory, and `@angular/router` only ever *injects* this
 * token, so position relative to `provideRouter(...)` does not matter.
 */
export function provideScrollMarginViewportScroller(): Provider {
  return {
    provide: ViewportScroller,
    useFactory: (): ViewportScroller => {
      const isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
      const document = inject(DOCUMENT);
      const window = document.defaultView;
      return isBrowser && window
        ? new ScrollMarginViewportScroller(document, window)
        : new NoopViewportScroller();
    },
  };
}
