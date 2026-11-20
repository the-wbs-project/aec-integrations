import { DOCUMENT } from '@angular/common';
import { ApplicationRef, Component, afterNextRender, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { ConsentBanner } from './analytics/consent-banner';
import { AppUpdateService } from './core/app-update/app-update.service';
import { UpdateBanner } from './core/app-update/update-banner';
import { ArrivalCaptureService } from './core/arrival-capture.service';
import { InPageSmoothScroll } from './core/in-page-smooth-scroll';
import { InitialFragmentScroller } from './core/initial-fragment-scroller';
import { PageViewTracker } from './core/page-view-tracker';
import { PreStableScrollReset } from './core/pre-stable-scroll-reset';
import { ScrollBehaviorManager } from './core/scroll-behavior-manager';
import { LegalNoticeBand } from './legal/legal-notice-band';
import { SiteFooter } from './layout/site-footer';
import { SiteHeader } from './layout/site-header';
import { SkipLink } from './layout/skip-link';
import { AppLive } from './shared/form-field/consent-box';
import { stopEarlyInput } from './shared/form-field/early-input';
import { WaitlistWelcome } from './waitlist/waitlist-welcome';

@Component({
  selector: 'app-root',
  imports: [
    RouterOutlet,
    SiteHeader,
    SiteFooter,
    SkipLink,
    LegalNoticeBand,
    ConsentBanner,
    UpdateBanner,
    WaitlistWelcome,
  ],
  template: `
    <div class="flex min-h-screen flex-col bg-(--surface-base) text-(--text-primary)">
      <aec-skip-link />
      <aec-site-header />
      <aec-legal-notice-band />
      <aec-waitlist-welcome />
      <main id="main" tabindex="-1" class="flex-1 outline-none">
        <router-outlet />
      </main>
      <aec-site-footer />
      <aec-consent-banner />
      <aec-update-banner />
    </div>
  `,
  styles: [':host { display: block; min-height: 100vh; }'],
})
export class App {
  private readonly pageViews = inject(PageViewTracker);
  private readonly scrollBehavior = inject(ScrollBehaviorManager);
  private readonly inPageSmoothScroll = inject(InPageSmoothScroll);
  private readonly initialFragmentScroller = inject(InitialFragmentScroller);
  private readonly preStableScrollReset = inject(PreStableScrollReset);
  private readonly arrivalCapture = inject(ArrivalCaptureService);
  private readonly appUpdate = inject(AppUpdateService);
  private readonly appRef = inject(ApplicationRef);
  // AECI-1720 — injected here so `AppLive` starts at bootstrap, and a consent box drawn
  // after the first render is enabled from its first frame (`shared/form-field/consent-box.ts`).
  protected readonly appLive = inject(AppLive);
  private readonly document = inject(DOCUMENT);

  constructor() {
    // AECI-151 — count in-app (client-side) navigations as page-views. The SSR
    // Worker only fires for full-document loads, so without this every
    // routerLink navigation after the first goes uncounted. No-op on the server.
    this.pageViews.start();

    // Keep the router's scroll-to-top reset (withInMemoryScrolling, see
    // app.config.ts) instant even while smooth scrolling is on. No-op on the
    // server.
    this.scrollBehavior.start();

    // AECI-1752 — smooth-scroll only the jump from an in-page section link
    // (`<a data-smooth-scroll>`). The switch back to a global smooth scroll is
    // documented in the service. No-op on the server.
    this.inPageSmoothScroll.start();

    // Scroll to the URL fragment (`#section`) on the initial load — a reload or
    // deep link to `…#integrations`. The router's anchor scrolling doesn't fire on
    // the initial hydration navigation, and `scrollRestoration: 'manual'` disables
    // the browser's native fragment scroll. No-op on the server. See the manager.
    this.initialFragmentScroller.start();

    // AECI-1629 — the router skips its scroll reset for any navigation that ends
    // before the app is first stable (a row clicked while the facets request is
    // still loading). This performs that reset only when the router stayed silent.
    // No-op on the server. See the service.
    this.preStableScrollReset.start();

    // AECI-1208 — report the landing URL's `utm_source` / `utm_campaign` / `n`
    // once the visitor is signed in, for the daily activity row. Browser-only,
    // no storage, once per app instance. No-op on the server.
    this.arrivalCapture.start();

    // AECI-1493 — notice when a deploy has replaced this tab's build, so a
    // stale chunk never leaves the visitor stuck. No-op on the server.
    this.appUpdate.start();

    // AECI-1720 — the inline recorder in index.html keeps what a visitor typed before
    // hydration, for `AecEarlyInput` to put back. Every server-rendered field has
    // taken its value by the time the app is first stable, so the recorder stops
    // then: its listeners and values go and its global is deleted. Browser only.
    afterNextRender(() => {
      void this.appRef.whenStable().then(() => stopEarlyInput(this.document.defaultView));
    });
  }
}
