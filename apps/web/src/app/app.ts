import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { ConsentBanner } from './analytics/consent-banner';
import { PageViewTracker } from './core/page-view-tracker';
import { ScrollBehaviorManager } from './core/scroll-behavior-manager';
import { SiteFooter } from './layout/site-footer';
import { SiteHeader } from './layout/site-header';
import { SkipLink } from './layout/skip-link';
import { WaitlistWelcome } from './waitlist/waitlist-welcome';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, SiteHeader, SiteFooter, SkipLink, ConsentBanner, WaitlistWelcome],
  template: `
    <div class="flex min-h-screen flex-col bg-(--surface-base) text-(--text-primary)">
      <aec-skip-link />
      <aec-site-header />
      <aec-waitlist-welcome />
      <main id="main" class="flex-1">
        <router-outlet />
      </main>
      <aec-site-footer />
      <aec-consent-banner />
    </div>
  `,
  styles: [':host { display: block; min-height: 100vh; }'],
})
export class App {
  private readonly pageViews = inject(PageViewTracker);
  private readonly scrollBehavior = inject(ScrollBehaviorManager);

  constructor() {
    // AECI-151 — count in-app (client-side) navigations as page-views. The SSR
    // Worker only fires for full-document loads, so without this every
    // routerLink navigation after the first goes uncounted. No-op on the server.
    this.pageViews.start();

    // Keep the router's scroll-to-top reset (withInMemoryScrolling, see
    // app.config.ts) instant despite the global `scroll-behavior: smooth`. No-op
    // on the server.
    this.scrollBehavior.start();
  }
}
