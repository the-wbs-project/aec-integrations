/**
 * Reader for the public Supabase auth config the SSR Worker inlines into the
 * HTML head as `window.__AECI_SUPABASE__` (`apps/web/src/supabase-bootstrap-inject.ts`,
 * AECI-194). The login page calls this (via `AuthService`) at hydration to
 * decide whether it can construct the browser-side Supabase client.
 *
 * Pure on purpose — reads `globalThis` and validates shape, with NO Angular
 * injection and NO platform guard, so it is unit-testable under plain Node
 * Vitest (no `window`, no TestBed). The browser-vs-server decision lives at
 * the call site (`LoginPage`'s `afterNextRender`, which only ever runs in the
 * browser), mirroring `app/search/algolia-config.ts`.
 *
 * `null` is the **graceful-degradation** signal: it means the config is absent
 * (local dev without Supabase config, or an env where auth is not yet
 * provisioned) or malformed. The caller renders the login shell with a
 * "temporarily unavailable" notice and never constructs the client.
 */
import type { SupabasePublicConfig } from '../../env';

export type { SupabasePublicConfig };

/**
 * Narrow an `unknown` global to a well-formed `SupabasePublicConfig`. Requires
 * a non-empty `url` + `anonKey` — a partial/garbage global degrades to `null`
 * rather than booting a half-wired client that would throw on first call.
 */
function isValidConfig(value: unknown): value is SupabasePublicConfig {
  if (typeof value !== 'object' || value === null) return false;
  const cfg = value as Partial<SupabasePublicConfig>;
  if (typeof cfg.url !== 'string' || cfg.url.length === 0) return false;
  return typeof cfg.anonKey === 'string' && cfg.anonKey.length > 0;
}

/**
 * Returns the validated public Supabase config, or `null` when it is absent or
 * malformed. Reads `globalThis.__AECI_SUPABASE__` (the same value SSR injects
 * as `window.__AECI_SUPABASE__`) so the function works in both the browser and
 * a bare Node test process.
 */
export function readSupabaseConfig(): SupabasePublicConfig | null {
  const raw = (globalThis as { __AECI_SUPABASE__?: unknown }).__AECI_SUPABASE__;
  return isValidConfig(raw) ? raw : null;
}
