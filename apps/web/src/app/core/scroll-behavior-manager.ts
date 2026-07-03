/**
 * Forces router-driven scroll restoration to be *instant* while keeping the
 * global `html { scroll-behavior: smooth }` rule (styles.css) for same-page
 * anchor jumps.
 *
 * `provideRouter(..., withInMemoryScrolling({ scrollPositionRestoration:
 * 'enabled' }))` (see `app.config.ts`) resets scroll on navigation via
 * `ViewportScroller`, which calls `window.scrollTo(x, y)` — and that honors the
 * CSS `scroll-behavior: smooth`. Left alone, every route change would *animate* a
 * glide to the top (a visible flash of the new page's lower content, then a
 * smooth scroll up) instead of an instant jump.
 *
 * The fix: disable smooth scrolling for the span of a router navigation, then
 * restore it.
 * - `NavigationStart` sets the documentElement's inline `scroll-behavior: auto`
 *   (an inline style overrides the non-`!important` stylesheet rule), well before
 *   the router performs its scroll.
 * - `NavigationEnd` restores it on the next animation frame
 *   (`requestAnimationFrame`). The restore has to land *after* the router runs its
 *   scroll, and the ordering is subtle: this service listens on `Router.events`,
 *   which the `Router` forwards from `NavigationTransitions.events` (in its
 *   constructor) *before* `RouterScroller` — which subscribes later, in an
 *   `APP_BOOTSTRAP_LISTENER`, after this root-component service — receives the same
 *   event. So this handler always runs first, and a plain `setTimeout(0)` restore
 *   here would be queued *before* the router's own scroll `setTimeout` and
 *   re-enable smooth too early (the reset would then animate). The router resolves
 *   its scroll off a `setTimeout`, which runs before the next paint, so deferring
 *   the restore to `requestAnimationFrame` lands it *after* the scroll — keeping
 *   the reset instant. Keying the restore to `NavigationEnd` (not the router's
 *   `Scroll` event) also makes it fire on the initial hydration navigation, which
 *   does not emit a `Scroll` event — otherwise smooth would stay disabled.
 * - Cancelled / errored navigations never scroll, so they restore immediately;
 *   skipped navigations restore deferred (they may still scroll on a same-URL nav).
 *
 * The section-nav "On this page" links and the `#main` skip-link are plain
 * `<a href="…#id">` clicks the browser handles as same-document scrolls — they
 * never fire router events, so this manager never touches them and they keep
 * animating smoothly. The reduced-motion block in styles.css (`scroll-behavior:
 * auto !important`) wins over both this inline style and the restore, so
 * reduced-motion visitors stay instant throughout — as intended.
 *
 * Browser-only (no-op on the server) and started once from the root component.
 */
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import {
  NavigationCancel,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  NavigationStart,
  Router,
} from '@angular/router';

@Injectable({ providedIn: 'root' })
export class ScrollBehaviorManager {
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private started = false;

  /**
   * Begin managing scroll behavior across navigations. Idempotent and a no-op on
   * the server. Called once from the root component at bootstrap.
   */
  start(): void {
    if (this.started || !this.isBrowser) return;
    this.started = true;

    const root = this.document.documentElement;
    // Deferred restore: this handler runs before `RouterScroller` schedules its
    // scroll (see the class doc), so a `setTimeout(0)` here would re-enable smooth
    // too early. `requestAnimationFrame` fires after the router's `setTimeout`-
    // driven scroll has run, so the reset stays instant.
    const restoreDeferred = () => requestAnimationFrame(() => (root.style.scrollBehavior = ''));

    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        // Disable smooth scrolling before the router resets scroll for this nav.
        root.style.scrollBehavior = 'auto';
      } else if (event instanceof NavigationEnd || event instanceof NavigationSkipped) {
        restoreDeferred();
      } else if (event instanceof NavigationCancel || event instanceof NavigationError) {
        // No scroll happens on a cancelled/errored nav — restore immediately.
        root.style.scrollBehavior = '';
      }
    });
  }
}
