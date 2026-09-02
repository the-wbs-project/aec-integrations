import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import {
  ApplicationConfig,
  ErrorHandler,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import { provideClientHydration, withHttpTransferCacheOptions } from '@angular/platform-browser';
import { provideRouter, withInMemoryScrolling } from '@angular/router';

import { PosthogErrorHandler } from './analytics/posthog-error-handler';
import { providePostHog } from './analytics/posthog.provider';
import { routes } from './app.routes';
import { serverApiInterceptor } from './core/server-api-interceptor';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    // Routes `window.onerror` / `unhandledrejection` into the ErrorHandler
    // below, which is what makes the PostHog handler cover global errors too
    // (Angular otherwise swallows application errors before either fires).
    provideBrowserGlobalErrorListeners(),
    // AECI-643 / POSTHOG_MIGRATION_SPEC §3.3 (Tier 2): report Angular
    // application errors to PostHog, and keep logging them to the console.
    { provide: ErrorHandler, useExisting: PosthogErrorHandler },
    // `serverApiInterceptor` fulfils relative `/api/*` GETs through the Cloudflare
    // service binding while rendering on the server, and passes everything else
    // straight through (AECI-746). Registered HERE rather than in
    // `app.config.server.ts` because that config is merged with this one and a
    // second `provideHttpClient(...)` would configure the client twice; the
    // interceptor no-ops on the browser instead.
    provideHttpClient(withFetch(), withInterceptors([serverApiInterceptor])),
    provideRouter(
      routes,
      // Reset scroll on navigation so a new route opens at the top (SPA
      // navigations are same-document, so without this the browser keeps the
      // previous page's scroll offset — the new page renders scrolled down).
      // `'enabled'` is the standard-website behavior: forward navigations scroll
      // to top, Back/Forward restores the prior scroll position. `anchorScrolling`
      // handles in-app navigations to a hashed URL (a `routerLink [fragment]`, or a
      // link from another page to `/products/x#integrations`); today's section-nav
      // uses native `<a href="…#id">` same-document clicks the browser scrolls
      // itself. It does NOT cover the *initial* load, though: this sets
      // `history.scrollRestoration = 'manual'` (disabling the browser's native
      // fragment scroll) and the router emits no `Scroll` event on the initial
      // hydration navigation — so a reload or deep link to `…#integrations` is
      // scrolled by the browser-only `InitialFragmentScroller` (see `app.ts`). The
      // route-reset scroll is forced instant (bypassing the global
      // `scroll-behavior: smooth`, which `window.scrollTo` otherwise honors) by the
      // browser-only `ScrollBehaviorManager`, also in `App`.
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
    providePostHog(),
  ],
};
