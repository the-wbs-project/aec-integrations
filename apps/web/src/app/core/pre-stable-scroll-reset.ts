/**
 * Performs the router's scroll reset for navigations that end before the app is
 * first stable, the one window where Angular's `RouterScroller` silently skips it.
 *
 * **The gap (AECI-1629).** With SSR hydration on, `RouterScroller` starts with an
 * `isHydrating` flag that it clears only when `ApplicationRef.whenStable()`
 * resolves, and `scheduleScrollEvent()` returns early while it is set. The intent
 * is to leave the initial hydration navigation alone. But "stable" means no pending
 * tasks, and every in-flight `httpResource` is one. On `/products` the facets
 * request can still be loading after the rows render, so a visitor who scrolls the
 * listing and clicks a row in that moment gets a navigation with no `Scroll` event:
 * nothing resets to the top, and the detail page opens at the listing's offset. In
 * CI the trace showed the click landing while `/api/products/facets` was in flight.
 * The page stayed at `scrollY` 143, which is where Playwright had scrolled the
 * listing to bring the first row into view before clicking. Holding that request
 * open reproduces it every time (`e2e/scroll-restoration.spec.ts`).
 *
 * **The fix.** For each `NavigationEnd` after the initial one, until the app is
 * first stable, wait the same `setTimeout`/`requestAnimationFrame` race the router
 * waits, then one more task so the router's own `Scroll` event has had its chance.
 * If the router emitted no `Scroll` for that navigation, do what
 * `RouterScroller.consumeScrollEvents()` would have done:
 * - Back/Forward (`popstate`) restores the position saved at `NavigationStart`;
 * - a URL fragment scrolls to its anchor through the injected `ViewportScroller`,
 *   so `ScrollMarginViewportScroller` keeps its `scroll-margin` and native-jump
 *   handling;
 * - otherwise scroll to the top.
 * Both position scrolls are forced `instant`. This runs a frame after the router
 * would have, so `ScrollBehaviorManager` may already have dropped its inline
 * `scroll-behavior: auto` while an `<html>` smooth-scroll class is on
 * (`InPageSmoothScroll`, or the switch back to a global smooth scroll).
 *
 * A navigation with `scroll: 'manual'` (the listing filter and sort controls) is
 * left alone, as the router would. Because the fallback only acts when the router
 * stayed silent, it never doubles a scroll, and it stands down by itself if Angular
 * closes the gap upstream. Not covered: a click on a link to the URL already shown,
 * before stability. The router answers that `NavigationSkipped` with a scroll to
 * the top, and before stability it skips that too; the page simply stays put.
 *
 * Browser-only (no-op on the server) and started once from the root component, so
 * its subscription sees the initial hydration navigation's `NavigationEnd`, the
 * same guarantee `ScrollBehaviorManager` and `InitialFragmentScroller` rely on.
 */
import { ViewportScroller, isPlatformBrowser } from '@angular/common';
import { ApplicationRef, Injectable, PLATFORM_ID, inject } from '@angular/core';
import { NavigationEnd, NavigationStart, Router, Scroll } from '@angular/router';

type Position = [number, number];

/** The router's scroll delay: whichever of a task or a frame comes first. */
function routerScrollDelay(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve);
    if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(() => resolve());
  });
}

@Injectable({ providedIn: 'root' })
export class PreStableScrollReset {
  private readonly router = inject(Router);
  private readonly viewportScroller = inject(ViewportScroller);
  private readonly appRef = inject(ApplicationRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private started = false;

  /**
   * Begin covering pre-stable navigations. Idempotent and a no-op on the server.
   * Called once from the root component at bootstrap.
   */
  start(): void {
    if (this.started || !this.isBrowser) return;
    this.started = true;

    let stable = false;
    let initialSeen = false;
    // Mirrors RouterScroller's own bookkeeping, so a pre-stable Back/Forward
    // restores the same position the router would have.
    let lastId = 0;
    let trigger: NavigationStart['navigationTrigger'];
    let restoredId = 0;
    const store: Record<number, Position> = {};
    const routerScrolled = new Set<number>();

    const sub = this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        store[lastId] = this.viewportScroller.getScrollPosition();
        trigger = event.navigationTrigger;
        restoredId = event.restoredState?.navigationId ?? 0;
      } else if (event instanceof Scroll) {
        routerScrolled.add(event.routerEvent.id);
      } else if (event instanceof NavigationEnd) {
        lastId = event.id;
        // The initial hydration navigation is meant to keep its scroll;
        // `InitialFragmentScroller` owns its `#fragment` case.
        if (!initialSeen) {
          initialSeen = true;
          return;
        }
        if (stable) return;
        if (this.router.currentNavigation()?.extras.scroll === 'manual') return;

        const position = trigger === 'popstate' ? store[restoredId] : undefined;
        const anchor = this.router.parseUrl(event.urlAfterRedirects).fragment;
        void this.fallback(event.id, position, anchor, routerScrolled);
      }
    });

    void this.appRef.whenStable().then(() => {
      stable = true;
      sub.unsubscribe();
    });
  }

  private async fallback(
    navigationId: number,
    position: Position | undefined,
    anchor: string | null,
    routerScrolled: Set<number>,
  ): Promise<void> {
    await routerScrollDelay();
    // One more task, so a `Scroll` the router scheduled in the same race has landed.
    await new Promise((resolve) => setTimeout(resolve));
    if (routerScrolled.delete(navigationId)) return;

    const instant: ScrollOptions = { behavior: 'instant' };
    if (position) {
      this.viewportScroller.scrollToPosition(position, instant);
    } else if (anchor) {
      this.viewportScroller.scrollToAnchor(anchor);
    } else {
      this.viewportScroller.scrollToPosition([0, 0], instant);
    }
  }
}
