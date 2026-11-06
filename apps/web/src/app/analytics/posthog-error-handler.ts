/**
 * Angular `ErrorHandler` → PostHog `captureException` (AECI-643 /
 * `docs/POSTHOG_MIGRATION_SPEC.md` §3.3, Tier 2).
 *
 * **Why this exists at all.** `capture_exceptions: true` wires PostHog into
 * `window.onerror` / `unhandledrejection`. Angular never lets application
 * errors reach either: everything thrown inside a template, a lifecycle hook,
 * an event handler, a resolver, or a subscription is funnelled into the
 * injected `ErrorHandler` and logged there. So `capture_exceptions` on its own
 * reports almost no *application* errors — this handler is the load-bearing
 * path, and the spec says so explicitly.
 *
 * **`console.error` is kept.** Angular's default handler logs; replacing it
 * without logging would silently delete the developer-visible signal in dev and
 * in the browser console in prod. Report AND log.
 *
 * **Never throws.** An error reporter that throws turns one bug into two, and
 * an `ErrorHandler` that throws inside `handleError` can take the change
 * detection loop with it. Both legs are individually try/caught.
 *
 * **SSR-safe.** No `window` at module scope, and no eager DI: `Analytics` is
 * resolved lazily from the `Injector` on first error, so registering this
 * handler cannot pull the analytics graph (and its `Router` dependency) into
 * bootstrap ordering. `Analytics.captureException` is itself browser-gated, so
 * an SSR-side error logs and no-ops rather than reaching for the SDK.
 *
 * Registered in `app.config.ts`. Note this deliberately reports on the Tier 2
 * (operational) plane, which is NOT consent-gated — see `analytics.ts`.
 */
import { ErrorHandler, Injectable, Injector, inject } from '@angular/core';

import { AppUpdateService } from '../core/app-update/app-update.service';
import { isChunkLoadError } from '../core/app-update/chunk-load-error';

import { Analytics } from './analytics';

// `providedIn: 'root'` satisfies `@angular-eslint/use-injectable-provided-in`
// and lets `app.config.ts` bind it with `useExisting`, so exactly ONE instance
// exists rather than a root-provided one plus a second under the token.
@Injectable({ providedIn: 'root' })
export class PosthogErrorHandler implements ErrorHandler {
  private readonly injector = inject(Injector);

  handleError(error: unknown): void {
    try {
      console.error(error);
    } catch {
      // A console shim can throw (very old embedded webviews). Keep going.
    }
    // A masked cross-origin script error carries no message, file or stack, so
    // PostHog groups every one into one issue nobody can act on. Log it, skip it.
    if (isMaskedCrossOriginError(error)) return;
    try {
      this.injector.get(Analytics).captureException(error);
    } catch {
      // Reporting must never escalate. Swallow.
    }
    // A failed lazy chunk (a `@defer` block's NG0750, most often) may mean a
    // deploy replaced this tab's build. Ask; the update banner shows if so
    // (AECI-1493). Still reported above, so PostHog keeps the signal.
    if (isChunkLoadError(error)) {
      try {
        void this.injector.get(AppUpdateService).check();
      } catch {
        // Same rule: never escalate.
      }
    }
  }
}

/**
 * True for the browser's masked "Script error.".
 *
 * A browser hides the detail of an error thrown by a script from another origin
 * that was loaded without CORS. `window.onerror` then gets an `ErrorEvent` whose
 * message is "Script error.", with no `error`, no `filename` and line 0.
 * Angular's global listener wraps that in `new Error(e.message, { cause: e })`.
 * Our only cross-origin script is Cloudflare Turnstile's `api.js`. Browser
 * extensions and Brave's injected shields scripts produce the same event. The
 * report holds nothing to fix, so it is dropped. The match needs the empty
 * `filename` too, so a same-origin error that happens to say "Script error."
 * still reports.
 *
 * This covers only the `ErrorHandler` path. PostHog's own `window.onerror`
 * wrapper reports the same event separately. `dropMaskedScriptError` in
 * `posthog-exception-filter.ts` drops that copy in `before_send`.
 */
export function isMaskedCrossOriginError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const cause = (error as { cause?: unknown }).cause;
  if (typeof cause !== 'object' || cause === null) return false;
  const event = cause as { message?: unknown; filename?: unknown; error?: unknown };
  return (
    typeof event.message === 'string' &&
    event.message.startsWith('Script error') &&
    !event.filename &&
    event.error == null
  );
}
