/**
 * PostHog bootstrap provider (AECI-239 / §14.1).
 *
 * The `Analytics` service is `providedIn: 'root'`, so it would otherwise only be
 * constructed on first injection. This provider forces it to exist at app
 * bootstrap (browser only) so its consent `effect` is live immediately — a
 * returning visitor whose decision is already `'granted'` then boots PostHog
 * (and captures the initial pageview) without waiting for the first detail page
 * to inject `Analytics`. Mirrors `provideDatadogRum()`'s app-initializer shape.
 */
import { isPlatformBrowser } from '@angular/common';
import {
  type EnvironmentProviders,
  PLATFORM_ID,
  inject,
  provideAppInitializer,
} from '@angular/core';

import { Analytics } from './analytics';

export function providePostHog(): EnvironmentProviders {
  return provideAppInitializer(() => {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
    // Instantiate the root service so its consent effect + route tracking start.
    inject(Analytics);
  });
}
