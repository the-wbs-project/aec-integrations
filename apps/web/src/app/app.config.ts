import { provideHttpClient, withFetch } from '@angular/common/http';
import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideClientHydration, withHttpTransferCacheOptions } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';

import { providePostHog } from './analytics/posthog.provider';
import { routes } from './app.routes';
import { provideDatadogRum } from './datadog.provider';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withFetch()),
    provideRouter(routes),
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
