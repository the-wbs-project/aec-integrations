/**
 * Forces router-driven scroll restoration to be *instant* whenever smooth
 * scrolling is on for `<html>`.
 *
 * Since AECI-1752 smooth scrolling is not global: the smooth-scroll class on `<html>`
 * (styles.css) is on only for the span of one in-page link jump
 * (`core/in-page-smooth-scroll.ts`), or always if someone flips the switch back
 * to the old global behaviour. This manager is what keeps router scrolls instant
 * in both cases, so keep it even though the global rule is gone.
 *
 * `provideRouter(..., withInMemoryScrolling({ scrollPositionRestoration:
 * 'enabled' }))` (see `app.config.ts`) resets scroll on navigation via
 * `ViewportScroller`, which calls `window.scrollTo(x, y)` — and that honors a
 * smooth CSS `scroll-behavior`. (Angular 22's `RouterScroller` passes
 * `behavior: 'instant'` when it restores a saved position on Back/Forward, but
 * not for the scroll to the top of a forward navigation or for an anchor
 * scroll. Those two still need this manager. `e2e/scroll-restoration.spec.ts`
 * "a route change clicked mid-jump opens the new page at the top" fails
 * without it.) Left alone, every route change would *animate* a
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
 *   does not emit a `Scroll` event — otherwise smooth would stay disabled. (That
 *   same missing `Scroll` event is why the router skips anchor scrolling on the
 *   initial load; `InitialFragmentScroller` handles the `…#section` deep-link case.)
 * - Cancelled / errored navigations never scroll, so they restore immediately;
 *   skipped navigations restore deferred (they may still scroll on a same-URL nav).
 *
 * The in-page section links (the product section nav, the docs "On this page"
 * rail, the account and vendor integration navs) are plain `<a href="{path}#id">`
 * clicks the browser handles as same-document scrolls. They *do* still reach
 * this manager: a fragment navigation fires `popstate`, which
 * Angular's `HistoryStateManager` turns into a router navigation, so an anchor
 * click briefly toggles `scroll-behavior: auto` here too. It is not visible,
 * because the browser has already started its own scroll and
 * `ScrollMarginViewportScroller` skips the router's follow-up scroll for that
 * fragment. (A follow-up used to run: it first overshot by the target's
 * `scroll-mt-20`, then desynced Safari by interrupting the smooth scroll — see
 * `core/scroll-margin-viewport-scroller.ts`.) The skip link is not one of
 * these today: it is a bare `href="#main"`, which `<base href="/">` resolves to
 * `/#main`, so off the home page it loads `/` (AECI-1839). Once that is fixed
 * it becomes a same-document jump, and it must stay instant: it does not carry
 * `data-smooth-scroll`. The reduced-motion block in styles.css (`scroll-behavior: auto !important`) wins
 * over both this inline style and the restore, so reduced-motion visitors stay
 * instant throughout — as intended.
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
