import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { PageViewTracker } from './core/page-view-tracker';
import { SiteFooter } from './layout/site-footer';
import { SiteHeader } from './layout/site-header';
import { SkipLink } from './layout/skip-link';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, SiteHeader, SiteFooter, SkipLink],
  template: `
    <div class="flex min-h-screen flex-col bg-(--surface-base) text-(--text-primary)">
      <aec-skip-link />
      <aec-site-header />
      <main id="main" class="flex-1">
        <router-outlet />
      </main>
      <aec-site-footer />
    </div>
  `,
  styles: [':host { display: block; min-height: 100vh; }'],
})
export class App {
  private readonly pageViews = inject(PageViewTracker);

  constructor() {
    // AECI-151 — count in-app (client-side) navigations as page-views. The SSR
    // Worker only fires for full-document loads, so without this every
    // routerLink navigation after the first goes uncounted. No-op on the server.
    this.pageViews.start();
  }
}
