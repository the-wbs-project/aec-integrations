import { provideHttpClient, withFetch } from '@angular/common/http';
import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideClientHydration, withHttpTransferCacheOptions } from '@angular/platform-browser';
import { provideRouter, withInMemoryScrolling } from '@angular/router';

import { providePostHog } from './analytics/posthog.provider';
import { routes } from './app.routes';
import { provideDatadogRum } from './datadog.provider';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withFetch()),
    provideRouter(
      routes,
      // Reset scroll on navigation so a new route opens at the top (SPA
      // navigations are same-document, so without this the browser keeps the
      // previous page's scroll offset — the new page renders scrolled down).
      // `'enabled'` is the standard-website behavior: forward navigations scroll
      // to top, Back/Forward restores the prior scroll position. `anchorScrolling`
      // is a no-op for today's section-nav (those are native `<a href="#id">`
      // clicks the browser handles, not router navigations) but is the correct
      // pairing and future-proofs any `routerLink [fragment]`. The route-reset
      // scroll is forced instant (bypassing the global `scroll-behavior: smooth`,
      // which `window.scrollTo` otherwise honors) by the browser-only hook in
      // `App` — see `app.ts`.
      withInMemoryScrolling({
        scrollPositionRestoration: 'enabled',
        anchorScrolling: 'enabled',
      }),
    ),
    provideClientHydration(
      // Angular v22 incremental hydration is on by default and auto-enables event
      // replay (withIncrementalHydration internally adds withEventReplay), so the
      // explicit withEventReplay() is redundant. The two detail-page
      // `@defer (… ; hydrate on viewport)` grids SSR-render their (resolver-only,
      // visitor-state-neutral) content, so they stay edge-cache-neutral — see
      // docs/CACHE_STRATEGY.md §6 and AECI-130.
      withHttpTransferCacheOptions({ includePostRequests: false }),
    ),
    provideDatadogRum(),
    providePostHog(),
  ],
};
