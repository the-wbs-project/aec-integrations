/**
 * The eager half of the Turnstile lane (AECI-1457): the only Turnstile code in
 * the initial bundle, kept to one function on purpose. `PageViewTracker` calls
 * `turnstileSiteKey()` and, only when it returns a key, `import()`s
 * `turnstile.service.ts`. A dark env (no site key), a DNT/GPC visitor and an
 * excluded region never download the service chunk. The service reads the key
 * through this same function, so the two gates cannot drift.
 */

/**
 * The site key from the inline `window.__AECI_TURNSTILE__` config
 * (`turnstile-bootstrap-inject.ts`), or `null` when the config is absent or
 * malformed, the browser sends Global Privacy Control or Do-Not-Track (ruling
 * 2026-10-28: those visitors never load the script), or the visitor's region is
 * excluded (`regionAllowsTurnstile`). Pure (reads `globalThis`) and platform-blind:
 * the caller adds the browser check.
 */
export function turnstileSiteKey(): string | null {
  const g = globalThis as {
    __AECI_TURNSTILE__?: { siteKey?: unknown } | null;
    navigator?: { globalPrivacyControl?: boolean; doNotTrack?: string | null };
  };
  const key = g.__AECI_TURNSTILE__?.siteKey;
  const nav = g.navigator;
  return typeof key === 'string' &&
    key !== '' &&
    nav?.globalPrivacyControl !== true &&
    nav?.doNotTrack !== '1' &&
    regionAllowsTurnstile()
    ? key
    : null;
}

/**
 * AECI-1581: false when the gateway stamped `Server-Timing: geo;desc="eu"` on this
 * page load (`server-runtime.ts`), until counsel rules on AECI-1458. A browser that
 * exposes no `serverTiming` cannot show us the stamp, so it fails closed: the privacy
 * policy says the check does not run in those regions. An empty list runs, because
 * that is a response with nothing stamped.
 */
function regionAllowsTurnstile(): boolean {
  const entry = globalThis.performance?.getEntriesByType?.('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  const timing = entry?.serverTiming;
  if (!Array.isArray(timing)) return false;
  return !timing.some((t) => t.name === 'geo' && t.description === 'eu');
}
