/**
 * Notices when a deploy has made this tab stale, and recovers (AECI-1493).
 *
 * A deploy replaces every hashed JS chunk, and Workers static assets keep only
 * the current set. A tab opened before the deploy still names the old chunks,
 * so its next lazy route or `@defer` block 404s. Before this service the visitor
 * was stuck until they reloaded by hand.
 *
 * How it knows. The SSR Worker stamps each page with the build that rendered it
 * (`<meta name="aeci-build">`, `src/build-stamp-inject.ts`). This service
 * compares that stamp with `GET /_version`, which reports the build deployed
 * now. A difference sets `updateAvailable`. It checks:
 *   - when the tab becomes visible again, at most once a minute;
 *   - every 15 minutes while the tab is visible;
 *   - when a chunk load fails (`PosthogErrorHandler` calls `check()`).
 * It stops checking once an update is found. A missing stamp or an `unknown`
 * SHA (local dev without `COMMIT_SHA`) turns every check off.
 *
 * How it recovers.
 *   - Once `updateAvailable` is set, the next in-app navigation becomes a full
 *     page load, so most visitors pick up the new build on their next click.
 *     A navigation that keeps the path is left alone: the section-nav links
 *     change only the fragment, and search, filters, sort and paging change
 *     only the query string, often on a debounce while the visitor types.
 *   - A navigation whose chunk fails runs a check first, and reloads to its
 *     target only when a new build is confirmed (`reloadOnChunkLoadError`,
 *     registered in `app.config.ts`). That check is also the loop guard: the
 *     reloaded page carries the new stamp, so if its own chunks fail the builds
 *     match and nothing reloads again. No browser storage is involved.
 *   - `UpdateBanner` offers a Refresh button for a visitor who stays put.
 *
 * Browser-only. `start()` is a no-op on the server, and nothing here changes the
 * SSR output, so cached HTML stays visitor-neutral.
 */
import { DOCUMENT, Location, isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { DestroyRef, Injectable, InjectionToken, PLATFORM_ID, inject, signal } from '@angular/core';
import { NavigationError, NavigationStart, Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { VersionResponse } from '@aeci/shared';

import { isChunkLoadError } from './chunk-load-error';

/** Mirrors `BUILD_STAMP_META_NAME` in `src/build-stamp-inject.ts`. */
export const BUILD_STAMP_META_NAME = 'aeci-build';
export const VERSION_URL = '/_version';
export const CHECK_INTERVAL_MS = 15 * 60_000;
export const MIN_CHECK_GAP_MS = 60_000;

/** The sentinel `/_version` returns when `COMMIT_SHA` was never injected. */
const UNKNOWN_SHA = 'unknown';

/** Full-document loads, behind a token so tests never navigate the runner. */
export interface PageLoader {
  assign(href: string): void;
  reload(): void;
}

export const PAGE_LOADER = new InjectionToken<PageLoader>('PAGE_LOADER', {
  providedIn: 'root',
  factory: () => {
    const location = inject(DOCUMENT).defaultView?.location;
    return {
      assign: (href) => location?.assign(href),
      reload: () => location?.reload(),
    };
  },
});

function readBuildStamp(document: Document): string | null {
  const content = document
    .querySelector(`meta[name="${BUILD_STAMP_META_NAME}"]`)
    ?.getAttribute('content');
  return content && content !== UNKNOWN_SHA ? content : null;
}

/**
 * The URL's path, without its `?query` or `#fragment`. A navigation that keeps
 * the path stays on the same route and loads no new chunk.
 */
function pathOf(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

@Injectable({ providedIn: 'root' })
export class AppUpdateService {
  private readonly http = inject(HttpClient);
  private readonly document = inject(DOCUMENT);
  private readonly router = inject(Router);
  private readonly location = inject(Location);
  private readonly pageLoader = inject(PAGE_LOADER);
  private readonly destroyRef = inject(DestroyRef);
  private readonly isBrowser = isPlatformBrowser(inject(PLATFORM_ID));

  /** True once `/_version` reports a build other than this page's. */
  readonly updateAvailable = signal(false);

  private build: string | null = null;
  private started = false;
  private lastCheckAt = Number.NEGATIVE_INFINITY;
  private inFlight: Promise<void> | null = null;

  /** Reads the stamp and starts the checks. Idempotent; no-op on the server. */
  start(): void {
    if (this.started || !this.isBrowser) return;
    this.started = true;
    this.build = readBuildStamp(this.document);
    if (!this.build) return;

    const onVisibilityChange = () => {
      if (this.document.visibilityState === 'visible') void this.check({ throttle: true });
    };
    this.document.addEventListener('visibilitychange', onVisibilityChange);
    const timer = setInterval(() => {
      if (this.document.visibilityState === 'visible') void this.check({ throttle: true });
    }, CHECK_INTERVAL_MS);
    const subscription = this.router.events.subscribe((event) => {
      if (event instanceof NavigationStart) this.onNavigationStart(event);
    });

    this.destroyRef.onDestroy(() => {
      this.document.removeEventListener('visibilitychange', onVisibilityChange);
      clearInterval(timer);
      subscription.unsubscribe();
    });
  }

  /**
   * Asks `/_version` which build is deployed. `throttle` skips the call when the
   * last one was under a minute ago. Never rejects: a failed check changes
   * nothing and the next trigger tries again.
   */
  check(options: { throttle?: boolean } = {}): Promise<void> {
    if (!this.isBrowser || this.updateAvailable()) return Promise.resolve();
    this.build ??= readBuildStamp(this.document);
    if (!this.build) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const now = Date.now();
    if (options.throttle && now - this.lastCheckAt < MIN_CHECK_GAP_MS) return Promise.resolve();
    this.lastCheckAt = now;

    const build = this.build;
    this.inFlight = firstValueFrom(this.http.get<Partial<VersionResponse>>(VERSION_URL))
      .then((body) => {
        const deployed = typeof body?.sha === 'string' ? body.sha : null;
        if (deployed && deployed !== UNKNOWN_SHA && deployed !== build) {
          this.updateAvailable.set(true);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Full-page load to an app URL. No-op on the server. */
  reloadTo(url: string): void {
    if (!this.isBrowser) return;
    this.pageLoader.assign(this.location.prepareExternalUrl(url));
  }

  /**
   * A navigation failed on a missing chunk. Reload to its target only when
   * `/_version` confirms a new build. A failure with the same build (an aborted
   * fetch, a frozen tab) leaves the navigation failed, as before, because a
   * reload would not fetch anything different and could loop.
   */
  async recoverNavigation(url: string): Promise<void> {
    await this.check();
    if (this.updateAvailable()) this.reloadTo(url);
  }

  /** The banner's Refresh button. */
  reload(): void {
    this.pageLoader.reload();
  }

  private onNavigationStart(event: NavigationStart): void {
    if (!this.updateAvailable()) return;
    if (pathOf(event.url) === pathOf(this.router.url)) return;
    this.reloadTo(event.url);
  }
}

/**
 * `withNavigationErrorHandler` callback (`app.config.ts`). A navigation whose
 * lazy chunk failed becomes a full load of its target once a new build is
 * confirmed, which fetches that build's HTML and chunks. Runs in the injection
 * context.
 */
export function reloadOnChunkLoadError(error: NavigationError): void {
  if (!isChunkLoadError(error.error)) return;
  void inject(AppUpdateService).recoverNavigation(error.url);
}
