/**
 * Scrolls to the URL fragment (`#section`) on the *initial* page load — the one
 * case Angular's router leaves unhandled.
 *
 * `provideRouter(..., withInMemoryScrolling({ anchorScrolling: 'enabled' }))`
 * (app.config.ts) sets `history.scrollRestoration = 'manual'`, which disables the
 * browser's own native "jump to `#id` on load". The router's `RouterScroller`
 * then owns anchor scrolling — but it only acts on navigations that emit a
 * `Scroll` event, and the **initial hydration navigation does not emit one** (see
 * the note in `scroll-behavior-manager.ts`). Net effect before this manager: a
 * reload or an externally-shared deep link to `/products/x#integrations` lands at
 * the top of the page instead of on the section. In-app navigations to a hashed
 * URL still work (they emit `Scroll`), so only the first load needed fixing.
 *
 * The fix: on the first `NavigationEnd` (the initial hydration navigation, which
 * the root component's subscription catches — same guarantee `ScrollBehaviorManager`
 * relies on), read `location.hash` and, if it targets an element, scroll to it.
 * We then unsubscribe so every later navigation is left to `RouterScroller`.
 *
 * Two details:
 * - We use `Element.scrollIntoView()` rather than `ViewportScroller.scrollToAnchor()`
 *   because `scrollIntoView` honors the target's CSS `scroll-margin-top` (the
 *   `scroll-mt-20` on each detail section that clears the sticky section-nav),
 *   matching how the native section-nav `<a href="…#id">` clicks already scroll.
 *   The scroll is forced `'instant'` — a deep link should land immediately, like a
 *   native fragment load, not animate a long glide from the top.
 * - Page-detail CLS (late-loading media above the anchor can shift it after the
 *   first jump) is re-asserted once, shortly after, but only while the visitor
 *   hasn't scrolled away themselves.
 *
 * Browser-only (no-op on the server) and started once from the root component.
 */
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { Injectable, PLATFORM_ID, inject } from '@angular/core';
import { NavigationEnd, Router } from '@angular/router';

/** How long after the first jump we re-check for layout shift above the anchor. */
const RE_ASSERT_DELAY_MS = 300;
/** Tolerance (px) for deciding the visitor hasn't taken over scrolling. */
const USER_SCROLL_TOLERANCE_PX = 4;

@Injectable({ providedIn: 'root' })
export class InitialFragmentScroller {
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private started = false;

  /**
   * Begin watching for the initial navigation's fragment. Idempotent and a no-op
   * on the server. Called once from the root component at bootstrap.
   */
  start(): void {
    if (this.started || !this.isBrowser) return;
    this.started = true;

    const sub = this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        // Only the first (initial hydration) navigation — subsequent in-app
        // navigations to a hashed URL emit a `Scroll` event and are handled by
        // the router's own `RouterScroller`.
        sub.unsubscribe();
        this.scrollToInitialFragment();
      }
    });
  }

  private scrollToInitialFragment(): void {
    const win = this.document.defaultView;
    if (!win) return;

    const raw = win.location.hash.replace(/^#/, '');
    if (!raw) return;
    // A crafted URL can carry malformed percent-encoding; fall back to the raw id
    // rather than throwing inside the router-event callback.
    let id: string;
    try {
      id = decodeURIComponent(raw);
    } catch {
      id = raw;
    }

    const scrollToTarget = (): boolean => {
      const el =
        this.document.getElementById(id) ?? this.document.getElementsByName(id).item(0) ?? null;
      // `scrollIntoView` (unlike `ViewportScroller.scrollToAnchor`) honors the
      // target's `scroll-margin-top`, so the heading clears the sticky nav.
      if (el) el.scrollIntoView({ block: 'start', behavior: 'instant' as ScrollBehavior });
      return el !== null;
    };

    // Defer one frame so the hydrated view is laid out before we measure.
    win.requestAnimationFrame(() => {
      if (!scrollToTarget()) return;
      const expectedY = Math.round(win.scrollY);
      // Media above the anchor can load and shift it after the first jump.
      // Re-assert once — but never yank a visitor who has started scrolling.
      win.setTimeout(() => {
        if (Math.abs(win.scrollY - expectedY) < USER_SCROLL_TOLERANCE_PX) scrollToTarget();
      }, RE_ASSERT_DELAY_MS);
    });
  }
}
