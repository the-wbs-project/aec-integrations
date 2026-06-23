/**
 * The two dimensions attached to **every** PostHog event (§14.1, AECI-239):
 * `locale` and `theme`.
 *
 * Read from the live `<html>` element — `lang` is set by the SSR Worker's
 * URL-prefix locale dispatch (`server-html-dir-inject.ts`, defaulting `en-US`),
 * and `data-theme` is the forward-compatible hook for the theme that returns
 * with the Stage-2 vendor portal. Today AECi ships a single light theme
 * (AECI-226 removed dark), so `theme` is always `'light'`; the dimension is
 * still emitted so the analytics schema is stable when dark returns.
 *
 * Pure + dependency-free so it is unit-testable directly. Falls back to the
 * shipping defaults when there is no DOM (the server / a bare Node test), though
 * the only caller (`Analytics`) is browser-gated.
 */
export interface AnalyticsDimensions {
  readonly locale: string;
  readonly theme: string;
}

export function analyticsDimensions(): AnalyticsDimensions {
  const el = globalThis.document?.documentElement;
  return {
    locale: el?.lang || 'en-US',
    theme: el?.dataset['theme'] ?? 'light',
  };
}
