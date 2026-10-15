import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';

import { ConsentService } from './consent';

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
 * of it. No global scroll offset is involved.
 */
@Component({
  selector: 'aec-consent-banner',
  imports: [RouterLink],
  template: `
    @if (show()) {
      <div aria-hidden="true" [style.height.px]="reserve()"></div>
      <div
        #region
        class="pointer-events-none fixed inset-x-0 bottom-0 z-50 p-4"
        role="region"
        aria-label="Analytics consent"
        i18n-aria-label="@@analytics.consent.regionLabel"
      >
        <div
          class="pointer-events-auto mx-auto flex max-w-3xl flex-col gap-4 rounded-(--radius-lg)
            border border-(--border-default) bg-(--surface-raised) p-5 shadow-lg
            sm:flex-row sm:items-center sm:justify-between"
        >
          <p class="text-sm/6 text-(--text-secondary)">
            <span i18n="@@analytics.consent.message"
              >We use privacy-friendly product analytics to understand how the directory is used and
              make it better. No ads, and we never sell your data.</span
            >&ngsp;<a
              routerLink="/legal/privacy"
              class="font-medium text-(--accent-primary) underline underline-offset-2
                hover:text-(--accent-primary-hover)"
              i18n="@@analytics.consent.privacyLink"
              >Read our Privacy Policy</a
            >
          </p>
          <div class="flex shrink-0 gap-3">
            <button
              id="consent-decline"
              type="button"
              (click)="decline()"
              class="inline-flex items-center justify-center rounded-(--radius-md)
                border border-(--border-default) bg-(--surface-base) px-4 py-2 text-sm
                font-medium text-(--text-primary) transition-colors
                hover:border-(--border-strong) focus-visible:outline-none
                focus-visible:ring-2 focus-visible:ring-(--accent-primary)
                focus-visible:ring-offset-2 focus-visible:ring-offset-(--surface-raised)"
              i18n="@@analytics.consent.decline"
            >
              Decline
            </button>
            <button
              id="consent-accept"
              type="button"
              (click)="accept()"
              class="inline-flex items-center justify-center rounded-(--radius-md)
                border border-(--border-strong) bg-(--accent-primary) px-4 py-2 text-sm
                font-bold text-(--surface-base) transition-colors
                hover:bg-(--accent-primary-hover) focus-visible:outline-none
                focus-visible:ring-2 focus-visible:ring-(--accent-primary)
                focus-visible:ring-offset-2 focus-visible:ring-offset-(--surface-raised)"
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

  /** SSR-neutral: hidden until reconciled in the browser. */
  protected readonly show = signal(false);

  /** Height (px) the in-flow spacer reserves below the footer while visible. */
  protected readonly reserve = signal(0);

  private readonly region = viewChild<ElementRef<HTMLElement>>('region');

  constructor() {
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
