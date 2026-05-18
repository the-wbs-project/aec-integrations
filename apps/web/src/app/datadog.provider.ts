/**
 * Browser RUM bootstrap.
 *
 * `@datadog/browser-rum` is a browser-only SDK — its module-level code touches
 * `window`, so a static import would crash SSR. We dynamic-`import()` it inside
 * an `provideAppInitializer` callback that early-returns on the server,
 * keeping the SDK out of the SSR bundle entirely and guaranteeing
 * `datadogRum.init()` only ever runs in the browser.
 *
 * Public credentials (`applicationId`, `clientToken`, `site`, `env`) are
 * delivered by the SSR Worker as a tiny `<script>window.__AECI_DD__=...` tag
 * inlined into the HTML head — see `../server-bootstrap-inject.ts`. When the
 * config is missing (dev without secrets provisioned, or any env where RUM is
 * intentionally off), the initializer no-ops so the page still hydrates.
 */

import { isPlatformBrowser } from '@angular/common';
import {
  inject,
  PLATFORM_ID,
  provideAppInitializer,
  type EnvironmentProviders,
} from '@angular/core';

import type { DatadogPublicConfig } from '../env';

function readBootstrap(): DatadogPublicConfig | null {
  const cfg = (globalThis as { __AECI_DD__?: DatadogPublicConfig }).__AECI_DD__;
  if (!cfg?.applicationId || !cfg?.clientToken) return null;
  return cfg;
}

export function provideDatadogRum(): EnvironmentProviders {
  return provideAppInitializer(() => {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
    const cfg = readBootstrap();
    if (!cfg) return;

    void import('@datadog/browser-rum')
      .then(({ datadogRum }) => {
        datadogRum.init({
          applicationId: cfg.applicationId,
          clientToken: cfg.clientToken,
          site: cfg.site,
          service: 'aeci-web',
          env: cfg.env,
          sessionSampleRate: 100,
          // Phase 1: session replay is opt-out per AECI-31. Enable in a later
          // phase once we have a privacy review on replay payloads.
          sessionReplaySampleRate: 0,
          trackUserInteractions: true,
          defaultPrivacyLevel: 'mask-user-input',
        });
        // AECI-31 smoke signal: emit a custom action on every browser
        // bootstrap so RUM Explorer shows an `aeci.app_started` event within
        // ~30s of any page load. Confirms the browser → Datadog pipe without
        // waiting for organic interactions / errors.
        datadogRum.addAction('aeci.app_started', {
          env: cfg.env,
          buildAt: new Date().toISOString(),
        });
      })
      .catch((error: unknown) => {
        // Observability MUST NOT break the app — swallow load failures.
        console.warn('Datadog RUM failed to initialise', error);
      });
  });
}
