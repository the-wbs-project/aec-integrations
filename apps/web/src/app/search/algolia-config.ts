/**
 * Reader for the public Algolia search config the SSR Worker inlines into the
 * HTML head as `window.__AECI_ALGOLIA__` (`apps/web/src/algolia-bootstrap-inject.ts`,
 * AECI-134). The `/search` page (AECI-142) calls this at hydration to decide
 * whether it can construct the browser-side InstantSearch client.
 *
 * Pure on purpose — reads `globalThis` and validates shape, with NO Angular
 * injection and NO platform guard, so it is unit-testable under plain Node
 * Vitest (no `window`, no TestBed). The browser-vs-server decision lives at the
 * single call site (`SearchPage`'s `afterNextRender`, which only ever runs in
 * the browser), mirroring how `datadog.provider.ts` keeps `readBootstrap()`
 * pure and guards the platform separately.
 *
 * `null` is the **graceful-degradation** signal: it means the config is absent
 * (local dev without Algolia secrets, or an env where search is not yet
 * provisioned) or malformed. The caller renders the search shell with a
 * "temporarily unavailable" notice and never constructs the controller.
 */
import type { AlgoliaPublicConfig } from '../../env';

export type { AlgoliaPublicConfig };

/**
 * Narrow an `unknown` global to a well-formed `AlgoliaPublicConfig`. Requires
 * a non-empty `appId` + `searchKey` and all three physical index names — a
 * partial/garbage global degrades to `null` rather than booting a half-wired
 * client that would throw on first query.
 */
function isValidConfig(value: unknown): value is AlgoliaPublicConfig {
  if (typeof value !== 'object' || value === null) return false;
  const cfg = value as Partial<AlgoliaPublicConfig>;
  if (typeof cfg.appId !== 'string' || cfg.appId.length === 0) return false;
  if (typeof cfg.searchKey !== 'string' || cfg.searchKey.length === 0) return false;
  const indexes = cfg.indexes;
  if (typeof indexes !== 'object' || indexes === null) return false;
  return (
    typeof indexes.products === 'string' &&
    typeof indexes.vendors === 'string' &&
    typeof indexes.integrations === 'string'
  );
}

/**
 * Returns the validated public Algolia config, or `null` when it is absent or
 * malformed. Reads `globalThis.__AECI_ALGOLIA__` (the same value SSR injects as
 * `window.__AECI_ALGOLIA__`) so the function works in both the browser and a
 * bare Node test process.
 */
export function readAlgoliaConfig(): AlgoliaPublicConfig | null {
  const raw = (globalThis as { __AECI_ALGOLIA__?: unknown }).__AECI_ALGOLIA__;
  return isValidConfig(raw) ? raw : null;
}
