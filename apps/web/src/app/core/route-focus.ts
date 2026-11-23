/**
 * Where keyboard focus goes after a client-side navigation (AECI-1855).
 *
 * A link that leaves the page it sits on (a card, a breadcrumb, a Browse menu
 * destination, a mobile menu link) is removed or hidden by the navigation, so the
 * browser drops focus to `<body>`. A keyboard or screen-reader user then starts the
 * new page from nowhere and hears nothing. A full page load would have started
 * them at the top of the new document.
 *
 * The policy: after a navigation that changes the path, focus moves to the new
 * page's `h1`, or to `<main id="main">` when the page has no visible `h1` yet.
 * The heading names the page, so a screen reader announces it. `<main>` is the
 * skip link's target. The focus never scrolls (`preventScroll`), so it cannot
 * fight the router's scroll reset or Back's scroll restore.
 *
 * It leaves focus alone when:
 *   - only the query or the fragment changed. A listing filter, sort or page keeps
 *     focus on the control, and a section link's target is focused by
 *     `ScrollMarginViewportScroller`;
 *   - the new page put focus somewhere itself, inside `<main>` or a dialog (a form
 *     that focuses its success heading, a page that focuses its search box);
 *   - focus is on a link inside a persistent section row marked `data-route-focus-keep`
 *     (the admin section row, the vendor portal nav) and that link is still on screen.
 *     The row and the heading above it stay put across the navigation, so the reader
 *     keeps their place in the row (Chris's ruling on AECI-1855, option A);
 *   - it is the initial (hydration) navigation.
 *
 * A link to the page already showing ends in `NavigationSkipped`. Then focus moves
 * only if it was lost, as it is when the Browse menu or the mobile menu closes
 * around the link. A press on a control that stays on screen keeps its focus.
 *
 * The heading takes `tabindex="-1"` only while it holds focus, and
 * `data-route-focus` so `styles.css` draws no ring on it (the skip link's `<main>`
 * draws none either). Both go when focus next lands on another element, not on a
 * window or tab blur. Nothing is server-rendered, so
 * the cached HTML is unchanged.
 *
 * Browser-only and started once from the root component. The menus call
 * `focusPage()` for the one close that is not a navigation: the mobile menu closing
 * because the window grew to `lg` (`layout/nav-menu.ts`).
 */
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { Injectable, Injector, PLATFORM_ID, afterNextRender, inject } from '@angular/core';
import { NavigationEnd, NavigationSkipped, NavigationStart, Router } from '@angular/router';

/** The marker that keeps the ring off a heading that only holds focus for this. */
export const ROUTE_FOCUS_ATTR = 'data-route-focus';

/**
 * Marks a persistent section row (a `<nav>` that stays on screen, under a heading that
 * does not change, across the navigations its links make). Focus on a link inside it
 * stays there after the navigation.
 */
export const ROUTE_FOCUS_KEEP_ATTR = 'data-route-focus-keep';

/**
 * Whether an element is rendered and visible. `checkVisibility({ visibilityProperty: true })`
 * where the browser has it (Chrome 121, Firefox 122, Safari 17.4 for the option; an older
 * engine that has the method ignores the option and still checks `display`). It is false
 * for an element under `display: none`, `content-visibility: hidden` or `visibility:
 * hidden`. A browser with no `checkVisibility` at all counts only a `[hidden]` ancestor.
 */
export function isRendered(element: Element): boolean {
  if (element.closest('[hidden]')) return false;
  return typeof element.checkVisibility === 'function'
    ? element.checkVisibility({ visibilityProperty: true })
    : true;
}

/**
 * Focus is nowhere a reader can act from: on `<body>`, on nothing, on an element no longer
 * in the document, or on one that is hidden. The one test for "focus was lost", shared by
 * `RouteFocus` and the mobile menu (`layout/nav-menu.ts`).
 */
export function focusIsLost(doc: Document): boolean {
  const active = doc.activeElement;
  return !active || active === doc.body || !active.isConnected || !isRendered(active);
}

/** The path of a router URL: no query, no fragment. */
function pathOf(url: string): string {
  return url.split(/[?#]/, 1)[0] ?? url;
}

@Injectable({ providedIn: 'root' })
export class RouteFocus {
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private started = false;

  /** Watch navigations. Idempotent and a no-op on the server. */
  start(): void {
    if (this.started || !this.isBrowser) return;
    this.started = true;

    let lastPath: string | null = null;
    let trigger: Element | null = null;
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) {
        trigger = this.document.activeElement;
      } else if (event instanceof NavigationEnd) {
        const path = pathOf(event.urlAfterRedirects);
        const previous = lastPath;
        lastPath = path;
        if (previous === null || path === previous) return;
        const from = trigger;
        this.afterRender(() => {
          if (this.keepRowHoldsFocus() || this.pageTookFocus(from)) return;
          this.focusPage();
        });
      } else if (event instanceof NavigationSkipped) {
        this.afterRender(() => {
          if (this.focusIsLost()) this.focusPage();
        });
      }
    });
  }

  /**
   * Move focus to the page's first visible `h1` inside `<main id="main">`, or to
   * `<main>` itself. Never scrolls.
   */
  focusPage(): void {
    const main = this.document.getElementById('main');
    if (!main) return;
    const heading = [...main.querySelectorAll<HTMLElement>('h1')].find(isRendered);
    const target = heading ?? main;
    if (target !== main && !target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1');
      target.setAttribute(ROUTE_FOCUS_ATTR, '');
      // Clean up when focus lands somewhere else, not on `blur`: a heading also blurs
      // when the window or tab loses focus, and it must keep its `tabindex` then, so
      // the browser can give focus back to it on return.
      const doc = this.document;
      const onFocusIn = (event: FocusEvent) => {
        if (event.target === target) return;
        target.removeAttribute('tabindex');
        target.removeAttribute(ROUTE_FOCUS_ATTR);
        doc.removeEventListener('focusin', onFocusIn, true);
      };
      doc.addEventListener('focusin', onFocusIn, true);
    }
    target.focus({ preventScroll: true });
  }

  /**
   * Run once the navigation's view has rendered. The `read` phase runs after every
   * default-phase `afterNextRender` of the same render, so a page that focuses its own
   * element there has done so before this checks (`pageTookFocus`).
   */
  private afterRender(fn: () => void): void {
    afterNextRender({ read: fn }, { injector: this.injector });
  }

  private focusIsLost(): boolean {
    return focusIsLost(this.document);
  }

  /**
   * Focus is on an element inside a `data-route-focus-keep` row, still connected and
   * rendered: a persistent section row whose link the reader just pressed.
   */
  private keepRowHoldsFocus(): boolean {
    if (this.focusIsLost()) return false;
    return this.document.activeElement!.closest(`[${ROUTE_FOCUS_KEEP_ATTR}]`) !== null;
  }

  /**
   * The new page focused something itself: an element inside `<main>` or a
   * dialog that is not the link the visitor pressed.
   */
  private pageTookFocus(trigger: Element | null): boolean {
    if (this.focusIsLost()) return false;
    const active = this.document.activeElement!;
    if (active === trigger || active.matches('main#main')) return false;
    return active.closest('main#main, [role="dialog"], dialog, .cdk-overlay-container') !== null;
  }
}
