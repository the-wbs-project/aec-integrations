import { Component, afterNextRender, inject, signal } from '@angular/core';

import { WAITLIST_REF_SOURCE, WaitlistWelcomeService } from './waitlist-welcome.service';

/**
 * Waitlist welcome banner (AECI-243 / Phase 7.9, §11.2).
 *
 * A small, dismissible "Thanks for waiting" strip shown to subscribers arriving
 * from the launch email's `?ref=waitlist&token=xyz` link. It is **edge-cache
 * neutral** (§9.1a): `show` defaults `false` so SSR renders nothing, and the
 * banner only reveals itself post-hydration inside `afterNextRender` — mirroring
 * `ConsentBanner`. The same browser-only pass logs the campaign token to
 * `page_views` once (via `WaitlistWelcomeService`), and dismissal persists in
 * `localStorage`, so no visitor state ever reaches the URL-keyed cache.
 *
 * Display and attribution are independent: the banner shows for any
 * `?ref=waitlist` arrival, while the token POST fires only when a token is
 * present (and hasn't been logged before).
 *
 * Rendered once in the app shell (`app.ts`). Non-modal; keyboard-reachable; all
 * copy is i18n-wrapped; light-theme tokens only.
 */
@Component({
  selector: 'aec-waitlist-welcome',
  template: `
    @if (show()) {
      <aside
        class="border-b border-(--border-default) bg-(--accent-primary-soft)"
        role="region"
        aria-label="Waitlist welcome"
        i18n-aria-label="@@waitlist.welcome.regionLabel"
      >
        <div class="mx-auto flex max-w-7xl items-center justify-between gap-4 px-8 py-3">
          <p class="text-sm/6 text-(--text-primary)" i18n="@@waitlist.welcome.message">
            Thanks for waiting. Here's the directory.
          </p>
          <button
            id="waitlist-dismiss"
            type="button"
            (click)="dismiss()"
            class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-(--radius-md)
              border border-(--border-default) bg-(--surface-base) text-(--text-secondary)
              transition-colors hover:border-(--border-strong) hover:text-(--accent-primary)
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--accent-primary)
              focus-visible:ring-offset-2 focus-visible:ring-offset-(--accent-primary-soft)"
            i18n-aria-label="@@waitlist.welcome.dismiss"
            aria-label="Dismiss"
          >
            <svg
              aria-hidden="true"
              class="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
      </aside>
    }
  `,
})
export class WaitlistWelcome {
  private readonly welcome = inject(WaitlistWelcomeService);

  /** SSR-neutral: hidden until reconciled in the browser. */
  protected readonly show = signal(false);

  constructor() {
    // Browser-only (afterNextRender never runs during SSR), so neither the
    // reveal decision nor the attribution POST can pollute the cached HTML.
    //
    // Read straight from `location.search`, NOT from an injected
    // `ActivatedRoute`/`Router`: this component lives in the app shell (not a
    // routed outlet), where the root ActivatedRoute carries no query params, and
    // the router's initial navigation may not have resolved the query string by
    // the time this fires. `location` is the ground truth and is browser-only.
    afterNextRender(() => {
      const params = new URLSearchParams(globalThis.location?.search ?? '');
      const isWaitlist = params.get('ref') === WAITLIST_REF_SOURCE;
      this.show.set(isWaitlist && !this.welcome.isDismissed());
      if (isWaitlist) this.welcome.logAttribution(params.get('token'));
    });
  }

  protected dismiss(): void {
    this.welcome.dismiss();
    this.show.set(false);
  }
}
