import { DOCUMENT } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter } from 'rxjs';

import { ConsentService } from './consent';
import { AecButton } from '../shared/button/button';

/**
 * Analytics consent banner (AECI-239 / Phase 7.4).
 *
 * AECi is opt-in: PostHog never loads until the visitor accepts here. The banner
 * is **edge-cache neutral** — it renders nothing during SSR (`show` defaults
 * `false`) and only reveals itself post-hydration when `ConsentService.state()`
 * is `'unknown'`, mirroring the `ReviewCta` reconciliation pattern. A decision
 * (or Do-Not-Track) hides it for good; the choice lives in `localStorage`, so it
 * never reaches the Worker and can't poison the URL-keyed cache (§9.1a).
 *
 * Rendered once in the app shell (`app.ts`). Non-modal (it doesn't trap focus);
 * keyboard-reachable; all copy is `$localize`-wrapped; light-theme tokens only.
 *
 * Layout (AECI-1359): the fixed full-width wrapper is `pointer-events-none` and
 * only the visible card takes clicks, so the gutters beside the card never
 * swallow a click on the page underneath. While the banner shows, an in-flow
 * spacer (the last child of the app shell's column, after the footer) is sized
 * to the banner's measured height, so the footer's bottom row can scroll clear
 * of it. No global scroll offset is involved. The same height also becomes a
 * `scroll-margin-bottom` on every focusable element (AECI-1818, WCAG 2.4.11), so
 * a Tab never leaves the focused control hidden under the banner.
 *
 * Held off `/auth/terms` (AECI-1637, legal agent 2026-11-20): that page has one decision and
 * one "Accept", the Terms tick box, so a second "Accept" for cookies could be taken for it.
 * Only the banner is held: an undecided visitor stays undecided there, so product
 * analytics stays off (no choice means no Tier 3), Do-Not-Track and GPC work as anywhere
 * else, and the banner comes back on the next page.
 */
/** Routes that hold the banner off. Path only, query and fragment ignored. */
export function bannerHeldOn(url: string): boolean {
  return /^\/auth\/terms(?:[/?#]|$)/.test(url);
}

@Component({
  selector: 'aec-consent-banner',
  imports: [AecButton, RouterLink],
  template: `
    @if (visible()) {
      <div aria-hidden="true" [style.height.px]="reserve()"></div>
      <div
        #region
        class="pointer-events-none fixed inset-x-0 bottom-0 z-50 p-4"
        role="region"
        aria-label="Analytics consent"
        i18n-aria-label="@@analytics.consent.regionLabel"
      >
        <div
          class="aec-popover pointer-events-auto mx-auto flex max-w-3xl flex-col gap-4 p-5
            sm:flex-row sm:items-center sm:justify-between"
        >
          <p class="text-t-14 leading-6 text-(--text-secondary)">
            <span i18n="@@analytics.consent.message"
              >We use privacy-friendly product analytics to understand how the directory is used and
              make it better. No ads, and we never sell your data.</span
            >&ngsp;<a
              routerLink="/legal/privacy"
              class="text-(--accent-primary) underline underline-offset-2
                hover:text-(--accent-primary-hover)"
              i18n="@@analytics.consent.privacyLink"
              >Read our Privacy Policy</a
            >
          </p>
          <div class="flex shrink-0 gap-3">
            <button
              aecButton
              variant="secondary"
              id="consent-decline"
              type="button"
              (click)="decline()"
              i18n="@@analytics.consent.decline"
            >
              Decline
            </button>
            <button
              aecButton
              id="consent-accept"
              type="button"
              (click)="accept()"
              i18n="@@analytics.consent.accept"
            >
              Accept
            </button>
          </div>
        </div>
      </div>
    }
  `,
})
export class ConsentBanner {
  private readonly consent = inject(ConsentService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);

  private readonly router = inject(Router);

  /** SSR-neutral: hidden until reconciled in the browser. */
  protected readonly show = signal(false);

  /** The current URL, for the routes that hold the banner off. */
  private readonly url = signal(this.router.url);

  /** Shown when undecided, except on a route that holds it off. */
  protected readonly visible = computed(() => this.show() && !bannerHeldOn(this.url()));

  /** Height (px) the in-flow spacer reserves below the footer while visible. */
  protected readonly reserve = signal(0);

  private readonly region = viewChild<ElementRef<HTMLElement>>('region');

  constructor() {
    // WCAG 2.4.11 (AECI-1818): while the banner shows, publish its height on <html> so the
    // unlayered `html[data-consent-reserve]` rule in styles.css gives every focusable
    // element a matching `scroll-margin-bottom`. A control reached by Tab then scrolls
    // clear of the banner instead of landing under it. Removed when the banner goes.
    const root = this.document.documentElement;
    effect(() => {
      const height = this.visible() ? this.reserve() : 0;
      if (height > 0) {
        root.setAttribute('data-consent-reserve', '');
        root.style.setProperty('--aec-consent-reserve', `${height}px`);
      } else {
        root.removeAttribute('data-consent-reserve');
        root.style.removeProperty('--aec-consent-reserve');
      }
    });
    this.destroyRef.onDestroy(() => {
      root.removeAttribute('data-consent-reserve');
      root.style.removeProperty('--aec-consent-reserve');
    });

    // Track the fixed region's rendered height (it changes at the sm breakpoint
    // and with text wrapping). The region only exists in the browser, after
    // reconciliation, so ResizeObserver is never touched during SSR.
    let observer: ResizeObserver | undefined;
    this.destroyRef.onDestroy(() => observer?.disconnect());
    effect(() => {
      const el = this.region()?.nativeElement;
      observer?.disconnect();
      observer = undefined;
      if (!el || typeof ResizeObserver === 'undefined') {
        this.reserve.set(0);
        return;
      }
      observer = new ResizeObserver(() => this.reserve.set(el.offsetHeight));
      observer.observe(el);
      this.reserve.set(el.offsetHeight);
    });

    const sub = this.router.events
      .pipe(filter((e): e is NavigationEnd => e instanceof NavigationEnd))
      .subscribe((e) => this.url.set(e.urlAfterRedirects));
    this.destroyRef.onDestroy(() => sub.unsubscribe());

    // Browser-only (afterNextRender never runs during SSR), so reading consent
    // state here can't bake a visitor-specific banner into the cached HTML.
    afterNextRender(() => {
      this.show.set(this.consent.state() === 'unknown');
    });
  }

  protected accept(): void {
    this.consent.grant();
    this.show.set(false);
  }

  protected decline(): void {
    this.consent.deny();
    this.show.set(false);
  }
}
