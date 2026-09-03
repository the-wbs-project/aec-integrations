/**
 * Dev-only error bench (AECI-643 / `docs/POSTHOG_MIGRATION_SPEC.md` §6.5).
 *
 * Route: `/_dev/error-bench`, registered in `app.routes.ts` behind the same
 * `ngDevMode` guard used below. Its one job is to throw a distinctive error
 * from inside an Angular event handler so the whole
 * `ErrorHandler → PosthogErrorHandler → captureException → Error Tracking`
 * chain can be verified end to end on a real build.
 *
 * A devtools-console `throw` is explicitly NOT a substitute: it lands on
 * `window.onerror`, not on Angular's `ErrorHandler`, so it exercises a
 * different code path from the one that carries real application errors.
 *
 * ## Stripping from production
 *
 * `ngDevMode` is the guard, not `isDevMode()`. `isDevMode()` is a runtime call
 * that returns `false` in prod but leaves every string it guards in the bundle;
 * `ngDevMode` is replaced with the literal `false` by the optimized Angular
 * build (`@angular/build` sets `define: { ngDevMode: 'false' }` when script
 * optimization is on), so esbuild folds the branch away and drops the message
 * with it. The `typeof` prefix keeps dev safe, where the global may not be
 * installed yet at module-eval time.
 *
 * The guard is applied twice, deliberately, so absence holds either way:
 *   1. in `app.routes.ts`, so the route (and ideally the lazy chunk) never
 *      exists in a production build; and
 *   2. around the `throw` here, so even if the chunk were emitted, the
 *      greppable message is the only place `BENCH_ERROR_MESSAGE` appears and it
 *      lives in dead code.
 *
 * Verification (§6.5): after `pnpm build`,
 * `grep -r "AECI_DEV_BENCH_THROW_9f4c2e1b" apps/web/dist/browser` must return
 * nothing.
 */
import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * `ngDevMode` has no public type declaration in `@angular/core`'s published
 * `.d.ts`, so declare it module-locally. `declare const` emits no runtime
 * binding, which is what lets the build's `define` substitution reach the bare
 * identifier.
 */
declare const ngDevMode: unknown;

/**
 * The unique, greppable marker string. Chosen so it cannot collide with
 * anything else in the tree or in a dependency; `grep` over `dist/browser`
 * proves the bench was stripped.
 */
export const BENCH_ERROR_MESSAGE =
  'AECI_DEV_BENCH_THROW_9f4c2e1b: deliberate PostHog ErrorHandler probe';

@Component({
  selector: 'aec-error-bench',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="mx-auto max-w-2xl space-y-6 px-6 py-12">
      <header class="space-y-2">
        <h1
          class="text-2xl font-semibold tracking-tight text-(--text-primary)"
          i18n="@@dev.errorBench.heading"
        >
          Error bench
        </h1>
        <p class="text-sm/6 text-(--text-secondary)" i18n="@@dev.errorBench.description">
          Development-only probe. The button below throws from inside an Angular event handler so
          the error handler and PostHog error tracking can be verified end to end. This page is
          stripped from production builds.
        </p>
      </header>

      <button
        type="button"
        (click)="throwTestError()"
        class="inline-flex cursor-pointer items-center justify-center rounded-(--radius-md)
          border border-(--border-strong) bg-(--accent-primary) px-4 py-2 text-sm font-bold
          text-(--surface-base) transition-colors hover:bg-(--accent-primary-hover)
          focus-visible:outline-2 focus-visible:outline-offset-2
          focus-visible:outline-(--accent-primary)"
        i18n="@@dev.errorBench.throw"
      >
        Throw a test error
      </button>
    </section>
  `,
})
export class ErrorBench {
  /**
   * Throws synchronously from a DOM event handler, which is the path Angular
   * routes into the injected `ErrorHandler`.
   */
  protected throwTestError(): void {
    if (typeof ngDevMode === 'undefined' || ngDevMode) {
      throw new Error(BENCH_ERROR_MESSAGE);
    }
  }
}
