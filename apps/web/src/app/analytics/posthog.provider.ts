/**
 * PostHog bootstrap provider (AECI-239 / §14.1; two-mode init AECI-643).
 *
 * The `Analytics` service is `providedIn: 'root'`, so it would otherwise only be
 * constructed on first injection. This provider forces it to exist at app
 * bootstrap (browser only), which is what makes the Tier 2 operational slice a
 * genuine every-visitor signal: the client boots and `app_started` fires on
 * page load rather than whenever some component happens to inject `Analytics`.
 * It also puts the consent `effect` live immediately, so a returning visitor
 * whose decision is already `'granted'` upgrades to Tier 3 (and captures the
 * initial `$pageview`) straight away. Mirrors `provideDatadogRum()`'s
 * app-initializer shape.
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
