/**
 * Cloudflare Turnstile, invisible mode, as a classifier input (AECI-1457).
 *
 * Our own page-view beacon is passed by headless Chrome, so the traffic
 * classifier cannot tell a proxy-pool headless browser from a person. This
 * service mints a single-use Turnstile token that the API checks with siteverify
 * and stores as a per-view verdict (`page_views.turnstile_verdict`). It is
 * evidence only: it never blocks a page, a navigation or a beacon.
 *
 * The service is ACTIVE only when all three hold:
 *
 *   - it runs in the browser (never during SSR, so cached HTML is untouched);
 *   - the env shipped a site key (`window.__AECI_TURNSTILE__`, injected by
 *     `turnstile-bootstrap-inject.ts`). Staging and demo ship one; production
 *     has none until AECI-1458, so the feature is dark there;
 *   - the visitor sends neither Global Privacy Control nor Do-Not-Track
 *     (ruling 2026-10-28). Those visitors never load the script.
 *
 * When inactive, `getToken()` resolves `null` at once and no script loads, so
 * callers can skip the wait entirely by checking `active` first.
 *
 * `getToken(cData?)` never rejects. It lazy-loads the explicit-render script
 * once, renders an Invisible widget with `execution: 'execute'` into an
 * off-screen, `aria-hidden`, `inert` container, executes it, and resolves the
 * token from the success callback. It resolves `null` on an error, expiry,
 * challenge timeout, unsupported browser, script load failure, or after
 * `TURNSTILE_TOKEN_TIMEOUT_MS`. The widget and its container are removed
 * afterwards, because a token is single-use and a stale widget would leak DOM
 * across SPA navigations. Concurrent calls each get their own widget, which the
 * explicit-render API supports, so one slow challenge never delays another
 * beacon.
 *
 * This module is loaded lazily: `PageViewTracker` `import()`s it only when
 * `turnstileSiteKey()` (`turnstile-config.ts`) returns a key, so a dark env pays no
 * bytes for it. The service still re-checks every gate itself.
 *
 * Widget options follow Cloudflare's explicit-rendering reference
 * (`.agents/skills/cloudflare/references/turnstile/configuration.md` and
 * `api.md`). There is no visible text, so there are no i18n strings.
 */
import { DOCUMENT, isPlatformBrowser } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { type Injector, PLATFORM_ID, Service, inject } from '@angular/core';

import {
  TurnstileVerdictPostSchema,
  type PageViewPayload,
  type TurnstileVerdictPost,
} from '@aeci/shared';

import { turnstileSiteKey } from './turnstile-config';

/** The explicit-render loader. Cloudflare requires this exact URL: proxying or
 *  caching `api.js` breaks Turnstile when Cloudflare ships an update. */
export const TURNSTILE_SCRIPT_SRC =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** Upper bound on one `getToken()` call, script load included. */
export const TURNSTILE_TOKEN_TIMEOUT_MS = 8_000;

/** The subset of Turnstile's render options this service uses. */
export interface TurnstileRenderOptions {
  sitekey: string;
  cData?: string;
  execution: 'execute';
  retry: 'never';
  'refresh-expired': 'never';
  'response-field': false;
  tabindex: number;
  callback: (token: string) => void;
  'error-callback': (code: string) => boolean;
  'expired-callback': () => void;
  'timeout-callback': () => void;
  'unsupported-callback': () => void;
}

/** The subset of `window.turnstile` this service calls. */
export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileRenderOptions): string | undefined;
  execute(widget: string | HTMLElement): void;
  remove(widgetId: string): void;
}

/** The SPA beacon endpoint, the same literal `PageViewTracker` posts to. */
const SPA_BEACON_URL = '/api/page-views';

/** Landing-view verdict endpoint (AECI-1457). Proxied by the SSR Worker's
 *  `/api/*` passthrough like every other API call. */
export const TURNSTILE_VERDICT_URL = '/api/page-views/turnstile';

/** The `Server-Timing` entry name the gateway stamps (`server-runtime.ts`). */
const CF_RAY_TIMING_NAME = 'cfray';

/**
 * The page load's Ray ID from the gateway's `Server-Timing: cfray` entry
 * (AECI-1330), or `null` when it is absent (local dev, a browser without
 * `serverTiming`) or fails the shared schema's ray pattern, so no challenge is
 * spent on a ray the API would refuse.
 */
export function readLandingCfRay(): string | null {
  const entry = globalThis.performance?.getEntriesByType?.('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  const ray = entry?.serverTiming?.find((t) => t.name === CF_RAY_TIMING_NAME)?.description;
  return ray && TurnstileVerdictPostSchema.shape.cf_ray.safeParse(ray).success ? ray : null;
}

/** The landing verdict body, or `null` when the shared schema (the API's own
 *  check) would reject it, so a malformed token is never spent on a 400. */
export function landingVerdictBody(cfRay: string, token: string): TurnstileVerdictPost | null {
  const parsed = TurnstileVerdictPostSchema.safeParse({ cf_ray: cfRay, token });
  return parsed.success ? parsed.data : null;
}

@Service()
export class TurnstileService {
  private readonly document = inject(DOCUMENT);
  private readonly siteKey: string | null = isPlatformBrowser(inject(PLATFORM_ID))
    ? turnstileSiteKey()
    : null;

  /** Whether `getToken()` can ever return a token. Fixed for the app's life. */
  readonly active = this.siteKey !== null;

  /** The single script load, shared by every call. `null` until first use. */
  private api: Promise<TurnstileApi | null> | null = null;

  /**
   * Mint one single-use token. `cData` is echoed back by siteverify, which lets
   * the API bind the token to a value (the landing view's Ray ID). Never rejects.
   */
  getToken(cData?: string): Promise<string | null> {
    const siteKey = this.siteKey;
    if (siteKey === null) return Promise.resolve(null);

    return new Promise<string | null>((resolve) => {
      let settled = false;
      let turnstile: TurnstileApi | null = null;
      let widgetId: string | undefined;
      let container: HTMLElement | undefined;

      const finish = (token: string | null): void => {
        if (settled) return;
        settled = true;
        // `timer` is assigned below before any path can reach `finish`: every
        // caller is the timer itself or an async callback.
        clearTimeout(timer);
        resolve(token);
        // Remove after the callback stack unwinds, not from inside Turnstile's
        // own callback.
        setTimeout(() => {
          try {
            if (turnstile && widgetId !== undefined) turnstile.remove(widgetId);
          } catch {
            // A failed remove costs one detached widget, never the page.
          }
          container?.remove();
        }, 0);
      };

      const timer = setTimeout(() => finish(null), TURNSTILE_TOKEN_TIMEOUT_MS);

      void this.loadApi().then((api) => {
        if (settled) return;
        if (!api) {
          finish(null);
          return;
        }
        turnstile = api;
        container = this.createContainer();
        const options: TurnstileRenderOptions = {
          sitekey: siteKey,
          execution: 'execute',
          // Fail fast into the callbacks below instead of retrying past the timeout.
          retry: 'never',
          'refresh-expired': 'never',
          // No hidden form input: the token is read from the callback.
          'response-field': false,
          // The container is aria-hidden; keep the iframe out of the tab order.
          tabindex: -1,
          callback: (token) => finish(token || null),
          // Returning true marks the error handled, so Turnstile does not rethrow it.
          'error-callback': () => {
            finish(null);
            return true;
          },
          'expired-callback': () => finish(null),
          'timeout-callback': () => finish(null),
          'unsupported-callback': () => finish(null),
        };
        if (cData !== undefined) options.cData = cData;
        try {
          widgetId = api.render(container, options);
          if (widgetId === undefined) {
            finish(null);
            return;
          }
          api.execute(widgetId);
        } catch {
          finish(null);
        }
      });
    });
  }

  /**
   * Load `api.js` once. Resolves `null` if it fails to load and never rejects.
   * A failed load is remembered for the app's life: every later call resolves
   * `null` at once instead of re-adding a script a blocker already refused.
   */
  private loadApi(): Promise<TurnstileApi | null> {
    this.api ??= new Promise<TurnstileApi | null>((resolve) => {
      const win = this.document.defaultView as (Window & { turnstile?: TurnstileApi }) | null;
      if (win?.turnstile) {
        resolve(win.turnstile);
        return;
      }
      const script = this.document.createElement('script');
      script.src = TURNSTILE_SCRIPT_SRC;
      script.async = true;
      script.addEventListener('load', () => resolve(win?.turnstile ?? null), { once: true });
      script.addEventListener('error', () => resolve(null), { once: true });
      this.document.head.appendChild(script);
    });
    return this.api;
  }

  /** An off-screen host for one widget. Invisible widgets show nothing, but the
   *  challenge iframe still needs a node in the document. */
  private createContainer(): HTMLElement {
    const el = this.document.createElement('div');
    el.setAttribute('aria-hidden', 'true');
    el.setAttribute('inert', '');
    el.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden';
    this.document.body.appendChild(el);
    return el;
  }
}

/**
 * The SPA beacon with its token (AECI-1457). One token with no `cData`, because
 * the beacon itself is the row being written. An inactive service or a `null`
 * token sends the payload unchanged. `getToken` never rejects and is capped at
 * ~8 s, so the beacon always goes out, fire-and-forget like the tracker's own.
 * Called by `PageViewTracker` through its dynamic import.
 */
export async function postSpaBeacon(injector: Injector, payload: PageViewPayload): Promise<void> {
  const service = injector.get(TurnstileService);
  const token = service.active ? await service.getToken() : null;
  injector
    .get(HttpClient)
    .post(SPA_BEACON_URL, token ? { ...payload, turnstile_token: token } : payload)
    .subscribe({ error: () => undefined });
}

/**
 * The landing view's verdict (AECI-1457 / AECI-1330). Reads the page load's ray
 * from `Server-Timing`, mints a token bound to it through `cData`, and posts
 * `{ cf_ray, token }`. No ray, no token or an invalid body sends nothing.
 * Fire-and-forget: errors are swallowed and the returned promise never rejects.
 */
export async function postLandingVerdict(injector: Injector): Promise<void> {
  const service = injector.get(TurnstileService);
  if (!service.active) return;
  const cfRay = readLandingCfRay();
  if (!cfRay) return;
  const token = await service.getToken(cfRay);
  const body = token ? landingVerdictBody(cfRay, token) : null;
  if (!body) return;
  injector
    .get(HttpClient)
    .post(TURNSTILE_VERDICT_URL, body)
    .subscribe({ error: () => undefined });
}
