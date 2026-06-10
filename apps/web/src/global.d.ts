/**
 * Ambient global augmentations for the SSR Worker's browser runtime.
 *
 * `window.__AECI_ALGOLIA__` is the public Algolia search config the SSR Worker
 * inlines into the HTML head (`algolia-bootstrap-inject.ts`). The `/search`
 * adapter (`app/search/algolia-config.ts`, AECI-142) reads it at hydration to
 * construct the browser-side InstantSearch client. It is absent in local dev
 * without Algolia secrets and in any env where search is not yet provisioned —
 * hence optional; the reader degrades gracefully on `undefined`.
 *
 * Covered by `tsconfig.app.json`'s `src` glob include. `export {}` keeps this a
 * module so the `declare global` augments rather than redeclares.
 */
import type { AlgoliaPublicConfig } from './env';

declare global {
  interface Window {
    __AECI_ALGOLIA__?: AlgoliaPublicConfig;
  }
}

export {};
