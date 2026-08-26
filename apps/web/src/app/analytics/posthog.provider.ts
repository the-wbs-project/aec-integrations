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
import { AnalyticsIdentity } from './analytics-identity';

export function providePostHog(): EnvironmentProviders {
  return provideAppInitializer(() => {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
    // Instantiate the root service so its consent effect + route tracking start.
    inject(Analytics);
    // …and the identity bridge (AECI-649 / §AW8), which resolves the Supabase
    // user id after the first render and hands it to `Analytics.identify()`.
    // Same reasoning as above: it must run on page load for every visitor, not
    // whenever some component happens to inject it — a signed-in visitor who
    // never opens a menu still has an identity to link.
    inject(AnalyticsIdentity);
  });
}
