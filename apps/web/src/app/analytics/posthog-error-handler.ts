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
    try {
      this.injector.get(Analytics).captureException(error);
    } catch {
      // Reporting must never escalate. Swallow.
    }
  }
}
