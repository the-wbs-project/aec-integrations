import { provideHttpClient, withFetch } from '@angular/common/http';
import {
  ApplicationConfig,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import {
  provideClientHydration,
  withEventReplay,
  withHttpTransferCacheOptions,
  withNoIncrementalHydration,
} from '@angular/platform-browser';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { provideDatadogRum } from './datadog.provider';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(withFetch()),
    provideRouter(routes),
    provideClientHydration(
      withEventReplay(),
      withHttpTransferCacheOptions({ includePostRequests: false }),
      // v22 makes incremental hydration the default; opt out to keep pre-v22
      // eager hydration behavior for this PR. Adopting incremental hydration is
      // tracked as a separate follow-up (see the Angular v22 upgrade plan).
      withNoIncrementalHydration(),
    ),
    provideDatadogRum(),
  ],
};
