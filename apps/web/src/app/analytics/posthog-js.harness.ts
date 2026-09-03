/**
 * The shared `posthog-js` module mock (AECI-643).
 *
 * Every analytics spec declares
 *
 * ```ts
 * NOTE the specifier: `posthog-client.ts` imports the self-contained
 * `no-external` bundle (see the decision block there), and `vi.mock` keys on
 * the literal module specifier — it must match the specifier the code under
 * test actually imports, not the package name. A mismatch does not error; it
 * silently loads the real 500 kB SDK and the config assertions fail with
 * `expected undefined to be …`.
 *
 * vi.mock('posthog-js/dist/module.full.no-external', async () => {
 *   const { posthogJsModuleMock } = await import('./posthog-js.harness');
 *   return posthogJsModuleMock();
 * });
 * ```
 *
 * so no spec ever loads the real SDK — importing it would touch `window` at
 * module scope, pull ~200 kB into the test graph, and (worse) let a config
 * regression pass unnoticed because the real `init` silently accepts anything.
 *
 * NOTE — a truly *global* mock would live in a setup file, but wiring one into
 * the `ng test` runner needs a `setupFiles` entry on the `test` target in
 * `apps/web/angular.json`. Until that lands, the `vi.mock` above is declared
 * per spec (it is hoisted, so it must be in the spec file anyway) and this
 * module is the single source of the fake.
 *
 * `*.harness.ts` is excluded from `tsconfig.app.json`, so importing `vitest`
 * here can never reach the application build graph.
 */
import { vi } from 'vitest';

/** The structural fake standing in for the real `posthog` singleton. */
export interface PostHogJsFake {
  init: ReturnType<typeof vi.fn>;
  capture: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  set_config: ReturnType<typeof vi.fn>;
  captureException: ReturnType<typeof vi.fn>;
  historyAutocapture: { startIfEnabled: ReturnType<typeof vi.fn> };
  /** Identity (AECI-649 / `docs/ANALYTICS.md` §8). */
  identify: ReturnType<typeof vi.fn>;
  group: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
}

/**
 * The singleton the mocked module hands back. Stable across `import()` calls
 * within a spec file, so a test can assert on `init` after the code under test
 * has already resolved the module.
 */
export const posthogJsFake: PostHogJsFake = {
  init: vi.fn(),
  capture: vi.fn(),
  register: vi.fn(),
  set_config: vi.fn(),
  captureException: vi.fn(),
  historyAutocapture: { startIfEnabled: vi.fn() },
  identify: vi.fn(),
  group: vi.fn(),
  reset: vi.fn(),
};

/** The `vi.mock` factory return: an ES module whose default export is the fake. */
export function posthogJsModuleMock(): { default: PostHogJsFake } {
  return { default: posthogJsFake };
}

/** Clear every recorded call. Call from `beforeEach`. */
export function resetPosthogJsFake(): void {
  posthogJsFake.init.mockReset();
  posthogJsFake.capture.mockReset();
  posthogJsFake.register.mockReset();
  posthogJsFake.set_config.mockReset();
  posthogJsFake.captureException.mockReset();
  posthogJsFake.historyAutocapture.startIfEnabled.mockReset();
  posthogJsFake.identify.mockReset();
  posthogJsFake.group.mockReset();
  posthogJsFake.reset.mockReset();
}

/** The options object recorded by the most recent `posthog.init(...)` call. */
export function lastInitConfig(): Record<string, unknown> {
  const calls = posthogJsFake.init.mock.calls;
  const last = calls[calls.length - 1];
  return (last?.[1] ?? {}) as Record<string, unknown>;
}
