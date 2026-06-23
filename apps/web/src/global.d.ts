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
import type { AlgoliaPublicConfig, PostHogPublicConfig, SupabasePublicConfig } from './env';

declare global {
  interface Window {
    __AECI_ALGOLIA__?: AlgoliaPublicConfig;
    /**
     * Public Supabase auth config (`supabase-bootstrap-inject.ts`, AECI-194).
     * Read at hydration by `app/auth/supabase-config.ts` to construct the
     * browser Supabase client. Absent in local dev without Supabase config —
     * the reader degrades gracefully on `undefined`.
     */
    __AECI_SUPABASE__?: SupabasePublicConfig;
    /**
     * Public PostHog analytics config (`posthog-bootstrap-inject.ts`, AECI-239).
     * Read at hydration by `app/analytics/posthog-config.ts` → the `Analytics`
     * service. Absent in local dev without a PostHog key — the reader degrades
     * gracefully on `undefined` and analytics never loads.
     */
    __AECI_POSTHOG__?: PostHogPublicConfig;
  }
}

export {};
