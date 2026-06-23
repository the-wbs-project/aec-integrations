/**
 * The PostHog SDK boundary (AECI-239 / §14.1).
 *
 * `posthog-js` is a browser-only SDK whose module-level code touches `window`,
 * so it is reached ONLY through a dynamic `import()` inside a browser-gated
 * caller (`Analytics`) — the same discipline as `datadog.provider.ts` /
 * `search-rum.ts`, keeping the SDK out of the SSR bundle entirely.
 *
 * `createPostHogClient` is exposed behind the `POSTHOG_CLIENT_FACTORY`
 * injection token so unit tests swap a fake client (the `SearchQueryEmitter` /
 * `SEARCH_ENGINE_FACTORY` seam idiom): the `Analytics` service injects the
 * token, never imports the SDK directly, and tests assert `capture(...)` calls
 * on a `vi.fn()` without loading `posthog-js`.
 *
 * Init choices:
 *   - `capture_pageview: 'history_change'` — auto-captures the initial pageview
 *     AND every SPA navigation (Angular Router drives `history.pushState`), so
 *     the "automatic pageview tracking" AC needs no manual Router wiring.
 *   - `loaded: (ph) => ph.register(analyticsDimensions())` — registers
 *     `locale`/`theme` as super-properties BEFORE the first auto-pageview, so
 *     even autocaptured events carry the dimensions.
 *   - `autocapture: false` — we only want the 7 named events + pageviews; no
 *     blanket DOM-interaction capture (leaner payloads, fewer privacy surfaces).
 *   - `disable_external_dependency_loading: true` — the bundled SDK never injects
 *     a remote `<script>`, so the CSP `script-src` stays untouched; only the two
 *     `connect-src` PostHog hosts are needed (`server/seo-headers.ts`).
 *   - `respect_dnt: true` — belt-and-suspenders with the consent layer, which
 *     already treats DNT as a hard "denied" (`consent.ts`).
 */
import { InjectionToken } from '@angular/core';

import { analyticsDimensions } from './analytics-dimensions';
import { readPostHogConfig } from './posthog-config';

/**
 * The minimal structural surface the `Analytics` service uses. The real
 * `posthog` singleton satisfies it; test fakes implement just these two methods.
 */
export interface PostHogClient {
  capture(event: string, properties?: Record<string, unknown>): unknown;
  register(properties: Record<string, unknown>): void;
}

/** Resolves the initialized client, or `null` when analytics is unavailable. */
export type PostHogClientFactory = () => Promise<PostHogClient | null>;

/**
 * Loads + initializes `posthog-js`, returning the client (or `null` when config
 * is absent or the SDK fails to load — analytics MUST never break the app).
 */
export async function createPostHogClient(): Promise<PostHogClient | null> {
  const cfg = readPostHogConfig();
  if (!cfg) return null;
  try {
    const { default: posthog } = await import('posthog-js');
    posthog.init(cfg.key, {
      api_host: cfg.host,
      capture_pageview: 'history_change',
      autocapture: false,
      disable_external_dependency_loading: true,
      respect_dnt: true,
      persistence: 'localStorage+cookie',
      loaded: (ph) => ph.register(analyticsDimensions()),
    });
    return posthog;
  } catch (error: unknown) {
    // Analytics MUST NOT break the app — swallow load/init failures.
    console.warn('PostHog failed to initialise', error);
    return null;
  }
}

/**
 * Injectable seam for the client factory. Default = `createPostHogClient` (the
 * real SDK); specs override it with a fake so `capture`/`register` are asserted
 * without `posthog-js`.
 */
export const POSTHOG_CLIENT_FACTORY = new InjectionToken<PostHogClientFactory>(
  'POSTHOG_CLIENT_FACTORY',
  { providedIn: 'root', factory: () => createPostHogClient },
);
