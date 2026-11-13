/**
 * The eager half of the Turnstile lane (AECI-1457): the only Turnstile code in
 * the initial bundle, kept to one function on purpose. `PageViewTracker` calls
 * `turnstileSiteKey()` and, only when it returns a key, `import()`s
 * `turnstile.service.ts`. A dark env (no site key), a DNT/GPC visitor and an
 * excluded region never download the service chunk. The service reads the key
 * through this same function, so the two gates cannot drift.
 *
 * The privacy-signal and region checks are exported because the browser report
 * (`browser-evidence-config.ts`, AECI-1714) applies the same two holds. One
 * function owns each rule, so the Turnstile hold and the report hold cannot drift.
 */

/**
 * The site key from the inline `window.__AECI_TURNSTILE__` config
 * (`turnstile-bootstrap-inject.ts`), or `null` when the config is absent or
 * malformed, the browser sends Global Privacy Control or Do-Not-Track (ruling
 * 2026-10-28: those visitors never load the script), or the visitor's region is
 * excluded (`regionAllowsCollection`). Pure (reads `globalThis`) and platform-blind:
 * the caller adds the browser check.
 */
export function turnstileSiteKey(): string | null {
  const g = globalThis as {
    __AECI_TURNSTILE__?: { siteKey?: unknown } | null;
  };
  const key = g.__AECI_TURNSTILE__?.siteKey;
  return typeof key === 'string' &&
    key !== '' &&
    !browserSendsPrivacySignal() &&
    regionAllowsCollection()
    ? key
    : null;
}

/**
 * True when the browser sends Global Privacy Control (`navigator.globalPrivacyControl
 * === true`) or Do-Not-Track (`navigator.doNotTrack === '1'`). Neither Turnstile nor
 * the browser report runs for that visitor (ruling 2026-10-28, ruling 21).
 */
export function browserSendsPrivacySignal(): boolean {
  const nav = (
    globalThis as {
      navigator?: { globalPrivacyControl?: boolean; doNotTrack?: string | null };
    }
  ).navigator;
  return nav?.globalPrivacyControl === true || nav?.doNotTrack === '1';
}

/**
 * AECI-1581 and ruling 21: false when the gateway stamped `Server-Timing:
 * geo;desc="eu"` on this page load (`server-runtime.ts`). Turnstile is held there
 * until counsel rules on AECI-1458. The browser report (AECI-1714) is held there for
 * good. A browser that exposes no `serverTiming` cannot show us the stamp, so it fails
 * closed: the privacy policy says neither runs in those regions. An empty list runs,
 * because that is a response with nothing stamped.
 */
export function regionAllowsCollection(): boolean {
  const entry = globalThis.performance?.getEntriesByType?.('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;
  const timing = entry?.serverTiming;
  if (!Array.isArray(timing)) return false;
  return !timing.some((t) => t.name === 'geo' && t.description === 'eu');
}
