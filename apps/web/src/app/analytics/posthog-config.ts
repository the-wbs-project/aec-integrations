/**
 * Reader for the public PostHog config the SSR Worker inlines into the HTML
 * head as `window.__AECI_POSTHOG__` (`apps/web/src/posthog-bootstrap-inject.ts`,
 * AECI-239 / §14.1). The `Analytics` service reads this at hydration to decide
 * whether it can construct the browser-side PostHog client.
 *
 * Pure on purpose — reads `globalThis` and validates shape, with NO Angular
 * injection and NO platform guard, so it is unit-testable under plain Node
 * Vitest (no `window`, no TestBed). The browser-vs-server and consent decisions
 * live at the call site (`Analytics`), mirroring how `algolia-config.ts` /
 * the bootstrap readers keep the reader pure and guard the platform separately.
 *
 * `null` is the **graceful-degradation** signal: it means the config is absent
 * (local dev without a PostHog key, or an env where analytics is not yet
 * provisioned) or malformed. The caller never loads PostHog — analytics no-ops.
 */
import type { PostHogPublicConfig } from '../../env';

export type { PostHogPublicConfig };

/**
 * Narrow an `unknown` global to a well-formed `PostHogPublicConfig`. Requires a
 * non-empty `key` + `host` — a partial/garbage global degrades to `null` rather
 * than booting a half-wired client that would throw on first capture.
 */
function isValidConfig(value: unknown): value is PostHogPublicConfig {
  if (typeof value !== 'object' || value === null) return false;
  const cfg = value as Partial<PostHogPublicConfig>;
  if (typeof cfg.key !== 'string' || cfg.key.length === 0) return false;
  if (typeof cfg.host !== 'string' || cfg.host.length === 0) return false;
  return true;
}

/**
 * Returns the validated public PostHog config, or `null` when it is absent or
 * malformed. Reads `globalThis.__AECI_POSTHOG__` (the same value SSR injects as
 * `window.__AECI_POSTHOG__`) so the function works in both the browser and a
 * bare Node test process.
 */
export function readPostHogConfig(): PostHogPublicConfig | null {
  const raw = (globalThis as { __AECI_POSTHOG__?: unknown }).__AECI_POSTHOG__;
  return isValidConfig(raw) ? raw : null;
}
