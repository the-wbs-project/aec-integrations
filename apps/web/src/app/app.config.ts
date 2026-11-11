import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';
import {
  ApplicationConfig,
  ErrorHandler,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import {
  provideClientHydration,
  withHttpTransferCacheOptions,
  withI18nSupport,
} from '@angular/platform-browser';
import { provideRouter, withInMemoryScrolling, withNavigationErrorHandler } from '@angular/router';

import { PosthogErrorHandler } from './analytics/posthog-error-handler';
import { providePostHog } from './analytics/posthog.provider';
import { routes } from './app.routes';
import { reloadOnChunkLoadError } from './core/app-update/app-update.service';
import { provideScrollMarginViewportScroller } from './core/scroll-margin-viewport-scroller';
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
      // link from another page to `/products/x#integrations`) — AND, less
      // obviously, the section-nav's own native `<a href="…#id">` clicks: a
      // same-document fragment navigation fires `popstate`, which Angular treats as
      // a browser-driven navigation, so the router asks to re-scroll to the fragment
      // while the browser's smooth scroll is still running. That is why
      // `provideScrollMarginViewportScroller()` below is not optional — it skips that
      // scroll, which would otherwise park each section under the sticky nav and
      // desync Safari's hit-testing from what it paints. It does NOT cover
      // the *initial* load, though: this sets
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
      // AECI-1493: a lazy route whose chunk a deploy deleted becomes a full page
      // load of its target instead of a navigation that silently goes nowhere.
      withNavigationErrorHandler(reloadOnChunkLoadError),
    ),
    // Overrides the `providedIn: 'root'` `ViewportScroller` that `RouterScroller`
    // injects, so the router's anchor scroll honors each section's `scroll-mt-20`
    // instead of hiding the heading behind the sticky section-nav. `@angular/router`
    // never provides that token itself, so array position does not decide the
    // winner; this sits next to `provideRouter(...)` only because that is what it
    // affects. See `core/scroll-margin-viewport-scroller.ts`.
    provideScrollMarginViewportScroller(),
    provideClientHydration(
      // `withI18nSupport()` is load-bearing (AECI-1655). Without it Angular
      // stamps `ngSkipHydration` on every component whose template uses `i18n`,
      // which here is the header, the footer and every page body. Those views are
      // destroyed and re-rendered on the client instead of hydrated, no listener
      // is annotated, and the server drops the event-replay contract script.
      //
      // Angular v22 incremental hydration is on by default and adds event replay
      // itself (withIncrementalHydration includes withEventReplay), so no
      // explicit withEventReplay(). With hydration working, the inline contract
      // queues a click on a button before hydration and replays it once the
      // listener exists. The inline contract never calls preventDefault, so a
      // click on an `<a href>` before hydration still follows the href as a full
      // load. That click is queued too, and replays into the handler if the app
      // is stable before the page unloads. On a replay Angular makes
      // `preventDefault()` throw, so every handler that calls it returns early
      // first via `isReplayedEvent` (core/event-replay.ts). An anchor that relies
      // on its native default carries no listener of its own, or every later
      // click on it is prevented (ANGULAR_STYLE_GUIDE.md §3, SectionNav).
      //
      // The two detail-page `@defer (… ; hydrate on viewport)` grids SSR-render
      // their (resolver-only, visitor-state-neutral) content, so they stay
      // edge-cache-neutral — see docs/CACHE_STRATEGY.md §6 and AECI-130.
      withI18nSupport(),
      withHttpTransferCacheOptions({ includePostRequests: false }),
    ),
    providePostHog(),
  ],
};
