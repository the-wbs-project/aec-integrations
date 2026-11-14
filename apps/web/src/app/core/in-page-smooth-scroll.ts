/**
 * Smooth scrolling for in-page section links, and nothing else (AECI-1752).
 *
 * Clash 38 of the November 2026 redesign (ADR 0056, PLAN.md §4.6) rules smooth
 * scrolling "In-page section links only. Never a global setting. Off under
 * reduced motion." Until then `styles.css` carried `html { scroll-behavior:
 * smooth }`, which animated every scroll that did not opt out: the skip link,
 * `scrollIntoView()` calls, and any `window.scrollTo` without a `behavior`.
 *
 * **How it works.** The CSS rule now needs a class on `<html>`:
 * `html.aeci-smooth-scroll { scroll-behavior: smooth }`, inside
 * `@media (prefers-reduced-motion: no-preference)`. This service puts that class
 * on `<html>` for the span of one jump. A delegated `click` listener on the
 * document looks for an `<a data-smooth-scroll>` whose href points at the
 * current page plus a `#fragment`. It adds the class before the browser runs the
 * link's default action, so the browser's own fragment scroll animates and
 * still honours the target's `scroll-margin-top`. The class comes off at the
 * `scrollend` event, or after {@link SMOOTH_SCROLL_DISARM_MS} when no scroll
 * happens. The service never calls `preventDefault` and never scrolls itself.
 *
 * Opt a link in with the bare `data-smooth-scroll` attribute. Today that is the
 * product page section nav (`shared/section-nav/section-nav.ts`), its "N
 * reviews" link, and the account page nav (`account/account.html`). The skip
 * link stays out on purpose: it moves focus, and an animated jump there only
 * delays the reader.
 *
 * **The switch back to the old global behaviour.** Add
 * `class="aeci-smooth-scroll"` to the `<html>` element in `apps/web/src/index.html`.
 * The CSS rule then applies on every page from the first paint, including the
 * server-rendered HTML. {@link InPageSmoothScroll.start} sees the class and
 * stands down, so it never strips it. Nothing else changes: `ScrollBehaviorManager`
 * still forces router scrolls instant, and reduced motion still wins.
 *
 * **What it does not touch.** Router scroll restoration, `ScrollBehaviorManager`,
 * `ScrollMarginViewportScroller`, `InitialFragmentScroller` and
 * `PreStableScrollReset` are unchanged. A router navigation that starts while a
 * jump is armed still scrolls instantly, because `ScrollBehaviorManager` sets an
 * inline `scroll-behavior: auto`, which beats the class rule.
 *
 * Browser-only (a no-op on the server) and started once from the root component.
 * The listener is added in code, not in a template, so Angular's event replay
 * never sees it (`ANGULAR_STYLE_GUIDE.md`, event replay). A click made before
 * this starts gets the native instant jump.
 */
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { DestroyRef, PLATFORM_ID, Service, inject } from '@angular/core';

/** The class on `<html>` that turns on `scroll-behavior: smooth` (`styles.css`). */
export const SMOOTH_SCROLL_CLASS = 'aeci-smooth-scroll';

/** The attribute that opts an in-page link into a smooth jump. */
export const SMOOTH_SCROLL_LINK_ATTR = 'data-smooth-scroll';

/**
 * How long the class may stay on when no `scrollend` arrives: the target was
 * already in place, or the browser has no `scrollend`. Longer than a browser's
 * smooth scroll takes, which is well under a second in Chrome, Firefox and
 * Safari.
 */
export const SMOOTH_SCROLL_DISARM_MS = 1500;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

@Service()
export class InPageSmoothScroll {
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));
  private started = false;
  private disarmTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly onScrollEnd = () => this.disarm();

  private readonly onClick = (event: MouseEvent) => {
    if (!this.isSameDocumentJump(event)) return;
    if (this.document.defaultView?.matchMedia?.(REDUCED_MOTION_QUERY).matches) return;
    this.arm();
  };

  /**
   * Begin listening for in-page link clicks. Idempotent and a no-op on the
   * server. Stands down when `<html>` already carries the class, which is the
   * switch back to the old global behaviour (see the file docblock).
   */
  start(): void {
    if (this.started || !this.isBrowser) return;
    this.started = true;
    if (this.document.documentElement.classList.contains(SMOOTH_SCROLL_CLASS)) return;

    this.document.addEventListener('click', this.onClick);
    this.destroyRef.onDestroy(() => {
      this.document.removeEventListener('click', this.onClick);
      this.disarm();
    });
  }

  /** True for an unmodified primary click on an opted-in link to `#id` on this page. */
  private isSameDocumentJump(event: MouseEvent): boolean {
    if (event.defaultPrevented || event.button !== 0) return false;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false;
    const target = event.target;
    if (!(target instanceof Element)) return false;
    const link = target.closest(`a[${SMOOTH_SCROLL_LINK_ATTR}]`);
    if (!(link instanceof HTMLAnchorElement) || !link.hash) return false;
    if (link.target && link.target !== '_self') return false;
    const here = this.document.location;
    return (
      link.origin === here.origin && link.pathname === here.pathname && link.search === here.search
    );
  }

  private arm(): void {
    this.clearTimer();
    this.document.documentElement.classList.add(SMOOTH_SCROLL_CLASS);
    this.document.addEventListener('scrollend', this.onScrollEnd, { once: true });
    this.disarmTimer = setTimeout(() => this.disarm(), SMOOTH_SCROLL_DISARM_MS);
  }

  private disarm(): void {
    this.clearTimer();
    this.document.removeEventListener('scrollend', this.onScrollEnd);
    this.document.documentElement.classList.remove(SMOOTH_SCROLL_CLASS);
  }

  private clearTimer(): void {
    if (this.disarmTimer !== null) clearTimeout(this.disarmTimer);
    this.disarmTimer = null;
  }
}
