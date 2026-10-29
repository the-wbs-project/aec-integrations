/**
 * The eager half of the Turnstile lane (AECI-1457): the only Turnstile code in
 * the initial bundle, kept to one function on purpose. `PageViewTracker` calls
 * `turnstileSiteKey()` and, only when it returns a key, `import()`s
 * `turnstile.service.ts`. A dark env (no site key) and a DNT/GPC visitor never
 * download the service chunk. The service reads the key through this same
 * function, so the two gates cannot drift.
 */

/**
 * The site key from the inline `window.__AECI_TURNSTILE__` config
 * (`turnstile-bootstrap-inject.ts`), or `null` when the config is absent or
 * malformed, or the browser sends Global Privacy Control or Do-Not-Track (ruling
 * 2026-10-28: those visitors never load the script). Pure (reads `globalThis`)
 * and platform-blind: the caller adds the browser check.
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
    nav?.doNotTrack !== '1'
    ? key
    : null;
}
